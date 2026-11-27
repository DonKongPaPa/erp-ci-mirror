#!/usr/bin/env bash
# R-053 第一片：产物自检。输入是 dist.tar.gz，旁边必须有同名 .manifest.json 清单；
# 输出是顶层清单、内容核对、敏感扫描结果、清单核对与 SHA-256。
# 任何一项失败都打印原因并退出非零，绝不静默放行；缺工具同样失败。
#
# 用法：check-dist.sh [dist.tar.gz]   缺省为仓库的 app-local/storage/exports/dist.tar.gz
# 脚本可以从仓库任何位置调用，路径都从脚本自身位置解析。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
ARTIFACT="${1:-$REPO_ROOT/app-local/storage/exports/dist.tar.gz}"
MANIFEST="$ARTIFACT.manifest.json"

fail() {
  printf '[check-dist] 失败：%s\n' "$*" >&2
  exit 1
}

for tool in tar git grep find sha256sum stat bash node sort diff cmp; do
  command -v "$tool" >/dev/null 2>&1 || fail "缺少必需工具 $tool，拒绝放行。"
done
[ -f "$ARTIFACT" ] || fail "产物不存在：$ARTIFACT"
SHA256="$(sha256sum "$ARTIFACT" | cut -d ' ' -f 1)"

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

# 顶层名字齐全不等于内容齐全：空 dist/ 与空 Dockerfile 都要在这里拦下。
for required in dist/package.json dist/cli/index.js dist/server/standalone.js; do
  [ -f "$TREE/$required" ] || fail "dist/ 缺少预期入口：$required"
  [ -s "$TREE/$required" ] || fail "dist/ 的预期入口是空文件：$required"
done
[ -d "$TREE/dist/node_modules" ] || fail 'dist/ 缺少预期入口：dist/node_modules/'
[ -n "$(find "$TREE/dist/node_modules" -mindepth 1 -maxdepth 1 -print -quit)" ] ||
  fail 'dist/ 的预期入口 dist/node_modules/ 是空目录。'
for name in Dockerfile Dockerfile.dockerignore; do
  [ -f "$TREE/$name" ] || fail "缺少文件：$name"
  [ -s "$TREE/$name" ] || fail "$name 是空文件，无法构建镜像。"
done
# 与 Dockerfile 的 dist-prebuilt 阶段同口径：缺阶段或缺平台参数就拦，不只靠镜像构建时才发现。
for token in 'AS dist-prebuilt' '--platform=$BUILDPLATFORM' 'ARG TARGETARCH' 'buildTarget' 'relocatable'; do
  grep -qF -- "$token" "$TREE/Dockerfile" ||
    fail "Dockerfile 缺少预期的阶段或平台参数：$token"
done

# Dockerfile 里的核对只在构建镜像时跑；自检用同一份 dist/package.json 再做一遍。
if ! PLATFORM_OUT="$(node - "$TREE/dist/package.json" <<'EOF'
const fs = require('node:fs');
const pkg = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const nc = pkg.nocobase ?? {};
const target = nc.buildTarget ?? {};
const problems = [];
if (target.platform !== 'linux') problems.push(`platform=${JSON.stringify(target.platform)}`);
if (target.arch !== 'x64' && target.arch !== 'arm64') problems.push(`arch=${JSON.stringify(target.arch)}`);
if (target.libc !== 'glibc') problems.push(`libc=${JSON.stringify(target.libc)}`);
if (target.nodeMajor !== 24) problems.push(`nodeMajor=${JSON.stringify(target.nodeMajor)}`);
if (nc.relocatable !== true) problems.push('relocatable 不是 true');
if (problems.length > 0) {
  console.error(`dist/package.json 的平台/可搬迁声明不符合预期：${problems.join(', ')}`);
  process.exit(1);
}
console.log(`[check-dist] dist 目标：linux/${target.arch} glibc Node ${target.nodeMajor}，relocatable=true`);
EOF
)"; then
  printf '%s\n' "$PLATFORM_OUT" >&2
  fail '平台与可搬迁核对未通过。'
fi
printf '%s\n' "$PLATFORM_OUT"

# R-073：部署产物里不许有开发与演示功能 —— 是「没有」，不是「关着」。
# 用户 2026-11-27：「你要在部署版本上删掉演示的功能（注意不是关闭功能而是移除）防止风险。」
# 运行时开关与启动守卫只是第二道防线；这里落在产物内容上，命中即失败。
# 标记逐个写死，与 scripts/release/build-dist.sh 的剔除清单、app-local/tests/project/deploy-dist-configs.test.ts
# 的守门对得上。只认这几个标记，不认笼统的 devTools：第三方库里也有同名的无害字串（recharts 的
# devTools），写宽了只能靠排除来放行，那是给自己留口子。
#
#   路径   dist/ 下不许有：文件名含 dev-account-switcher、路径含 /dev-tools/、名为 dev-tools.<扩展名>；
#   服务端 dist/server 全文不许出现：switch-account、dev-account-switcher、七个演示账户的用户名；
#   客户端 dist/client 全文不许出现：dev-account-switcher 与切换器的四条词条文案。
DEV_TOOLS_PATH_FIND=(
  -name '*dev-account-switcher*'
  -o -path '*/dev-tools/*'
  -o -name 'dev-tools.*'
)
DEV_TOOLS_SERVER_MARKERS=(
  switch-account
  dev-account-switcher
  demo.quality_manager
  demo.quality_inspector
  demo.dept_manager
  demo.staff
  demo.warehouse
  demo.purchase
  demo.sales
)
DEV_TOOLS_CLIENT_MARKERS=(
  dev-account-switcher
  切换账户
  仅开发环境
  'Switch account'
  'Development only'
)

# 把 directory 下含某个标记的文件记进 offenders；grep 自己出错（退出码大于 1）同样让自检失败，不放行。
dev_tools_scan() {
  local marker="$1" directory="$2" label="$3" status=0 file
  grep -rlaF -- "$marker" "$directory" >"$WORK/dev-tools-hits" 2>"$WORK/dev-tools-grep.err" || status=$?
  if [ "$status" -gt 1 ]; then
    cat "$WORK/dev-tools-grep.err" >&2 || true
    fail "查开发工具标记 ${marker} 时 grep 出错（退出码 ${status}）。"
  fi
  while IFS= read -r file; do
    dev_tools_offenders+=("${label}${file#"$TREE"/}")
  done < "$WORK/dev-tools-hits"
}

dev_tools_offenders=()
while IFS= read -r -d '' file; do
  dev_tools_offenders+=("路径里有开发工具：${file#"$TREE"/}")
done < <(find "$TREE/dist" -type f \( "${DEV_TOOLS_PATH_FIND[@]}" \) -print0)
for marker in "${DEV_TOOLS_SERVER_MARKERS[@]}"; do
  dev_tools_scan "$marker" "$TREE/dist/server" "服务端里有标记 ${marker}："
done
if [ -d "$TREE/dist/client" ]; then
  for marker in "${DEV_TOOLS_CLIENT_MARKERS[@]}"; do
    dev_tools_scan "$marker" "$TREE/dist/client" "客户端里有标记 ${marker}："
  done
fi
if [ "${#dev_tools_offenders[@]}" -gt 0 ]; then
  printf '[check-dist] 产物里有开发与演示功能（必须是「没有」，不是「关着」）：\n' >&2
  printf '  %s\n' "${dev_tools_offenders[@]}" >&2
  fail '开发与演示功能进了部署产物。'
fi
printf '[check-dist] 开发与演示功能：未命中（路径、服务端全文、客户端全文，共 %s 个标记）。\n' \
  "$(( ${#DEV_TOOLS_SERVER_MARKERS[@]} + ${#DEV_TOOLS_CLIENT_MARKERS[@]} ))"

# 敏感信息规则只有 scripts/dev/sensitive-scan.sh 这一份，这里不另写判定。
# 三处排除在索引之外，主会话已接受这一收窄：
#   dist/node_modules/ —— 上游依赖，pdf-parse 的图片路径（@2x.png 命名）会被邮箱规则误报；
#   dist/client/assets/ —— 构建产物，客户端本地化资源里的示例邮箱与数字串会误报。
#   dist/database/main/migrations/.manifest.json —— 迁移的校验和清单，数字串是内容散列不是个人信息；只点名这一个文件，同目录其它文件照扫。
# 兜底：入库文件在每一档闸门前已由 scripts/dev/sensitive-scan.sh 扫过源文件（gate.sh 的敏感信息预检），
# 产物根下的 config.example.yml、Dockerfile、Dockerfile.dockerignore 与 dist 元数据仍在本次扫描范围内；
# 排除的只是上游依赖与由已扫源文件生成的构建资源，共享规则文件一字未改。
#
# 关键：文件清单用 find 列全量，不经过任何忽略规则。产物里放 .gitignore / .gitattributes
# 会改变 git 的忽略与属性判定，先把这类文件拦掉，再断言「索引文件 = find 列出的应扫描文件」。
mapfile -d '' -t all_files < <(find "$TREE" -path "$TREE/.git" -prune -o -type f -print0)
[ "${#all_files[@]}" -gt 0 ] || fail '产物树里没有任何文件。'
EXPECTED_LIST="$WORK/expected-files"
: > "$EXPECTED_LIST"
for file in "${all_files[@]}"; do
  rel="${file#"$TREE"/}"
  case "$rel" in
    dist/node_modules/* | dist/client/assets/* | dist/database/main/migrations/.manifest.json) continue ;;
  esac
  base="${rel##*/}"
  if [ "$base" = '.gitignore' ] || [ "$base" = '.gitattributes' ]; then
    fail "产物树里不允许出现 $base（它会改变忽略/属性规则，让敏感扫描被绕过）：$rel"
  fi
  printf '%s\n' "$rel" >> "$EXPECTED_LIST"
done

git -C "$TREE" init -q
printf 'dist/node_modules/\ndist/client/assets/\ndist/database/main/migrations/.manifest.json\n' >"$TREE/.git/info/exclude"
# -f 压过产物里残留的忽略规则；core.excludesFile 置空，不认调用方的全局忽略文件。
git -c core.excludesFile=/dev/null -c core.attributesFile=/dev/null -C "$TREE" add -A -f -- .
# -f 也会把上面三条排除项加进索引，显式撤掉，保持既定的收窄范围。
git -C "$TREE" rm -r --cached -q --ignore-unmatch -- dist/node_modules dist/client/assets dist/database/main/migrations/.manifest.json
sort -o "$EXPECTED_LIST" "$EXPECTED_LIST"
# 与 sensitive-scan.sh 同口径：默认 quotePath 会把非 ASCII 路径转义成带引号的八进制形式，
# 和 find 列出的原样路径对不上，合法产物会被误判为「清单不一致」。
git -c core.quotePath=false -C "$TREE" ls-files | sort > "$WORK/indexed-files"
if ! cmp -s "$EXPECTED_LIST" "$WORK/indexed-files"; then
  printf '[check-dist] 应扫描文件（左）与索引文件（右）差异：\n' >&2
  diff -u "$EXPECTED_LIST" "$WORK/indexed-files" >&2 || true
  fail '敏感扫描的索引与产物文件清单不一致，可能有文件被忽略规则藏起来。'
fi

if ! scan_output="$(bash "$REPO_ROOT/scripts/dev/sensitive-scan.sh" "$TREE" 2>&1)"; then
  printf '%s\n' "$scan_output" >&2
  fail '敏感信息检查未通过。'
fi
printf '%s\n' "$scan_output"

# 清单与内容核对：提交号、归档与每个文件的校验和、锁文件哈希，全部对上才放行。
[ -f "$MANIFEST" ] || fail "清单文件不存在：$MANIFEST（构建时必须与产物一起落盘）"
WORKTREE_STATUS="$(git -C "$REPO_ROOT" status --porcelain 2>/dev/null)" ||
  fail '读取仓库工作区状态失败。'
[ -z "$WORKTREE_STATUS" ] ||
  fail '工作区不干净：这份产物不是在干净的提交上构建的。'
if ! MANIFEST_OUT="$(node - "$MANIFEST" "$TREE" "$SHA256" "$REPO_ROOT" "$REPO_ROOT/app-local/pnpm-lock.yaml" <<'EOF'
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const [manifestPath, tree, archiveSha, repo, lockPath] = process.argv.slice(2);
const fail = (message) => {
  console.error(message);
  process.exit(1);
};
let manifest;
try {
  manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
} catch (error) {
  fail(`清单文件无法解析：${error.message}`);
}
if (typeof manifest.commit !== 'string' || !/^[0-9a-f]{40}$/u.test(manifest.commit)) {
  fail(`清单里的提交号为空或格式不对：${JSON.stringify(manifest.commit)}`);
}
const head = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], {
  encoding: 'utf8',
}).trim();
if (manifest.commit !== head) {
  fail(`清单的提交号 ${manifest.commit} 与当前 HEAD ${head} 不一致。`);
}
const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');
if (manifest.archive?.sha256 !== archiveSha) {
  fail(`归档校验和不符：清单 ${manifest.archive?.sha256 ?? '(空)'}，实际 ${archiveSha}。`);
}
const lockSha = sha(fs.readFileSync(lockPath));
if (manifest.lockfile?.sha256 !== lockSha) {
  fail(`锁文件哈希不符：清单 ${manifest.lockfile?.sha256 ?? '(空)'}，实际 ${lockSha}。`);
}
const declared = manifest.files;
if (!declared || typeof declared !== 'object' || Array.isArray(declared)) {
  fail('清单缺少 files 校验和表。');
}
function walk(dir, base = '') {
  const result = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git') continue;
    const rel = base ? `${base}/${entry.name}` : entry.name;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) result.push(...walk(full, rel));
    else if (entry.isFile()) result.push(rel);
  }
  return result;
}
const actual = walk(tree).sort();
const expected = Object.keys(declared).sort();
const missing = actual.filter((rel) => !(rel in declared));
const extra = expected.filter((rel) => !actual.includes(rel));
if (missing.length > 0) fail(`清单少了这些文件的校验和：${missing.join(', ')}`);
if (extra.length > 0) fail(`清单多出这些产物里不存在的文件：${extra.join(', ')}`);
for (const rel of actual) {
  const got = sha(fs.readFileSync(path.join(tree, rel)));
  if (got !== declared[rel]) {
    fail(`${rel} 的校验和与产物内容不符：清单 ${declared[rel]}，实际 ${got}。`);
  }
}
console.log(`[check-dist] 清单一致：提交 ${manifest.commit}，文件 ${actual.length} 个，锁文件哈希 ${lockSha}。`);
EOF
)"; then
  printf '%s\n' "$MANIFEST_OUT" >&2
  fail '清单校验未通过。'
fi
printf '%s\n' "$MANIFEST_OUT"

FILE_COUNT="$(find "$TREE" -path "$TREE/.git" -prune -o -type f -print | wc -l)"
ARTIFACT_SIZE="$(stat -c %s "$ARTIFACT")"
printf '[check-dist] 产物：%s\n' "$ARTIFACT"
printf '[check-dist] 清单：%s\n' "$MANIFEST"
printf '[check-dist] 文件数：%s\n' "$FILE_COUNT"
printf '[check-dist] 大小（字节）：%s\n' "$ARTIFACT_SIZE"
printf '[check-dist] sha256：%s\n' "$SHA256"
printf '[check-dist] 通过。\n'
