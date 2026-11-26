#!/usr/bin/env bash
# R-048 验收 12 / R-049：手机号、证件号、非示例邮箱的判定，规则只有这一份。
#
# 被 scripts/dev/ci-mirror.sh source（导出树守门），也可以直接执行扫整棵工作树：
#   sensitive-scan.sh [工作树根目录]     缺省是脚本所在的仓库根
# 工作树入口查 git ls-files -co --exclude-standard 的全部文件，内容与路径都查，
# 二进制交给 grep -I 跳过；命中即失败，逐条输出「路径:行号:命中内容」。

set -euo pipefail

# ---------------------------------------------------------------------------
# 例外名单（只有这一份）
# ---------------------------------------------------------------------------

# 按「命中内容」精确放行。每一项上面一句理由；只放编造数据、上游默认值和脚本
# 自己的署名。看着像真实信息的不要登记，停下来报告。
# 数字另按归一化值（全角折半、去 + - 空格、大写）再比一次，共用一条。
SENSITIVE_ALLOWLIST=(
  # 两个客户端测试夹具里编造的手机号样本，验证收件地址脱敏逻辑，不是客户信息。
  13812345678
  # NocoBase 上游默认管理员邮箱，出现在示例配置与 E2E 默认值里，不是客户信息。
  admin@nocobase.com
  # 脚本自己的中性提交署名，GitHub noreply 地址，不是真实邮箱。
  ci-mirror@users.noreply.github.com
  # ${CI_MIRROR_AUTHOR_EMAIL:-默认值} 的连字符被并进本地部分造成的假阳性；按精确内容放行，不改解析以免动导出树行为。
  -ci-mirror@users.noreply.github.com
  # 同一客户端夹具里编造号的 +86 写法（拨号失败与拉起通知两处），仍是编造数据。
  +8613812345678
  # 同一夹具里编造号的 86 前缀写法（物流跟踪链接），仍是编造数据。
  8613812345678
  # 同一夹具里编造号的 0086 前缀写法（另一条拨号样本），仍是编造数据。
  008613812345678
  # raw 页面文本把 Super Admin 与默认邮箱连写造成的假阳性，两处都是拼接，不是真实地址。
  Adminadmin@nocobase.com
  # 守门测试故意用非示例域验证大小写不敏感；张三占位名是编造数据，不能改成示例域。
  Zhang.San@163.COM
)

# 按路径放行，路径可带行号（「路径:行号」），用于不能改写的历史材料。
# 只作用于这里登记的路径或那一行；同一命中出现在别处照样拦。每一项上面一句理由。
SENSITIVE_PATH_ALLOWLIST=(
  # 调研笔记里转录的 git 作者字段，疑似项目所有者本人的提交邮箱，2026-11-26 起待用户裁决；不抄原文。
  raw/项目决策/2026-11-25-调研-调度工作台的数据源与载体.md:68
)

# 交接里被复述的那一个字面量在代码里拼出来，脚本自身不出现它。
HANDOFF_SAMPLE='138-0000-'"0000"

# 路径 + 命中内容放行：只对登记文件里的那一个具体命中生效，行号变化不影响。
# 写法：路径|命中内容（内容在代码里拼，脚本本身不写可被拦下的字面量）。
SENSITIVE_PATH_TEXT_ALLOWLIST=(
  # 交接变更记录复述了同步被拦事故的样本原文；条目会轮转换文件与行号，只对这两个文件里的这一个字面量放行。
  "HANDOFF.md|$HANDOFF_SAMPLE"
  # 同上，变更记录超过 16 条时轮转进归档文件。
  "HANDOFF/changelog-archive.md|$HANDOFF_SAMPLE"
)

# 示例域及其子域不算命中；大小写不敏感。
# 回环地址是本机/示例用途，不是真实收件域；其它 IP 字面量照拦。
EXAMPLE_DOMAINS=(example.com example.org example.net example invalid test localhost 127.0.0.1)

# 数字串候选：首尾是数字（证件号末位可为 X），中间只含数字、空格、短横，前面可有 +；
# 全角数字、全角加号/短横/空格也算候选。命中后才折半并去分隔符判长度，
# 输出始终是这里的原文，不写归一化后的串。
SEPARATED_NUMBER_RE='(?<![0-9０-９])(?=(?:[^0-9０-９]*[0-9０-９]){11})(?:\(|（)?(?:\+|＋)?[0-9０-９][0-9０-９+＋\-－ 　\.．。｡·()（）]*[0-9０-９XxＸ](?![0-9０-９])'
# 要求点号加字母顶级域，免得把 node@24、pnpm@11.11.0、upload-artifact@v4 当成邮箱。
EMAIL_RE='(?<![A-Za-z0-9])[A-Za-z0-9._%+-]+(?:@|\\[uU]0040)(?:\[?[0-9]{1,3}(?:\.[0-9]{1,3}){3}\]?|[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})(?![A-Za-z0-9])'

allowlisted() {
  local value="$1" item
  for item in "${SENSITIVE_ALLOWLIST[@]}"; do
    if [ "$value" = "$item" ]; then
      return 0
    fi
    if is_email_value "$value" && is_email_value "$item" && [ "${value,,}" = "${item,,}" ]; then
      return 0
    fi
  done
  return 1
}

# 邮箱本地部分可能是 JSON 转义的 @，判定前按邮箱处理。
is_email_value() {
  local value="$1"
  [[ "$value" == *@* || "$value" == *'\u0040'* || "$value" == *'\U0040'* ]]
}

# 位置（路径或「路径:行号」）精确匹配；路径名命中用它。
path_allowlisted() {
  local location="$1" item
  for item in "${SENSITIVE_PATH_ALLOWLIST[@]}"; do
    if [ "$location" = "$item" ]; then
      return 0
    fi
  done
  return 1
}

# 内容命中「路径:行号:命中内容」按前缀匹配，路径可带行号也可不带。
hit_path_allowlisted() {
  local hit="$1" item
  for item in "${SENSITIVE_PATH_ALLOWLIST[@]}"; do
    case "$hit" in
      "$item":*) return 0 ;;
    esac
  done
  return 1
}

# 命中行「路径:行号:命中内容」只对登记文件里的那一个内容放行，与行号无关。
hit_path_text_allowlisted() {
  local hit="$1" rest path content entry allowed_path allowed_value
  content="${hit##*:}"
  rest="${hit%:*}"
  path="${rest%:*}"
  for entry in "${SENSITIVE_PATH_TEXT_ALLOWLIST[@]}"; do
    allowed_path="${entry%%|*}"
    allowed_value="${entry#*|}"
    if [ "$path" = "$allowed_path" ] && [ "$content" = "$allowed_value" ]; then
      return 0
    fi
  done
  return 1
}

email_domain() {
  local value="$1"
  value="${value//'\u0040'/@}"
  value="${value//'\U0040'/@}"
  value="${value#*@}"
  value="${value#'['}"
  value="${value%']'}"
  printf '%s' "$value"
}

example_domain() {
  local domain="${1,,}" ex
  for ex in "${EXAMPLE_DOMAINS[@]}"; do
    if [ "$domain" = "$ex" ] || [[ "$domain" == *".$ex" ]]; then
      return 0
    fi
  done
  return 1
}

# GB 11643：前 17 位乘固定权重，和对 11 取模后查校验码表，与第 18 位比对。
valid_id_checksum() {
  local id="$1" i digit sum=0 last expected
  local -a weights=(7 9 10 5 8 4 2 1 6 3 7 9 10 5 8 4 2)
  local codes='10X98765432'
  last="${id:17:1}"
  last="${last^^}"
  for i in "${!weights[@]}"; do
    digit="${id:$i:1}"
    sum=$((sum + 10#$digit * weights[i]))
  done
  expected="${codes:sum%11:1}"
  [ "$last" = "$expected" ]
}

# 只用于比对：全角折半、去掉分隔符与加号、统一大小写；输出永不经过这里。
normalize_number() {
  local value="$1" fw='０１２３４５６７８９' hw='0123456789' i
  for i in {0..9}; do
    value="${value//${fw:$i:1}/${hw:$i:1}}"
  done
  value="${value//＋/+}"
  value="${value//－/-}"
  value="${value//　/ }"
  value="${value//+/}"
  value="${value// /}"
  value="${value//-/}"
  value="${value//'．'/.}"
  value="${value//'。'/.}"
  value="${value//'｡'/.}"
  value="${value//'·'/.}"
  value="${value//'.'/}"
  value="${value//'('/}"
  value="${value//')'/}"
  value="${value//'（'/}"
  value="${value//'）'/}"
  printf '%s' "${value^^}"
}

# 归一化只会折叠字符，数字个数不会变；先数一遍，避免给每个日期串跑十轮折半。
number_shape_ok() {
  local value="$1" digits_only
  digits_only="${value//[!0-9０-９]/}"
  # 手机 11 位（带 86 前缀 13 位、0086 前缀 15 位），证件 18 位（末位 X 时 17 位数字）。
  case ${#digits_only} in
    11|13|15|17|18) return 0 ;;
  esac
  return 1
}

# 11 位 1[3-9] 开头，或前面带 86 / +86 / 0086 前缀的同一个号；其余长度一律不算。
phone_number() {
  local digits="$1" rest
  if [[ "$digits" =~ ^1[3-9][0-9]{9}$ ]]; then
    return 0
  fi
  rest="${digits#86}"
  if [ "${digits:0:2}" = "86" ] && [[ "$rest" =~ ^1[3-9][0-9]{9}$ ]]; then
    return 0
  fi
  rest="${digits#0086}"
  if [ "${digits:0:4}" = "0086" ] && [[ "$rest" =~ ^1[3-9][0-9]{9}$ ]]; then
    return 0
  fi
  return 1
}

# 18 位（末位可为 X）且过 GB 11643 校验位，避免把锁文件长串误报成证件号。
id_number() {
  local digits="$1"
  if [[ "$digits" =~ ^[0-9]{17}[0-9X]$ ]] && valid_id_checksum "$digits"; then
    return 0
  fi
  return 1
}

# 一个命中片段（内容或路径里的）是不是真的敏感：邮箱看域，数字看归一化后的判定。
sensitive_match() {
  local value="$1" digits domain
  if is_email_value "$value"; then
    domain="$(email_domain "$value")"
    if example_domain "$domain"; then
      return 1
    fi
    return 0
  fi
  number_shape_ok "$value" || return 1
  digits="$(normalize_number "$value")"
  if phone_number "$digits" || id_number "$digits"; then
    return 0
  fi
  return 1
}

# 从 grep 的「文件:行号:命中内容」行里取出命中内容，过掉例外名单。
unlisted_hits() {
  local lines="$1" line value
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    value="${line##*:}"
    if ! allowlisted "$value"; then
      printf '%s\n' "$line"
    fi
  done <<< "$lines"
}

# 数字类例外按归一化后的值也比对一次：同一份编造样本换分隔写法不算新命中。
unlisted_number_hits() {
  local lines="$1" line value digits
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    value="${line##*:}"
    number_shape_ok "$value" || continue
    digits="$(normalize_number "$value")"
    if allowlisted "$value" || allowlisted "$digits"; then
      continue
    fi
    printf '%s\n' "$line"
  done <<< "$lines"
}

# 按路径放行：命中行「路径:行号:命中内容」落在登记的路径或行上时过滤掉。
unlisted_path_hits() {
  local lines="$1" line
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    if ! hit_path_allowlisted "$line" && ! hit_path_text_allowlisted "$line"; then
      printf '%s\n' "$line"
    fi
  done <<< "$lines"
}

matched_phones() {
  local lines="$1" line value digits
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    value="${line##*:}"
    number_shape_ok "$value" || continue
    digits="$(normalize_number "$value")"
    if phone_number "$digits"; then
      printf '%s\n' "$line"
    fi
  done <<< "$lines"
}

matched_ids() {
  local lines="$1" line value digits
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    value="${line##*:}"
    number_shape_ok "$value" || continue
    digits="$(normalize_number "$value")"
    if id_number "$digits"; then
      printf '%s\n' "$line"
    fi
  done <<< "$lines"
}

external_emails() {
  local lines="$1" line value domain
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    value="${line##*:}"
    domain="$(email_domain "$value")"
    if example_domain "$domain"; then
      continue
    fi
    printf '%s\n' "$line"
  done <<< "$lines"
}

# 单个路径是否命中（供导出树守门用），判定与名单都来自上面那一份。
path_sensitive() {
  local rel="$1" matches m digits
  matches="$(printf '%s' "$rel" | grep -oP "$SEPARATED_NUMBER_RE" 2>/dev/null || true)"
  matches+=$'\n'"$(printf '%s' "$rel" | grep -oP "$EMAIL_RE" 2>/dev/null || true)"
  while IFS= read -r m; do
    [ -n "$m" ] || continue
    sensitive_match "$m" || continue
    if is_email_value "$m"; then
      if ! allowlisted "$m" && ! path_allowlisted "$rel"; then
        return 0
      fi
    else
      digits="$(normalize_number "$m")"
      if ! allowlisted "$m" && ! allowlisted "$digits" && ! path_allowlisted "$rel"; then
        return 0
      fi
    fi
  done <<< "$matches"
  return 1
}

# 工作树入口：受跟踪 + 未跟踪未忽略的文件，内容与路径都查。
scan_worktree() {
  local root="${1:-}" numbers emails phones ids external hits=0
  if [ -z "$root" ]; then
    root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
  fi
  if [ ! -d "$root" ]; then
    printf '[sensitive-scan] 工作树不存在：%s\n' "$root" >&2
    return 1
  fi
  cd "$root" || return 1

  for tool in git grep xargs sort; do
    if ! command -v "$tool" >/dev/null 2>&1; then
      printf '[sensitive-scan] 缺少必需工具 %s，拒绝放行。\n' "$tool" >&2
      return 1
    fi
  done

  local listing status=0
  listing="$(git -c core.quotePath=false ls-files -co --exclude-standard)" || {
    status=$?
    printf '[sensitive-scan] git ls-files 失败（退出码 %d），拒绝放行。\n' "$status" >&2
    return 1
  }
  if [ -z "$listing" ]; then
    printf '[sensitive-scan] 没有扫到任何文件，拒绝放行。\n' >&2
    return 1
  fi
  local -a files=()
  mapfile -t files <<< "$listing"

  # 路径：一次 grep 扫完整份清单，输出里的行号指回 files 数组，不为每个文件起进程。
  local path_matches hit lineno value rel digits
  declare -A bad_paths=()
  path_matches="$(printf '%s\n' "$listing" | grep -nPo -e "$SEPARATED_NUMBER_RE|$EMAIL_RE")" || status=$?
  if [ "$status" -gt 1 ]; then
    printf '[sensitive-scan] 路径 grep 失败（退出码 %d），拒绝放行。\n' "$status" >&2
    return 1
  fi
  status=0
  while IFS= read -r hit; do
    [ -n "$hit" ] || continue
    lineno="${hit%%:*}"
    value="${hit#*:}"
    rel="${files[lineno-1]}"
    sensitive_match "$value" || continue
    if is_email_value "$value"; then
      if allowlisted "$value" || path_allowlisted "$rel"; then
        continue
      fi
    else
      digits="$(normalize_number "$value")"
      if allowlisted "$value" || allowlisted "$digits" || path_allowlisted "$rel"; then
        continue
      fi
    fi
    bad_paths["$rel"]=1
  done <<< "$path_matches"
  local sorted_paths
  sorted_paths="$(printf '%s\n' "${!bad_paths[@]+"${!bad_paths[@]}"}" | sort)" || {
    printf '[sensitive-scan] sort 失败，拒绝放行。\n' >&2
    return 1
  }
  while IFS= read -r rel; do
    [ -n "$rel" ] || continue
    printf '路径:%s\n' "$rel" >&2
    hits=$((hits + 1))
  done <<< "$sorted_paths"

  # 内容：两趟 grep 只吃 git 列出的文件（-I 跳过二进制），判定沿用上面那一份。
  numbers="$(printf '%s\n' "$listing" | xargs -d '\n' -r bash -c 're="$1"; shift; grep -HInoP -I -e "$re" -- "$@" || [ $? -eq 1 ]' _ "$SEPARATED_NUMBER_RE")" || status=$?
  if [ "$status" -gt 1 ]; then
    printf '[sensitive-scan] 数字 grep 失败（退出码 %d），拒绝放行。\n' "$status" >&2
    return 1
  fi
  status=0
  emails="$(printf '%s\n' "$listing" | xargs -d '\n' -r bash -c 're="$1"; shift; grep -HInoP -I -e "$re" -- "$@" || [ $? -eq 1 ]' _ "$EMAIL_RE")" || status=$?
  if [ "$status" -gt 1 ]; then
    printf '[sensitive-scan] 邮箱 grep 失败（退出码 %d），拒绝放行。\n' "$status" >&2
    return 1
  fi

  phones="$(unlisted_path_hits "$(unlisted_number_hits "$(matched_phones "$numbers")")")"
  ids="$(unlisted_path_hits "$(unlisted_number_hits "$(matched_ids "$numbers")")")"
  external="$(unlisted_path_hits "$(unlisted_hits "$(external_emails "$emails")")")"

  if [ -n "$phones" ]; then
    printf '[sensitive-scan] 手机号（路径:行号:命中内容）：\n%s\n' "$phones" >&2
    hits=$((hits + 1))
  fi
  if [ -n "$ids" ]; then
    printf '[sensitive-scan] 证件号（路径:行号:命中内容）：\n%s\n' "$ids" >&2
    hits=$((hits + 1))
  fi
  if [ -n "$external" ]; then
    printf '[sensitive-scan] 非示例邮箱（路径:行号:命中内容）：\n%s\n' "$external" >&2
    hits=$((hits + 1))
  fi

  if [ "$hits" -gt 0 ]; then
    printf '[sensitive-scan] 未通过：%d 类问题，按 路径:行号:命中内容 处理，或登记带理由的例外。\n' "$hits" >&2
    return 1
  fi
  printf '[sensitive-scan] 通过：%d 个文件，无手机号/证件号/非示例邮箱。\n' "${#files[@]}"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  scan_worktree "${1:-}"
fi
