#!/usr/bin/env bash
# fast 档判断本次改动是否需要测试库（R-056 收尾第 4 点；PR #162 独立复查应改 1）。
# fail-safe：默认「要连库」，只有当每一个改动文件都被正面认定为文档时才返回「不要」。
# 空清单、git 取不到基线、名单外的路径，一律判「要连库」—— 拿不准就查库，不放行假绿。
# exit 0 = 需要测试库；exit 1 = 不需要。
set -uo pipefail

ROOT="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"

# 默认值先立住：下面任何一步拿不准，都留在这个值上。
# 内部布尔 needs_db=1 表示要连库；对外 exit 0 才表示要连库（契约），别直接 exit 布尔值。
needs_db=1
finish() {
  if [ "$needs_db" -eq 1 ]; then exit 0; else exit 1; fi
}

if ! git -C "$ROOT" rev-parse --verify -q HEAD >/dev/null 2>&1; then
  # 没有 git 基线：git diff 会失败，不能把失败当空清单。
  finish
fi

changed="$(mktemp)" || finish
trap 'rm -f "$changed"' EXIT
if ! {
  git -C "$ROOT" diff --name-only --diff-filter=d HEAD &&
  git -C "$ROOT" ls-files --others --exclude-standard
} >"$changed" 2>/dev/null; then
  # git 取改动失败：同样按「拿不准」处理，不让 stderr 被吞掉后假绿。
  finish
fi

all_docs=1
seen=0
while IFS= read -r file; do
  [ -n "$file" ] || continue
  seen=1
  case "$file" in
    # 文档（含 app-local/AGENTS.md）不连库；md 的显式分支要放在路径分支前面。
    *.md|*.mdx|wiki/*|raw/*|HANDOFF/*|HANDOFF.md|.agents/*|docs/*) ;;
    # 名单外的一切（应用代码、测试、闸门脚本、根目录文件）都要连库。
    *) all_docs=0 ;;
  esac
done < "$changed"

# 只有「确实有改动」且「每个文件都正面认定为文档」才允许跳过。
if [ "$seen" -eq 1 ] && [ "$all_docs" -eq 1 ]; then
  needs_db=0
fi

finish
