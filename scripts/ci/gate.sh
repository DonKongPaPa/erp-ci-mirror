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

mkdir -p "$CI_DIR"

fail() {
  printf '\n\033[31m[gate] %s\033[0m\n' "$1" >&2
  exit 1
}

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

run_stage() {
  local name="$1"
  shift
  step "$name"
  local started
  started="$(date +%s%3N)"
  if "$@"; then
    local ended
    ended="$(date +%s%3N)"
    RESULTS+=("--result" "$name=passed:$((ended - started))")
  else
    local ended
    ended="$(date +%s%3N)"
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

RESULTS=()
FAILED=0

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
  node "$ROOT/scripts/ci/verdict.mjs" \
    --stage "$STAGE" \
    --out "$CI_DIR/verdict.json" \
    "${skip_args[@]+"${skip_args[@]}"}" \
    "${RESULTS[@]+"${RESULTS[@]}"}"
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
  started="$(date +%s%3N)"
  if [ "$mode" = "all" ]; then
    node "$checker" --root . || status=$?
  else
    node "$checker" --root . "${sources[@]}" || status=$?
  fi
  ended="$(date +%s%3N)"
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

# 数据库方言：测试库优先用 Postgres（与生产同方言，迁移缺陷才不会漏到上线）。
# 没有提供连接信息时回落到 SQLite —— 这是 NocoBase 测试栈的默认行为。
export NOCOBASE_TEST_DB_DIALECT="${NOCOBASE_TEST_DB_DIALECT:-postgres}"
if [ "$NOCOBASE_TEST_DB_DIALECT" = "postgres" ] && [ -z "${POSTGRES_HOST:-}" ]; then
  printf '\n\033[33m[gate] 未设置 POSTGRES_HOST，测试库回落 SQLite。\033[0m\n' >&2
  printf '  Postgres 能覆盖 SQLite 覆盖不到的类型与索引差异，CI 上必须用 Postgres。\n' >&2
  export NOCOBASE_TEST_DB_DIALECT=sqlite
fi

cd "$APP" || fail "进不去 app-local"

# fast 档：只跑受改动影响的测试 + 文档守门。
# 用途是日常迭代的快速反馈 —— 本地 unit 要 110s，fast 约 20-40s。
# **提交前仍必须跑 unit**：--changed 只看 git 有改动的文件，
# 漏掉间接依赖（例如改了共享类型但某个测试没直接 import）是可能的。
if [ "$STAGE" = "fast" ]; then
  run_stage lint pnpm lint
  run_stage component-check run_component_check changed
  step test
  started="$(date +%s%3N)"
  rm -f "$CI_DIR/vitest.json"
  # 两个集合都要跑：
  #   1. 受 git 改动影响的测试（--changed）
  #   2. 快信道的守门测试：文档守门四个（查 wiki/ 与 HANDOFF，
  #      --changed 对 md 改动关联不到它们）与样式守门（R-039 第一道门，
  #      扫 client/ 与改动文件无关）。
  # 用 --changed 与显式文件混跑会让 vitest 只按 changed 过滤，所以分两次：
  fast_ok=1
  pnpm exec vitest run --changed --reporter=default \
    --reporter=json --outputFile.json="$CI_DIR/vitest-fast-changed.json" \
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
  pnpm exec vitest run --reporter=default --reporter=json \
    --outputFile.json="$CI_DIR/vitest-fast-guards.json" \
    tests/project/frontend-style-guard.test.ts \
    "${guards[@]+"${guards[@]}"}" \
    || fast_ok=0
  # 合并两份计数，避免 verdict 从旧文件读到假的 811。
  node "$ROOT/scripts/ci/merge-test-reports.mjs" \
    "$CI_DIR/vitest-fast-changed.json" "$CI_DIR/vitest-fast-guards.json" \
    "$CI_DIR/vitest.json" || fast_ok=0
  if [ "$fast_ok" -eq 1 ]; then
    RESULTS+=("--result" "test=passed:$(( $(date +%s%3N) - started ))")
  else
    RESULTS+=("--result" "test=failed:$(( $(date +%s%3N) - started ))")
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
  started="$(date +%s%3N)"
  rm -f "$CI_DIR/vitest.json"
  if pnpm exec vitest run --reporter=default --reporter=json \
    --outputFile.json="$CI_DIR/vitest.json" tests/project; then
    RESULTS+=("--result" "test=passed:$(( $(date +%s%3N) - started ))")
  else
    RESULTS+=("--result" "test=failed:$(( $(date +%s%3N) - started ))")
    FAILED=1
  fi
  run_stage evidence check_evidence
  run_stage compliance run_compliance
  write_verdict || exit 1
  [ "$FAILED" -eq 0 ] || exit 1
  exit 0
fi

run_stage lint pnpm lint
run_stage typecheck pnpm typecheck
# 全量组件复用检查：实测约 2 秒，放得进 unit（设计上限 10 秒）。
run_stage component-check run_component_check all

# 单测：同时产出 JSON 报告，供 verdict.mjs 统计通过/失败数。
step test
started="$(date +%s%3N)"
if pnpm exec vitest run --reporter=default --reporter=json --outputFile.json="$CI_DIR/vitest.json"; then
  RESULTS+=("--result" "test=passed:$(( $(date +%s%3N) - started ))")
else
  RESULTS+=("--result" "test=failed:$(( $(date +%s%3N) - started ))")
  FAILED=1
  if [ "$STAGE" = "unit" ]; then
    write_verdict
    exit 1
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
