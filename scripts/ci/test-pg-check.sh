#!/usr/bin/env bash
# 本地测试库的行为检查：容器身份（固定标签）+ 用 env 文件里的凭据真连一次。
# 由 gate.sh 只在真正连库的档位调用；CI 不调用（连接由工作流注入的变量保证）。
# 口令只从 600 的 .local/test-pg.env 读入进程环境，绝不打印。
# R-059：探针顺带记下 pg_postmaster_start_time() 到 TEST_DB_STARTED_AT_FILE，
# 测试阶段结束后由 test-db-restart-check.sh 复核；PG_PROBE_BIN 可注入替身供测试使用。
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TEST_PG_CONTAINER="${TEST_PG_CONTAINER:-hs-erp-pg-test}"
TEST_PG_LABEL="${TEST_PG_LABEL:-hs.erp.test-db}"
REBUILD='先跑 ./scripts/dev/up.sh --test-db'

fail_check() {
  printf '\n\033[31m[test-pg] %s\033[0m\n' "$1" >&2
  exit 1
}

command -v podman >/dev/null 2>&1 &&
  podman version >/dev/null 2>&1 ||
  fail_check "找不到 podman（或 podman 不可用）；测试只连 Postgres，$REBUILD，或由 CI 注入 POSTGRES_HOST。"

# 只看容器名不够：开发库 hs-erp-pg 不能被当成测试库。
podman ps --format '{{.Names}}' 2>/dev/null | grep -qx "$TEST_PG_CONTAINER" ||
  fail_check "测试库容器 $TEST_PG_CONTAINER 没在运行；测试只连 Postgres，$REBUILD。"

podman ps --format '{{.Names}}\t{{.Status}}' 2>/dev/null \
  | grep -F "$TEST_PG_CONTAINER"$'\t' | grep -q '(healthy)' ||
  fail_check "测试库容器 $TEST_PG_CONTAINER 未就绪；$REBUILD。"

label="$(podman inspect --format "{{index .Config.Labels \"$TEST_PG_LABEL\"}}" "$TEST_PG_CONTAINER" 2>/dev/null || true)"
[ "$label" = "1" ] ||
  fail_check "容器 $TEST_PG_CONTAINER 没有 $TEST_PG_LABEL=1 标签，不是测试库（开发库不会被当成测试库）；$REBUILD。"

# env 文件位置从 git common-dir 回推，副本里也能找到主检出那一份。
env_file="${TEST_PG_ENV_FILE:-}"
if [ -z "$env_file" ]; then
  common_dir="$(git -C "$ROOT" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)"
  [ -n "$common_dir" ] || fail_check "找不到测试库的连接参数；$REBUILD，或由 CI 注入变量。"
  env_file="$(dirname "$common_dir")/.local/test-pg.env"
fi
[ -f "$env_file" ] || fail_check "找不到测试库的连接参数；$REBUILD，或由 CI 注入变量。"

POSTGRES_HOST=''; POSTGRES_PORT=''; POSTGRES_USER=''
POSTGRES_PASSWORD=''; POSTGRES_DATABASE=''
while IFS='=' read -r key value; do
  case "$key" in
    POSTGRES_HOST|POSTGRES_PORT|POSTGRES_USER|POSTGRES_PASSWORD|POSTGRES_DATABASE)
      printf -v "$key" '%s' "$value"
      export "$key"
      ;;
  esac
done < "$env_file"

# 真连一次：容器在但凭据写岔也必须停下，不能让闸门假绿。
# 必须从宿主侧走 TCP —— 容器内 loopback 是 trust 认证，错口令也返回 1。
PG_PROBE_START_TIME_FILE="${TEST_DB_STARTED_AT_FILE:-$ROOT/.ci/test-db-started-at}"
start_dir="$(dirname "$PG_PROBE_START_TIME_FILE")"
mkdir -p "$start_dir" || fail_check "建不了测试库启动时刻的目录 $start_dir；修好权限再跑。"
export PG_PROBE_START_TIME_FILE
if [ -n "${PG_PROBE_BIN:-}" ]; then
  probe=("$PG_PROBE_BIN")
else
  probe=(node "$ROOT/scripts/ci/pg-probe.mjs")
fi
"${probe[@]}" ||
  fail_check "测试库连不上（宿主侧 TCP 探测失败）；$REBUILD 重建。"

printf '[test-pg] 测试库 %s 身份与连接均正常\n' "$TEST_PG_CONTAINER"
