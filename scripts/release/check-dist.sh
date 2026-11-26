#!/usr/bin/env bash
# R-053 第一片：产物自检。输入是 dist.tar.gz，输出是顶层清单、敏感扫描结果与 SHA-256。
# 任何一项失败都打印原因并退出非零，绝不静默放行；缺工具同样失败。
#
# 用法：check-dist.sh [dist.tar.gz]   缺省为仓库的 app-local/storage/exports/dist.tar.gz
# 脚本可以从仓库任何位置调用，路径都从脚本自身位置解析。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
ARTIFACT="${1:-$REPO_ROOT/app-local/storage/exports/dist.tar.gz}"

fail() {
  printf '[check-dist] 失败：%s\n' "$*" >&2
  exit 1
}

for tool in tar git grep find sha256sum stat bash; do
  command -v "$tool" >/dev/null 2>&1 || fail "缺少必需工具 $tool，拒绝放行。"
done
[ -f "$ARTIFACT" ] || fail "产物不存在：$ARTIFACT"

# 顶层允许清单：以 2026-11-26 实测的框架产出为准，每一项都写清为什么允许。
ALLOWED_TOP_LEVEL=(
  config.example.yml # 部署方据此写自己的 config.yml，不含密钥。
  dist # 服务端、客户端、CLI 与自带的生产依赖，解压即可运行。
  Dockerfile # prebuilt 入口 docker build --build-arg DIST=prebuilt . 需要它。
  Dockerfile.dockerignore # 与 Dockerfile 配套，挡住 config.yml/.env/storage 不进镜像。
)

# 顶层禁止清单：这些一旦出现在产物根下，就是源码、开发态配置或私有数据被打进了包。
FORBIDDEN_TOP_LEVEL=(
  config.yml
  '.env*'
  .local
  tests
  HANDOFF
  raw
  wiki
  .git
  .ci
)

WORK="$(mktemp -d /tmp/hs-check-dist.XXXXXX)" || fail '建临时目录失败。'
cleanup() {
  if [ -n "${WORK:-}" ] && [ -d "$WORK" ]; then
    rm -rf -- "$WORK"
  fi
}
trap cleanup EXIT

TREE="$WORK/tree"
mkdir -p "$TREE"
if ! tar --warning=no-unknown-keyword -xzf "$ARTIFACT" -C "$TREE" 2>"$WORK/tar.err"; then
  cat "$WORK/tar.err" >&2 || true
  fail "解包失败：$ARTIFACT"
fi

# find 一次取全顶层条目；比较按条目名，禁止项里的 '.env*' 按通配符匹配。
mapfile -t entries < <(find "$TREE" -mindepth 1 -maxdepth 1 -printf '%f\n' | sort)
[ "${#entries[@]}" -gt 0 ] || fail '产物树是空的。'

offenders=()
for entry in "${entries[@]}"; do
  allowed=0
  for ok in "${ALLOWED_TOP_LEVEL[@]}"; do
    if [ "$entry" = "$ok" ]; then
      allowed=1
      break
    fi
  done
  if [ "$allowed" -eq 0 ]; then
    offenders+=("$entry")
  fi
done
if [ "${#offenders[@]}" -gt 0 ]; then
  printf '[check-dist] 顶层条目不在允许清单：\n' >&2
  printf '  %s\n' "${offenders[@]}" >&2
  fail '顶层清单校验未通过。'
fi

for entry in "${entries[@]}"; do
  for bad in "${FORBIDDEN_TOP_LEVEL[@]}"; do
    # 不引号展开 $bad，'.env*' 才能按通配符匹配。
    if [[ "$entry" == $bad ]]; then
      fail "禁止路径出现在产物根下：$entry"
    fi
  done
done

# 敏感信息规则只有 scripts/dev/sensitive-scan.sh 这一份，这里不另写判定。
# 临时建一个 git 索引让共享脚本能列文件。两处排除在索引之外，主会话已接受这一收窄：
#   dist/node_modules/ —— 上游依赖，pdf-parse 的图片路径（@2x.png 命名）会被邮箱规则误报；
#   dist/client/assets/ —— 构建产物，客户端本地化资源里的示例邮箱与数字串会误报。
# 兜底：入库文件在每一档闸门前已由 scripts/dev/sensitive-scan.sh 扫过源文件（gate.sh 的敏感信息预检），
# 产物根下的 config.example.yml、Dockerfile、Dockerfile.dockerignore 与 dist 元数据仍在本次扫描范围内；
# 排除的只是上游依赖与由已扫源文件生成的构建资源，共享规则文件一字未改。
git -C "$TREE" init -q
printf 'dist/node_modules/\ndist/client/assets/\n' >"$TREE/.git/info/exclude"
git -C "$TREE" add -A .
if ! scan_output="$(bash "$REPO_ROOT/scripts/dev/sensitive-scan.sh" "$TREE" 2>&1)"; then
  printf '%s\n' "$scan_output" >&2
  fail '敏感信息检查未通过。'
fi
printf '%s\n' "$scan_output"

FILE_COUNT="$(find "$TREE" -path "$TREE/.git" -prune -o -type f -print | wc -l)"
ARTIFACT_SIZE="$(stat -c %s "$ARTIFACT")"
SHA256="$(sha256sum "$ARTIFACT" | cut -d ' ' -f 1)"
printf '[check-dist] 产物：%s\n' "$ARTIFACT"
printf '[check-dist] 文件数：%s\n' "$FILE_COUNT"
printf '[check-dist] 大小（字节）：%s\n' "$ARTIFACT_SIZE"
printf '[check-dist] sha256：%s\n' "$SHA256"
printf '[check-dist] 通过。\n'
