#!/usr/bin/env bash
# R-059：测试阶段结束后再读一次测试库的启动时刻。
# 与前置核对记下的时刻不一致，就明确提示「测试库中途重启过（崩溃恢复）」。
# 只提示、不改退出码 —— 该红的阶段仍然红，升主线由人拍。
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
STARTED_AT_FILE="${TEST_DB_STARTED_AT_FILE:-$ROOT/.ci/test-db-started-at}"
AFTER_FILE="${TEST_DB_AFTER_FILE:-$ROOT/.ci/test-db-after-started-at}"
RESTARTED_FILE="${TEST_DB_RESTARTED_FILE:-$ROOT/.ci/test-db-restarted}"

if [ -n "${PG_PROBE_BIN:-}" ]; then
  probe=("$PG_PROBE_BIN")
else
  # env 文件在 test-pg-check.sh 子进程里读入，那些 export 回不到 gate 的 shell；
  # 复核是真探针时自己读同一份 env（口令只进进程环境，不打印）。
  env_file="${TEST_PG_ENV_FILE:-}"
  if [ -z "$env_file" ]; then
    common_dir="$(git -C "$ROOT" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)"
    [ -n "$common_dir" ] && env_file="$(dirname "$common_dir")/.local/test-pg.env"
  fi
  if [ -n "$env_file" ] && [ -f "$env_file" ]; then
    while IFS='=' read -r key value; do
      case "$key" in
        POSTGRES_HOST|POSTGRES_PORT|POSTGRES_USER|POSTGRES_PASSWORD|POSTGRES_DATABASE)
          printf -v "$key" '%s' "$value"
          export "$key"
          ;;
      esac
    done < "$env_file"
  fi
  probe=(node "$ROOT/scripts/ci/pg-probe.mjs")
fi

mkdir -p "$(dirname "$AFTER_FILE")" "$(dirname "$RESTARTED_FILE")"

# 三态：1 重启过 / 0 确认没重启 / null 没法判断。读不到绝不写成「没重启」（复查提示 4）。
unknown() {
  printf '[test-db] 没能复核测试库是否重启（%s）；这轮无法排除测试库中途重启。\n' "$1" >&2
  printf 'null\n' > "$RESTARTED_FILE"
  exit 0
}

if ! PG_PROBE_START_TIME_FILE="$AFTER_FILE" "${probe[@]}"; then
  unknown '复核探针失败'
fi

before="$(cat "$STARTED_AT_FILE" 2>/dev/null || true)"
after="$(cat "$AFTER_FILE" 2>/dev/null || true)"
if [ -z "$before" ] || [ -z "$after" ]; then
  unknown '前后时刻文件为空'
fi
if [ "$before" != "$after" ]; then
  printf '\n\033[33m[test-db] 测试库在运行期间重启过（崩溃恢复），这轮红可能来自它；先查 `podman logs hs-erp-pg-test` 里有没有 `was terminated by signal`。\033[0m\n\n'
  printf '1\n' > "$RESTARTED_FILE"
else
  printf '0\n' > "$RESTARTED_FILE"
fi
exit 0
