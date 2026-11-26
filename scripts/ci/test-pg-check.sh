#!/usr/bin/env bash
# 本地测试库的行为检查：容器身份（固定标签）+ 用 env 文件里的凭据真连一次。
# 由 gate.sh 只在真正连库的档位调用；CI 不调用（连接由工作流注入的变量保证）。
# 口令只从 600 的 .local/test-pg.env 读入进程环境，绝不打印。
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
common_dir="$(git -C "$ROOT" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)"
[ -n "$common_dir" ] || fail_check "找不到测试库的连接参数；$REBUILD，或由 CI 注入变量。"
env_file="$(dirname "$common_dir")/.local/test-pg.env"
[ -f "$env_file" ] || fail_check "找不到测试库的连接参数；$REBUILD，或由 CI 注入变量。"

POSTGRES_HOST=''; POSTGRES_PORT=''; POSTGRES_USER=''
POSTGRES_PASSWORD=''; POSTGRES_DATABASE=''
while IFS='=' read -r key value; do
  case "$key" in
    POSTGRES_HOST|POSTGRES_PORT|POSTGRES_USER|POSTGRES_PASSWORD|POSTGRES_DATABASE)
      printf -v "$key" '%s' "$value"
      ;;
  esac
done < "$env_file"

# 真连一次：容器在但凭据写岔也必须停下，不能让闸门假绿。
podman exec -e "PGPASSWORD=$POSTGRES_PASSWORD" "$TEST_PG_CONTAINER" \
  psql -U "$POSTGRES_USER" -d "$POSTGRES_DATABASE" -tAc 'select 1' >/dev/null 2>&1 ||
  fail_check "测试库连不上（凭据或容器状态不对）；$REBUILD 重建。"

printf '[test-pg] 测试库 %s 身份与连接均正常\n' "$TEST_PG_CONTAINER"
