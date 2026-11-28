#!/usr/bin/env bash
# 本地一条命令跑完整闸门 —— GitHub Actions 读的是同一个文件。
#
# 存在的理由：用户要求 agent 完全自理，且「每个变动要和提交对上号」。
# 如果 CI 逻辑藏在 YAML 里，本地就复现不了，agent 只能靠推上去看红绿。
# 所以 YAML 只负责装环境，真正跑的东西在这里；本地和 CI 校验同一份脚本。
#
# 用法：
#   scripts/ci/gate.sh fast      # 改动相关的测试 + 组件复用检查（日常迭代，~20-40s）
#   scripts/ci/gate.sh unit      # lint + typecheck + 组件复用检查 + 全部单测（提交前，~110s）
#   scripts/ci/gate.sh beta      # unit + build + e2e（合入 main 前）
#   scripts/ci/gate.sh docs      # 文档守门 + evidence + compliance（只改了文档的推送，~2-3min）
#   scripts/ci/gate.sh all       # beta + evidence + compliance（动过文档时）
#
# 脱敏镜像（R-049）设仓库变量 CI_MIRROR=1：镜像里没有 wiki/、raw/、HANDOFF.md、
# .agents 等仓库级文档，文档快道与文档守门在那里是「跳过」而不是「失败」。
# 单测线与 beta 基线照跑。跳过的阶段从 verdict 的计划里摘掉，不记成失败。
#
# 退出码 0 表示全绿；非 0 表示有阶段失败，具体看 .ci/verdict.json。

set -uo pipefail

STAGE="${1:-unit}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
APP="$ROOT/app-local"
CI_DIR="$ROOT/.ci"
CI_MIRROR="${CI_MIRROR:-0}"
# 本地测试库容器（主机名固定；可用 TEST_PG_CONTAINER 覆盖以便守门测试）。CI 注入 POSTGRES_HOST，不用它。
export TEST_PG_CONTAINER="${TEST_PG_CONTAINER:-hs-erp-pg-test}"

mkdir -p "$CI_DIR"

fail() {
  printf '\n\033[31m[gate] %s\033[0m\n' "$1" >&2
  exit 1
}

# R-059：每次运行一个独立目录放测试库时刻文件，不共用固定路径 ——
# 同一副本里并发的 docs / fast / unit 档不能互相清掉对方的前置时刻，
# 更不能让对方的新时刻被误读成「这一轮确认没重启」。
if [ -f "$ROOT/scripts/ci/test-db-state.sh" ]; then
  TEST_DB_RUN_DIR="$(bash "$ROOT/scripts/ci/test-db-state.sh" init "$CI_DIR")" ||
    fail "建不了测试库时刻目录：$CI_DIR"
else
  # 守门测试的临时仓库只拷了 gate.sh，内联建同样的目录，行为一致。
  TEST_DB_RUN_DIR="$(mktemp -d "$CI_DIR/test-db-run.XXXXXX")" ||
    fail "建不了测试库时刻目录：$CI_DIR"
fi
TEST_DB_STARTED_AT_FILE="$TEST_DB_RUN_DIR/started-at"
TEST_DB_AFTER_FILE="$TEST_DB_RUN_DIR/after-started-at"
TEST_DB_RESTARTED_FILE="$TEST_DB_RUN_DIR/restarted"
export TEST_DB_RUN_DIR TEST_DB_STARTED_AT_FILE TEST_DB_AFTER_FILE TEST_DB_RESTARTED_FILE
# 判据里是否写 testDb，只认这一轮真的做了容器核对（不核对的档位绝不吃旧文件）。
export TEST_DB_CHECKED=0
cleanup_test_db_run() {
  local dir="${TEST_DB_RUN_DIR:-}"
  [ -n "$dir" ] || return 0
  case "$dir" in
    "$CI_DIR"/test-db-run.*) rm -rf -- "$dir" ;;
  esac
  TEST_DB_RUN_DIR=''
}
trap cleanup_test_db_run EXIT

step() {
  printf '\n\033[36m[gate] %s\033[0m\n' "$1"
}

# 镜像里没有仓库级文档，依赖它们的阶段是「跳过」而非「失败」。
# skip_notice 只打印；skip_stage 还把阶段从 verdict 的计划里摘掉（verdict.mjs
# 把非 passed 都算失败，记一个 skipped 反而会让整份判据变红）。
SKIPPED_STAGES=()
skip_notice() {
  printf '\n\033[36m[gate] 跳过：%s（%s）\033[0m\n' "$1" "$2"
}
skip_stage() {
  skip_notice "$1" "$2"
  SKIPPED_STAGES+=("$1")
}

# 入库文件的三类敏感信息在合并之前就拦，不等镜像同步（R-048 验收 12）。
# 扫整棵工作树的受跟踪与未忽略文件，规则与 ci-mirror.sh 共用 sensitive-scan.sh。
# 红了立即停，先按「路径:行号:命中内容」处理，或在共享库里登记带理由的例外。
if [ "$CI_MIRROR" = "1" ]; then
  skip_notice "敏感信息预检" "脱敏镜像里没有 scripts/dev/ 与仓库级材料；主仓库合并前由这一步守门"
else
  step sensitive-scan
  if ! bash "$ROOT/scripts/dev/sensitive-scan.sh"; then
    fail "敏感信息预检未通过，后续阶段不跑。"
  fi
fi

# Node 版本是硬前提。package.json 声明 >=24，而 Node 26 的原生 localStorage
# 会遮蔽 jsdom 的，导致 11 个 client 测试假失败 —— 实测过，不是猜的。
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" != "24" ]; then
  printf '\n\033[33m[gate] 当前 Node %s，本项目基线是 24。\033[0m\n' "$(node -v)" >&2
  printf '  Node 26 的全局 localStorage 会遮蔽 jsdom 实现，client 测试会假失败。\n' >&2
  printf '  用 mise/nvm 切到 24 再跑：mise use node@24  或  nvm use\n' >&2
  fail "Node 版本不匹配（需要 24.x）"
fi

# 依赖是否装好。postinstall 会自动跑 nocobase skills sync。
if [ ! -d "$APP/node_modules" ]; then
  fail "app-local/node_modules 不存在，先在 app-local 下跑 pnpm install"
fi

# vitest worker 上限（R-055 / R-058）：本机留 4 核给桌面、至多 8，至少 2；
# CI 上不留核 —— 上限直接取核数（4 核 runner 就是 4），下限仍为 2。
# VITEST_MAX_WORKERS 仍可覆盖。生效值与核数都写进闸门输出与 verdict.json，
# 以后看一眼判据就知道有没有被钳位。
compute_vitest_workers() {
  GATE_RUNNER_CORES="$(getconf _NPROCESSORS_ONLN 2>/dev/null || nproc)"
  GATE_VITEST_WORKERS="${VITEST_MAX_WORKERS:-}"
  gate_on_ci=0
  if [ "${CI:-0}" = "true" ] || [ "${GITHUB_ACTIONS:-}" = "true" ]; then
    gate_on_ci=1
  fi
  if [ "$gate_on_ci" -eq 1 ]; then
    GATE_WORKER_MODE="CI 上不留核"
  else
    GATE_WORKER_MODE="本机留 4 核给桌面、至多 8"
  fi
  if [ -z "$GATE_VITEST_WORKERS" ]; then
    if [ "$gate_on_ci" -eq 1 ]; then
      GATE_VITEST_WORKERS="$GATE_RUNNER_CORES"
    else
      # 本机留 4 核给桌面（浏览器、IDE、13000 端口的开发服务器）。
      GATE_VITEST_WORKERS=$((GATE_RUNNER_CORES - 4))
    fi
    [ "$GATE_VITEST_WORKERS" -lt 2 ] && GATE_VITEST_WORKERS=2
    if [ "$gate_on_ci" -eq 0 ]; then
      [ "$GATE_VITEST_WORKERS" -gt 8 ] && GATE_VITEST_WORKERS=8
    fi
  else
    case "$GATE_VITEST_WORKERS" in
      ''|*[!0-9]*) fail "VITEST_MAX_WORKERS 必须是正整数，收到：$GATE_VITEST_WORKERS" ;;
    esac
    [ "$GATE_VITEST_WORKERS" -ge 1 ] || fail "VITEST_MAX_WORKERS 必须至少为 1"
  fi
}
compute_vitest_workers
printf '\n\033[36m[gate] vitest worker 上限：%s（runner %s 核；%s；至少 2；VITEST_MAX_WORKERS 可覆盖）\033[0m\n' \
  "$GATE_VITEST_WORKERS" "$GATE_RUNNER_CORES" "$GATE_WORKER_MODE"

run_stage() {
  local name="$1"
  shift
  step "$name"
  local started
  started="$(date +%s%3N 9>&-)"
  if "$@" 9>&-; then
    local ended
    ended="$(date +%s%3N 9>&-)"
    RESULTS+=("--result" "$name=passed:$((ended - started))")
  else
    local ended
    ended="$(date +%s%3N 9>&-)"
    RESULTS+=("--result" "$name=failed:$((ended - started))")
    FAILED=1
    printf '\n\033[31m[gate] 阶段失败：%s\033[0m\n' "$name" >&2
    # unit 阶段的阶段失败即终止；beta / docs 继续跑完以收集完整判据。
    if [ "$STAGE" = "unit" ]; then
      write_verdict
      exit 1
    fi
  fi
}

# 重阶段跨副本串行化（R-055）：锁绑在文件描述符上，进程退出（含 kill -9）时内核自动释放。
# 不用自建锁目录 —— 被杀的进程会留下死锁，要人工清理。等锁时每 30 秒报一次进度。
GATE_HEAVY_LOCK="${GATE_HEAVY_LOCK:-/tmp/hs-gate-heavy.lock}"
acquire_heavy_lock() {
  exec 9>"$GATE_HEAVY_LOCK" || fail "打不开重阶段锁：$GATE_HEAVY_LOCK"
  local waited=0
  while ! flock -n 9; do
    if [ $((waited % 30)) -eq 0 ]; then
      printf '\n\033[36m[gate] 在等另一个副本的闸门：已等 %d 秒\033[0m\n' "$waited"
    fi
    sleep 1
    waited=$((waited + 1))
  done
}

RESULTS=()
FAILED=0

# R-058 第二片：beta 档可凭上游单测线的判据跳过重复的 vitest。
# 三个输入都由 gate.yml 在下载判据产物后注入；缺任何一个就不启用。
# 核对规则只在 verdict.mjs 一处（readUpstreamUnit），这里只调用、不另算一遍。
# 证据缺失或对不上时 UPSTREAM_UNIT_READY 保持 0，下面照旧全跑 —— 宁可慢，不许假绿。
UPSTREAM_UNIT_READY=0
if [ "$STAGE" = "beta" ] && [ -n "${GATE_BETA_UPSTREAM_UNIT:-}" ]; then
  upstream_check="$(node "$ROOT/scripts/ci/verdict.mjs" \
    --check-upstream \
    --expect-commit "${GATE_EXPECTED_COMMIT:-}" \
    --upstream-unit "$GATE_BETA_UPSTREAM_UNIT" 9>&- 2>&1)"
  if [ $? -eq 0 ]; then
    UPSTREAM_UNIT_READY=1
    step upstream-unit-evidence
    printf '上游单测证据可用，跳过单测阶段：%s\n' "$upstream_check"
  else
    printf '\n\033[33m[gate] 上游单测证据不可用，beta 照旧全跑：%s\033[0m\n' "$upstream_check" >&2
  fi
fi

# 端到端里的稳定性测试要开浏览器。浏览器二进制不在依赖里，要单独装 —— `pnpm install` 不会带上它。
# 2026-11-25 第一次在 CI 上跑稳定性测试就缺了它：每条要开浏览器的测试各报一次「Executable doesn't exist」，
# 看不出是环境问题。所以在这里先查一次，缺了就明确失败。用法：require_e2e_browser <app-local 的路径>
require_e2e_browser() {
  local dir="$1"
  if ! (cd "$dir" && node -e "process.exit(require('node:fs').existsSync(require('@playwright/test').chromium.executablePath()) ? 0 : 1)"); then
    printf 'Playwright 的 Chromium 没装，先跑：pnpm exec playwright install chromium（CI 上带 --with-deps）\n' >&2
    return 1
  fi
}

# 整合测试：真的把应用起起来再跑 Playwright。
#
# 两个关键事实（实测得出，别再踩）：
#   1. `tests/fixtures/*.html` 只由 Vite 开发服务器提供，生产构建 dist/ 里没有。
#      所以整合测试必须跑在 `pnpm dev` 上，不能跑在 `pnpm start`（dist）上。
#   2. `pnpm dev` 拒绝在同一应用目录跑第二个实例（会抢迁移锁），
#      报「A development server for this application is already running」。
#      因此：已在跑就直接复用，没有才起一个，并在结束时只收掉自己起的那个。
run_e2e() {
  local log="$CI_DIR/e2e-server.log"
  local port="${E2E_PORT:-13000}"
  local base_path="${E2E_BASE_PATH:-/main}"
  local url="http://127.0.0.1:$port"
  # 健康检查在 base path 下，不是根路径。实测：/api/healthz 是 404，/main/api/healthz 才是 200。
  local healthz="$url$base_path/api/healthz"

  # Playwright 的包在依赖里，浏览器二进制不在。两样缺了都要明确提示，而不是让人猜为什么 e2e 红。
  if ! pnpm exec playwright --version >/dev/null 2>&1; then
    printf 'Playwright 未安装，先跑：pnpm exec playwright install chromium\n' >&2
    return 1
  fi
  require_e2e_browser "$APP" || return 1

  # 只清理自己造成的东西：自己起的 dev 进程、自己生成的 config.yml。
  # 不用 RETURN trap：本脚本有 set -u，trap 触发时 local 的作用域已结束，
  # 实测会报 "started_pid: 未绑定的变量" 并让闸门在写 verdict 前退出。改为显式收尾。
  local started_pid=""
  local created_config=""
  local e2e_status=0

  if curl -fsS "$healthz" >/dev/null 2>&1; then
    printf '复用已在运行的应用：%s%s/\n' "$url" "$base_path"
  else
    # config.yml 不入库（含密钥主键），所以干净的 CI 克隆里没有配置，应用会拒绝启动。
    # 整合测试必须自己能配置起来，否则本地绿、CI 红。这里按 config.example.yml 生成一份
    # 仅供本次运行使用的配置，跑完在函数末尾删掉。
    if [ ! -f config.yml ] && [ ! -f config.yaml ] && [ ! -f config.toml ] && [ ! -f config.json ]; then
      printf '生成临时配置（config.yml 不入库）\n'
      pnpm nocobase config init --dialect "${E2E_DB_DIALECT:-postgres}" --json >/dev/null ||
        { printf 'config init 失败\n' >&2; return 1; }
      pnpm nocobase config set \
        database.connections.main.host="${POSTGRES_HOST:-127.0.0.1}" \
        database.connections.main.port="${POSTGRES_PORT:-5432}" \
        database.connections.main.database="${POSTGRES_DATABASE:-hs_erp_test}" \
        database.connections.main.username="${POSTGRES_USER:-hs_erp}" \
        --json >/dev/null || { printf 'config set 失败\n' >&2; return 1; }
      pnpm nocobase config set --from-env \
        database.connections.main.password=POSTGRES_PASSWORD --json >/dev/null 2>&1 || true
      pnpm nocobase config check --json >/dev/null ||
        { printf 'config check 失败，配置不完整\n' >&2; return 1; }
      created_config=1
    fi

    printf '启动开发服务器用于整合测试：%s%s/\n' "$url" "$base_path"
    APP_BASE_PATH="$base_path" APP_SERVER_PORT="$port" pnpm dev >"$log" 2>&1 &
    started_pid=$!
  fi

  local waited=0
  until curl -fsS "$healthz" >/dev/null 2>&1; do
    if [ -n "$started_pid" ] && ! kill -0 "$started_pid" 2>/dev/null; then
      printf '开发服务器启动即退出，日志尾部：\n' >&2
      tail -30 "$log" >&2
      e2e_status=1
      break
    fi
    if [ "$waited" -ge 240 ]; then
      printf '等待应用就绪超时（240s），日志尾部：\n' >&2
      tail -30 "$log" 2>/dev/null >&2
      e2e_status=1
      break
    fi
    sleep 2
    waited=$((waited + 2))
  done

  if [ "$e2e_status" -eq 0 ]; then
    # 只跑业务整合测试和稳定性测试。模板自带的 tests/playwright/{dialog-footer,permission-alignment}
    # 是对 fixture HTML 的视觉校验，与应用业务无关，且它们的 HTML 用绝对路径 /tests/...
    # 引用 tsx，在 /main 挂载下会 502 —— 已知坏，不纳入闸门。
    APP_URL="$url" APP_BASE_PATH="$base_path" \
      pnpm exec playwright test tests/playwright/fqc-pipeline.test.ts tests/playwright/stability tests/playwright/departments.test.ts --pass-with-no-tests || e2e_status=1
  fi

  # 显式收尾，只清理自己造成的东西。
  if [ -n "$started_pid" ]; then
    kill "$started_pid" 2>/dev/null || true
  fi
  if [ -n "$created_config" ]; then
    rm -f config.yml
    printf '已删除临时配置 config.yml\n'
  fi

  return "$e2e_status"
}

write_verdict() {
  local -a skip_args=() name
  for name in "${SKIPPED_STAGES[@]+"${SKIPPED_STAGES[@]}"}"; do
    skip_args+=(--skip "$name")
  done
  # 继承上游单测证据时把路径、产物名、期望提交交给 verdict.mjs，由它写出 provenance。
  local -a upstream_args=()
  if [ "$UPSTREAM_UNIT_READY" -eq 1 ]; then
    upstream_args=(
      --upstream-unit "$GATE_BETA_UPSTREAM_UNIT"
      --expect-commit "${GATE_EXPECTED_COMMIT:-}"
      --upstream-artifact "${GATE_UPSTREAM_ARTIFACT:-}"
    )
  fi
  # 单测线上传的紧凑摘要：仅 CI 打开，本地不开开关时行为逐字节不变。
  local -a summary_args=()
  if [ "$STAGE" = "unit" ] && [ "${GATE_UNIT_SUMMARY:-0}" = "1" ]; then
    summary_args=(--summary-out "$CI_DIR/verdict-summary.json")
  fi
  # R-059：测试阶段结束后再读一次测试库启动时刻。只提示，不改退出码、不把红判成绿。
  # CI 上不做容器核对（TEST_DB_CHECKED=0），这条分支保持原样。
  if [ "$TEST_DB_CHECKED" -eq 1 ]; then
    bash "$ROOT/scripts/ci/test-db-restart-check.sh" || true
  fi
  node "$ROOT/scripts/ci/verdict.mjs" \
    --stage "$STAGE" \
    --out "$CI_DIR/verdict.json" \
    --vitest-max-workers "$GATE_VITEST_WORKERS" \
    --cores "$GATE_RUNNER_CORES" \
    "${skip_args[@]+"${skip_args[@]}"}" \
    "${upstream_args[@]+"${upstream_args[@]}"}" \
    "${summary_args[@]+"${summary_args[@]}"}" \
    "${RESULTS[@]+"${RESULTS[@]}"}" \
    9>&-
}

# 组件复用检查（R-039 第三道门）：框架自带的 check-ui-components.mjs。
#
# 脚本不在版本库里：`.agents/skills/` 由 `pnpm install` 的 postinstall（nocobase skills sync）
# 按 lockfile 重建。所以脚本不在时必须**明确失败**并说明原因 —— 没跑就等于没查，
# 不能当成通过。退出码 1（有发现）与 2（扫描不完整）都算失败。
#
# 用法：run_component_check changed|all
#   changed —— 只查 git 改动过的客户端文件（fast 档）
#   all     —— 全量扫 client/（unit 档；实测约 2 秒，放得下）
run_component_check() {
  local mode="${1:-changed}"
  local checker="$APP/.agents/skills/nocobase-app-development/scripts/check-ui-components.mjs"
  if [ ! -f "$checker" ]; then
    printf '\n[gate] 组件复用检查脚本不存在：%s\n' "$checker" >&2
    printf '  它由 pnpm install 的 postinstall（nocobase skills sync）按 lockfile 生成，不入库。\n' >&2
    printf '  先装好依赖再跑闸门；缺脚本不是通过。\n' >&2
    return 1
  fi

  local -a sources=()
  if [ "$mode" = "changed" ]; then
    local file
    while IFS= read -r file; do
      case "$file" in
        # shadcn 的 primitive 按 CLI 生成的样子原样保留，是例外。
        app-local/client/components/ui/*) continue ;;
        app-local/client/*.ts | app-local/client/*.tsx) ;;
        *) continue ;;
      esac
      # 删除或重命名的旧路径不交给脚本（它只接受存在的文件）。
      [ -f "$APP/${file#app-local/}" ] || continue
      sources+=("${file#app-local/}")
    done < <(
      {
        git -C "$ROOT" diff --name-only --diff-filter=d HEAD -- app-local/client
        git -C "$ROOT" ls-files --others --exclude-standard -- app-local/client
      } 2>/dev/null | sort -u
    )
    if [ "${#sources[@]}" -eq 0 ]; then
      printf '没有改动过的客户端文件，组件复用检查跳过（全量检查在 unit 档）。\n'
      return 0
    fi
  fi

  local started ended status
  started="$(date +%s%3N 9>&-)"
  if [ "$mode" = "all" ]; then
    node "$checker" --root . || status=$?
  else
    node "$checker" --root . "${sources[@]}" || status=$?
  fi
  ended="$(date +%s%3N 9>&-)"
  case "${status:-0}" in
    0)
      printf '组件复用检查通过（%s，%d 毫秒）。\n' "$mode" "$((ended - started))"
      ;;
    1)
      printf '组件复用检查有发现（退出码 1），按失败处理。\n' >&2
      return 1
      ;;
    2)
      printf '组件复用检查没有扫完（退出码 2），按失败处理。\n' >&2
      return 1
      ;;
    *)
      printf '组件复用检查异常退出（退出码 %s）。\n' "$status" >&2
      return 1
      ;;
  esac
}

# 流程合规审计：确定性检查，不含 LLM。
#
# 用户是裁决角色，过程不参与，只看测试与反馈。前提是决策链到实行链条可追。
# 这个阶段检查可机械判定的部分：状态过设计门必须有设计文档且四要素齐备、
# 有文档必须被提交或测试引用、测试引用的编号必须存在、跟进记录必须覆盖。
#
# 「理由站不站得住」这类语义判断交给 scripts/compliance/pi-auditor.sh，且不进闸门 ——
# 门禁只认确定性事实。
run_compliance() {
  local report
  report="$(node "$ROOT/scripts/compliance/audit.mjs" 2>&1)"
  local summary
  summary="$(printf '%s\n' "$report" | grep -E '^需求 .* error ' | tail -1)"

  if [ -z "$summary" ]; then
    printf '合规审计未产出汇总行，报告如下：\n%s\n' "$report" >&2
    return 1
  fi
  printf '%s\n' "$summary"

  local errors
  errors="$(printf '%s' "$summary" | sed -nE 's/.*\/ error ([0-9]+) .*/\1/p')"
  if [ "${errors:-0}" != "0" ]; then
    printf '\n有合规 error，必须修复：\n' >&2
    printf '%s\n' "$report" | sed -n '/## Error/,/## Warning/p' >&2
    return 1
  fi
  return 0
}

# 证据校验。
#
# 注意：check_evidence.py 的退出码恒为 0（它自己的 docstring 写着
# "The exit code carries no information; the report is the interface."），
# 所以直接跑它永远不会让闸门变红 —— 这个阶段曾经是个摆设。
#
# 这里改成解析报告末尾的 Summary 行，只把两类当作失败：
#   - evidence error（文章缺 Raw 字段、链接失效、链接逃出 raw/）
#   - unreferenced raw（raw 里有文件没有任何文章引用）
#
# fidelity suspect 不算失败：脚本明确说那是「判断是读者的责任」，
# 派生值、专有名词、故意改写都会出现在里面。ADR 编号这类内部标识符也会，
# 那是合理误报。要人看，不要机器判。
check_evidence() {
  local report
  report="$(python3 "$ROOT/.agents/skills/karpathy-llm-wiki/scripts/check_evidence.py" "$ROOT" 2>&1)"
  local summary
  summary="$(printf '%s\n' "$report" | grep -E '^[0-9]+ fidelity suspect' | tail -1)"

  if [ -z "$summary" ]; then
    printf '证据校验未产出 Summary 行，报告如下：\n%s\n' "$report" >&2
    return 1
  fi

  local errors orphans
  errors="$(printf '%s' "$summary" | sed -nE 's/.*, ([0-9]+) evidence error.*/\1/p')"
  orphans="$(printf '%s' "$summary" | sed -nE 's/.*, ([0-9]+) unreferenced raw file.*/\1/p')"

  printf '证据校验：%s\n' "$summary"
  printf '（fidelity suspect 仅供人工判断，不阻断闸门）\n'

  if [ "${errors:-0}" != "0" ]; then
    printf '\n有 evidence error，必须修复：\n' >&2
    printf '%s\n' "$report" | sed -n '/## Evidence errors/,/## Unreferenced/p' >&2
    return 1
  fi
  if [ "${orphans:-0}" != "0" ]; then
    printf '\n有未被引用的 raw 文件，必须处理：\n' >&2
    printf '%s\n' "$report" | sed -n '/## Unreferenced raw files/,$p' >&2
    return 1
  fi
  return 0
}

# 测试只连 Postgres：与生产同方言，迁移与并发缺陷才不会漏到上线。
# 显式设成别的方言（尤其 sqlite）直接报错，不给 SQLite 线留后门。
if [ -n "${NOCOBASE_TEST_DB_DIALECT:-}" ] && [ "$NOCOBASE_TEST_DB_DIALECT" != "postgres" ]; then
  fail "测试只连 Postgres；NOCOBASE_TEST_DB_DIALECT=$NOCOBASE_TEST_DB_DIALECT 不被接受。"
fi
export NOCOBASE_TEST_DB_DIALECT=postgres

# 本地容器检查只对真正连库的档位；docs 档不连库，CI 的连接由工作流注入的变量保证。
# fast 档按改动路径判断：动过测试或应用代码才查，只改文档不查（R-056 收尾第 4 点）。
need_test_db=0
case "$STAGE" in
  unit|beta|all) need_test_db=1 ;;
  fast)
    if "$ROOT/scripts/ci/changed-needs-db.sh" "$ROOT"; then need_test_db=1; fi
    ;;
esac
# 时刻文件在本轮自己的目录里，不互相清；不核对的档位也不会写 testDb。
if [ "$need_test_db" -eq 1 ]; then
  if [ -z "${POSTGRES_HOST:-}" ] && [ "${CI:-0}" != "true" ] && [ "${GITHUB_ACTIONS:-}" != "true" ]; then
    "$ROOT/scripts/ci/test-pg-check.sh" || exit 1
    TEST_DB_CHECKED=1
    export TEST_DB_CHECKED
  fi
else
  # 不连库的档位给配置层一个显式信号：只定方言、缺参数不报错，但不回落 SQLite。
  export NOCOBASE_DOCS_ONLY=1
fi

cd "$APP" || fail "进不去 app-local"

# fast 档：只跑选出来的测试 + 文档守门。
# R-084：选哪些测试由 scripts/ci/select-tests.mjs 决定 —— 改动集按相对主线的差异
# 加未提交改动算（提交前后同一份集合），先取依赖闭包，超上限回落到模块映射。
# 用途是日常迭代的快速反馈 —— 本地 unit 要 110s，fast 应远快于此。
# **提交前仍必须跑 unit**：依赖闭包只覆盖直接关联，模块映射也可能漏跨模块测试。
if [ "$STAGE" = "fast" ]; then
  step select-tests
  if ! node "$ROOT/scripts/ci/select-tests.mjs" --root "$ROOT" --out "$CI_DIR/selected-tests.json"; then
    fail "选测试失败：模块映射之外有新文件路径，或依赖集合取不到。"
  fi
  read_selected() {
    node -e '
      const fs = require("node:fs");
      const data = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      for (const value of data[process.argv[2]] ?? []) console.log(value);
    ' "$CI_DIR/selected-tests.json" "$1"
  }

  # lint 只查这次改动的 JS/TS 文件；一个都没改就从判据计划里摘掉，全量留给 unit。
  mapfile -t fast_lint_files < <(read_selected lintFiles)
  if [ "${#fast_lint_files[@]}" -gt 0 ]; then
    run_stage lint pnpm exec eslint --max-warnings 0 "${fast_lint_files[@]}"
  else
    skip_stage "lint" "本次没有改动的 JS/TS 文件（全量 lint 在 unit 档）"
  fi
  run_stage component-check run_component_check changed
  step test
  started="$(date +%s%3N 9>&-)"
  rm -f "$CI_DIR/vitest.json"
  # 两个集合都要跑：
  #   1. 选出来的测试（精确集合或模块映射）
  #   2. 快信道的守门测试：文档守门四个（查 wiki/ 与 HANDOFF，
  #      选测试按路径映射关联不到它们）与样式守门（R-039 第一道门，
  #      扫 client/ 与改动文件无关）。
  # 已不再用 vitest 的旧改动过滤开关：它只认未提交改动，且与显式文件混跑会过滤掉守门。
  mapfile -t fast_tests < <(read_selected tests)
  if [ "${#fast_tests[@]}" -eq 0 ]; then
    # 纯文档改动：第一份报告要产出「0 条」，不能因为没给文件参数而跑成全量。
    fast_tests=("tests/__r084_no_tests__")
  fi
  fast_ok=1
  pnpm exec vitest run --maxWorkers="$GATE_VITEST_WORKERS" "${fast_tests[@]}" --reporter=default \
    --reporter=json --outputFile.json="$CI_DIR/vitest-fast-changed.json" 9>&- \
    || fast_ok=0
  # 镜像里没有仓库级文档，四个文档守门不在导出树里，跳过；样式守门扫的是
  # app-local/client 的代码，两仓都照跑。
  guards=()
  if [ "$CI_MIRROR" = "1" ]; then
    skip_notice "文档守门" "wiki/ 与 HANDOFF.md 不在脱敏镜像里"
  else
    guards=(
      tests/project/handoff-freshness.test.ts
      tests/project/compliance-audit.test.ts
      tests/project/timestamp-precision.test.ts
      tests/project/mermaid-only.test.ts
    )
  fi
  pnpm exec vitest run --maxWorkers="$GATE_VITEST_WORKERS" --reporter=default --reporter=json \
    --outputFile.json="$CI_DIR/vitest-fast-guards.json" \
    tests/project/frontend-style-guard.test.ts \
    "${guards[@]+"${guards[@]}"}" 9>&- \
    || fast_ok=0
  # 合并两份计数，避免 verdict 从旧文件读到假的 811。
  node "$ROOT/scripts/ci/merge-test-reports.mjs" \
    "$CI_DIR/vitest-fast-changed.json" "$CI_DIR/vitest-fast-guards.json" \
    "$CI_DIR/vitest.json" || fast_ok=0
  if [ "$fast_ok" -eq 1 ]; then
    RESULTS+=("--result" "test=passed:$(( $(date +%s%3N 9>&-) - started ))")
  else
    RESULTS+=("--result" "test=failed:$(( $(date +%s%3N 9>&-) - started ))")
    FAILED=1
  fi
  write_verdict || exit 1
  [ "$FAILED" -eq 0 ] || exit 1
  exit 0
fi

# docs 档：只改了文档的推送走这一档 —— 文档守门（tests/project 那一组）、证据、合规。
# 单测线与 beta 基线对一次只改文档的推送给不出新信息，却要占二十多分钟；
# 这不是不查文档：文档守门、证据、合规查的正是文档会出错的地方。
# 触发条件由 .github/workflows/gate.yml 的 changes job 按改动的文件判定。
if [ "$STAGE" = "docs" ]; then
  if [ "$CI_MIRROR" = "1" ]; then
    rm -f "$CI_DIR/vitest.json"
    skip_stage "test" "文档快道不在脱敏镜像里跑"
    skip_stage "evidence" "证据校验要读 wiki/ 与 raw/"
    skip_stage "compliance" "合规审计要读 .agents/ 与 wiki/"
    write_verdict || exit 1
    exit 0
  fi
  step test
  started="$(date +%s%3N 9>&-)"
  rm -f "$CI_DIR/vitest.json"
  if pnpm exec vitest run --maxWorkers="$GATE_VITEST_WORKERS" --reporter=default --reporter=json \
    --outputFile.json="$CI_DIR/vitest.json" tests/project 9>&-; then
    RESULTS+=("--result" "test=passed:$(( $(date +%s%3N 9>&-) - started ))")
  else
    RESULTS+=("--result" "test=failed:$(( $(date +%s%3N 9>&-) - started ))")
    FAILED=1
  fi
  run_stage evidence check_evidence
  run_stage compliance run_compliance
  write_verdict || exit 1
  [ "$FAILED" -eq 0 ] || exit 1
  exit 0
fi

# 重阶段从这里开始排队：fast / docs 在前面已经 exit
acquire_heavy_lock

run_stage lint pnpm lint
run_stage typecheck pnpm typecheck
# 全量组件复用检查：实测约 2 秒，放得进 unit（设计上限 10 秒）。
run_stage component-check run_component_check all

# 单测：同时产出 JSON 报告，供 verdict.mjs 统计通过/失败数。
# R-058 第二片：证据齐全时跳过这一段 —— 它和上游单测线是同一套测试、同一个提交。
# test 阶段的状态与 provenance 由 verdict.mjs 从上游证据写入，gate.sh 不自己算判据。
if [ "$UPSTREAM_UNIT_READY" -eq 1 ]; then
  skip_notice "test" "继承上游单测线判据 ${GATE_UPSTREAM_ARTIFACT:-上游产物}（verdict.mjs 写明 provenance）"
else
  step test
  started="$(date +%s%3N 9>&-)"
  if pnpm exec vitest run --maxWorkers="$GATE_VITEST_WORKERS" --reporter=default --reporter=json --outputFile.json="$CI_DIR/vitest.json" 9>&-; then
    RESULTS+=("--result" "test=passed:$(( $(date +%s%3N 9>&-) - started ))")
  else
    RESULTS+=("--result" "test=failed:$(( $(date +%s%3N 9>&-) - started ))")
    FAILED=1
    if [ "$STAGE" = "unit" ]; then
      write_verdict
      exit 1
    fi
  fi
fi

if [ "$STAGE" = "beta" ] || [ "$STAGE" = "all" ]; then
  run_stage build pnpm build
  run_stage e2e run_e2e
fi

if [ "$STAGE" = "all" ]; then
  if [ "$CI_MIRROR" = "1" ]; then
    skip_stage "evidence" "证据校验要读 wiki/ 与 raw/"
    skip_stage "compliance" "合规审计要读 .agents/ 与 wiki/"
  else
    run_stage evidence check_evidence
    # 流程合规：需求状态、设计文档、追溯、跟进四项一致性。
    run_stage compliance run_compliance
  fi
fi

write_verdict || exit 1

if [ "$FAILED" -ne 0 ]; then
  exit 1
fi
