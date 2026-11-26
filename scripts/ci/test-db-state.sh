#!/usr/bin/env bash
# R-059：测试库时刻生成物的唯一清理入口。
# gate 的核对分支与所有不核对分支（docs、只改文档的 fast、CI 或 CI=true 的 unit）
# 都调用它，避免上一轮的时刻混进这一轮的判据。
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
STARTED_AT_FILE="${TEST_DB_STARTED_AT_FILE:-$ROOT/.ci/test-db-started-at}"
AFTER_FILE="${TEST_DB_AFTER_FILE:-$ROOT/.ci/test-db-after-started-at}"
RESTARTED_FILE="${TEST_DB_RESTARTED_FILE:-$ROOT/.ci/test-db-restarted}"

case "${1:-}" in
  init)
    # 每次运行一个独立目录；调用方（gate.sh）拿路径后自己导出三个文件名。
    base="${2:-}"
    [ -n "$base" ] || { printf 'init 需要基目录\n' >&2; exit 2; }
    mkdir -p "$base" || exit 1
    mktemp -d "$base/test-db-run.XXXXXX" || exit 1
    ;;
  clear)
    rm -f "$STARTED_AT_FILE" "$AFTER_FILE" "$RESTARTED_FILE"
    ;;
  *)
    printf '用法：%s init <基目录> | %s clear\n' "$0" "$0" >&2
    exit 2
    ;;
esac
