#!/usr/bin/env bash
# R-053 第一片：在干净副本里构建 dist.tar.gz，再交给 check-dist.sh 自检。
# 干净副本只含 HEAD 的受跟踪文件（git archive），依赖沿用调用方已装好的 app-local/node_modules 符号链接。
# 脚本可以从仓库任何位置调用，路径都从脚本自身位置解析。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
CHECKER="$SCRIPT_DIR/check-dist.sh"

fail() {
  printf '[build-dist] 失败：%s\n' "$*" >&2
  exit 1
}

for tool in git tar cp mkdir date mise bash; do
  command -v "$tool" >/dev/null 2>&1 || fail "缺少必需工具 $tool，拒绝放行。"
done
[ -f "$CHECKER" ] || fail "找不到自检脚本：$CHECKER"

WORK="$(mktemp -d /tmp/hs-build-dist.XXXXXX)" || fail '建临时目录失败。'
cleanup() {
  if [ -n "${WORK:-}" ] && [ -d "$WORK" ]; then
    rm -rf -- "$WORK"
  fi
}
trap cleanup EXIT

COPY="$WORK/app"
mkdir -p "$COPY/app-local"
printf '[build-dist] 建立干净副本：%s\n' "$COPY"
if ! git -C "$REPO_ROOT" archive HEAD | tar -x -C "$COPY"; then
  fail 'git archive 解包失败。'
fi
if [ ! -d "$REPO_ROOT/app-local/node_modules" ]; then
  fail '调用方的 app-local/node_modules 不存在；先在本机装好依赖，脚本不执行安装。'
fi
ln -s "$REPO_ROOT/app-local/node_modules" "$COPY/app-local/node_modules"

printf '[build-dist] 开始构建 %s\n' "$(date -Iseconds)"
if ! (cd "$COPY/app-local" && mise exec node@24 -- pnpm build --target linux-x64 --node-version 24 --tar); then
  fail '构建命令退出非零。'
fi
printf '[build-dist] 构建结束 %s\n' "$(date -Iseconds)"

ARTIFACT="$COPY/app-local/storage/exports/dist.tar.gz"
[ -f "$ARTIFACT" ] || fail "构建未产出 $ARTIFACT"
if ! bash "$CHECKER" "$ARTIFACT"; then
  fail '自检未通过，产物不发布。'
fi

OUT_DIR="$REPO_ROOT/app-local/storage/exports"
mkdir -p "$OUT_DIR"
cp -- "$ARTIFACT" "$OUT_DIR/dist.tar.gz"
printf '[build-dist] 已交付：%s\n' "$OUT_DIR/dist.tar.gz"
