import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '../../..',
);
const gate = readFileSync(
  path.join(repoRoot, 'scripts', 'ci', 'gate.sh'),
  'utf8',
);

/**
 * gate.sh 里算 vitest worker 上限的那一段。单独取算法本身（不含打印那一行），
 * 用假的 nproc / getconf 与环境变量真跑一遍 —— 静态字符串匹配守不住算错的情况。
 */
function workerAlgorithm(): string {
  const start = gate.indexOf('# vitest worker 上限（R-055');
  expect(start, 'gate.sh 里找不到 worker 上限算法。').toBeGreaterThan(-1);
  const end = gate.indexOf('printf \'\\n\\033[36m[gate] vitest worker 上限', start);
  expect(end, 'worker 上限算法的打印行找不到。').toBeGreaterThan(start);
  return gate.slice(start, end);
}

type WorkerCase = {
  cores: number;
  ci?: boolean;
  githubActions?: boolean;
  override?: string;
};

function runWorkerAlgorithm(options: WorkerCase) {
  const fakeBin = mkdtempSync(path.join(tmpdir(), 'r058-fakebin-'));
  try {
    writeFileSync(path.join(fakeBin, 'nproc'), `#!/bin/sh\necho ${options.cores}\n`, {
      mode: 0o755,
    });
    // getconf 在假 PATH 里总是失败，逼算法走 nproc 那条支路。
    writeFileSync(path.join(fakeBin, 'getconf'), '#!/bin/sh\nexit 1\n', {
      mode: 0o755,
    });
    const env = { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ''}` };
    delete env.CI;
    delete env.GITHUB_ACTIONS;
    delete env.VITEST_MAX_WORKERS;
    if (options.ci) env.CI = 'true';
    if (options.githubActions) env.GITHUB_ACTIONS = 'true';
    if (options.override !== undefined) env.VITEST_MAX_WORKERS = options.override;
    const script = [
      'set -uo pipefail',
      'GATE_VITEST_WORKERS=""',
      'GATE_RUNNER_CORES=""',
      'fail() { printf "FAIL: %s\\n" "$1" >&2; exit 9; }',
      workerAlgorithm(),
      'printf "%s|%s\\n" "${GATE_VITEST_WORKERS:-}" "${GATE_RUNNER_CORES:-}"',
    ].join('\n');
    const result = spawnSync('bash', ['-c', script], { encoding: 'utf8', env });
    return {
      status: result.status,
      output: `${result.stdout}${result.stderr}`.trim(),
    };
  } finally {
    rmSync(fakeBin, { recursive: true, force: true });
  }
}

/**
 * R-055 闸门的并发治理：多个副本同时跑重阶段会把共享的 16 核机器压满。
 * 这组测试守的是脚本层面的契约 —— 锁覆盖哪些档、等待怎么报、worker 上限怎么传。
 * 真实的两副本串行、kill -9 不留死锁由验收实录覆盖（见 R-055 设计文档）。
 * R-058 第一片把 worker 上限改成本机 / CI 两套算法，下面的行为测试用假核数真跑它。
 */
describe('gate.sh 并发治理（R-055 / R-058）', () => {
  it('serializes heavy stages with a shared flock lock', () => {
    expect(
      gate.includes('GATE_HEAVY_LOCK="${GATE_HEAVY_LOCK:-/tmp/hs-gate-heavy.lock}"'),
      '重阶段要用跨副本共用的固定锁文件，不能用每个副本各自的锁。',
    ).toBe(true);
    expect(
      gate.includes('exec 9>"$GATE_HEAVY_LOCK"'),
      '锁必须绑在文件描述符上，进程退出（含 kill -9）时由内核释放。',
    ).toBe(true);
    expect(gate.includes('flock -n 9'), '必须用 flock 抢锁，不能用自建锁目录。').toBe(true);
  });

  it('keeps fast and docs out of the lock and locks before the heavy stages', () => {
    const callAnchor =
      '# 重阶段从这里开始排队：fast / docs 在前面已经 exit\nacquire_heavy_lock';
    // 锚点找不到时 indexOf 返回 -1，直接 slice 会得到空串、让下面的 not.toContain 恒真。
    // 先把三个锚点的位置守住，再按位置切片（R-055 的 fast / docs 早退契约）。
    const fastIdx = gate.indexOf('if [ "$STAGE" = "fast" ]');
    const docsIdx = gate.indexOf('if [ "$STAGE" = "docs" ]', fastIdx + 1);
    const callIdx = gate.indexOf(callAnchor, docsIdx + 1);
    expect(fastIdx, 'gate.sh 里找不到 fast 档早退分支。').toBeGreaterThan(-1);
    expect(docsIdx, 'gate.sh 里找不到 docs 档早退分支。').toBeGreaterThan(fastIdx);
    expect(callIdx, '抢锁的调用点必须在 fast / docs 的早退之后。').toBeGreaterThan(docsIdx);
    const fastBlock = gate.slice(fastIdx, docsIdx);
    expect(
      fastBlock.includes('acquire_heavy_lock'),
      'fast 档是快速反馈，不能也去排队。',
    ).toBe(false);
    const docsBlock = gate.slice(docsIdx, callIdx);
    expect(
      docsBlock.includes('acquire_heavy_lock'),
      'docs 档只跑项目组测试与两个扫描，不入锁。',
    ).toBe(false);
    expect(
      gate.includes(
        'acquire_heavy_lock\n\nrun_stage lint pnpm lint\nrun_stage typecheck pnpm typecheck',
      ),
      '重阶段的 lint 与 typecheck 必须在抢到锁之后才开始。',
    ).toBe(true);
  });

  it('reports wait progress every 30 seconds', () => {
    expect(
      gate.includes('在等另一个副本的闸门：已等 %d 秒'),
      '等待时必须打印进度行，让用户知道闸门在排队而不是卡死。',
    ).toBe(true);
    expect(gate.includes('waited % 30'), '进度行必须每 30 秒一行。').toBe(true);
    expect(gate.includes('sleep 1'), '抢锁失败后要短睡再试，不能忙等。').toBe(true);
  });

  it('releases the lock on process exit by binding it to a descriptor', () => {
    expect(
      gate.includes('exec 9>"$GATE_HEAVY_LOCK"'),
      '只有绑在描述符上的 flock 才会被内核在进程退出时释放。',
    ).toBe(true);
    expect(
      gate.includes('mkdir "$GATE_HEAVY_LOCK"'),
      '不能改成自建锁目录 —— 被 kill -9 时会留下死锁。',
    ).toBe(false);
  });

  it('caps workers locally but not on CI, floor 2, with an override', () => {
    expect(
      gate.includes('${VITEST_MAX_WORKERS:-}'),
      '必须留 VITEST_MAX_WORKERS 给 CI 覆盖。',
    ).toBe(true);
    expect(
      gate.includes('本机留 4 核给桌面'),
      '本机必须留 4 核给桌面（R-055 的初衷不变）。',
    ).toBe(true);
    expect(gate.includes('CI 上不留核'), 'CI 上不能留核给桌面。').toBe(true);
    expect(
      gate.includes('GATE_VITEST_WORKERS=$((GATE_RUNNER_CORES - 4))'),
      '本机默认必须是核数减 4。',
    ).toBe(true);
    expect(
      gate.includes('GATE_VITEST_WORKERS="$GATE_RUNNER_CORES"'),
      'CI 默认必须直接取核数，不再减 4。',
    ).toBe(true);
    expect(
      gate.includes('[ "$GATE_VITEST_WORKERS" -lt 2 ]'),
      'worker 数至少 2，不能低到失去并发。',
    ).toBe(true);
    const ciBranch = gate.slice(
      gate.indexOf('if [ "${CI:-0}" = "true" ]'),
      gate.indexOf('[ "$GATE_VITEST_WORKERS" -lt 2 ]'),
    );
    expect(
      ciBranch.includes('-gt 8'),
      '本机至多 8 的绝对上限不能套到 CI 的核数上。',
    ).toBe(false);
  });

  it('本机 16 核 → 8：留 4 核给桌面、至多 8', () => {
    const result = runWorkerAlgorithm({ cores: 16 });
    expect(result.status, `脚本退出 ${result.status}；${result.output}`).toBe(0);
    expect(result.output, '期望 worker=8、核数=16').toBe('8|16');
  });

  it('本机 6 核 → 2：下限照旧钳住', () => {
    const result = runWorkerAlgorithm({ cores: 6 });
    expect(result.status, `脚本退出 ${result.status}；${result.output}`).toBe(0);
    expect(result.output, '期望 worker=2、核数=6').toBe('2|6');
  });

  it('CI 4 核 → 4：CI=true 与 GITHUB_ACTIONS=true 都不留核', () => {
    for (const options of [{ cores: 4, ci: true }, { cores: 4, githubActions: true }]) {
      const result = runWorkerAlgorithm(options);
      expect(result.status, `脚本退出 ${result.status}；${result.output}`).toBe(0);
      expect(result.output, '期望 worker=4、核数=4').toBe('4|4');
    }
  });

  it('显式 VITEST_MAX_WORKERS=3 → 3', () => {
    const result = runWorkerAlgorithm({ cores: 16, override: '3' });
    expect(result.status, `脚本退出 ${result.status}；${result.output}`).toBe(0);
    expect(result.output, '显式覆盖优先，核数仍写进判据').toBe('3|16');
  });

  it('verdict.json 记下生效的 worker 上限与核数', () => {
    const outDir = mkdtempSync(path.join(tmpdir(), 'r058-verdict-'));
    try {
      const out = path.join(outDir, 'verdict.json');
      const result = spawnSync(
        process.execPath,
        [
          path.join(repoRoot, 'scripts', 'ci', 'verdict.mjs'),
          '--stage', 'fast',
          '--out', out,
          '--vitest-max-workers', '4',
          '--cores', '4',
          '--result', 'lint=passed:1',
          '--result', 'component-check=passed:1',
          '--result', 'test=passed:1',
        ],
        { encoding: 'utf8' },
      );
      expect(result.status, `verdict.mjs 退出 ${result.status}；${result.stderr}`).toBe(0);
      const verdict = JSON.parse(readFileSync(out, 'utf8')) as {
        runner: { vitestMaxWorkers?: number; cores?: number };
      };
      expect(verdict.runner.vitestMaxWorkers).toBe(4);
      expect(verdict.runner.cores).toBe(4);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  it('does not leak the lock descriptor to child processes', () => {
    expect(
      gate.includes('if "$@" 9>&-; then'),
      'run_stage 启动的子进程不能继承锁描述符，否则闸门被 kill -9 后锁会被子进程继续持有。',
    ).toBe(true);
    expect(
      gate.includes('--outputFile.json="$CI_DIR/vitest.json" 9>&-; then'),
      '全量单测进程也不能继承锁描述符。',
    ).toBe(true);
    expect(
      (gate.match(/9>&-/gu) ?? []).length,
      'lint、typecheck、组件检查、vitest、verdict 等子进程都要关掉锁描述符。',
    ).toBeGreaterThanOrEqual(8);
  });

  it('passes the cap to every vitest run', () => {
    const runs = [...gate.matchAll(/pnpm exec vitest run[^\n]*/gu)].map((m) => m[0]);
    expect(
      runs.length,
      'fast 档两次、docs 档一次、unit/beta/all 一次，至少四处调用。',
    ).toBeGreaterThanOrEqual(4);
    for (const run of runs) {
      expect(
        run.includes('--maxWorkers="$GATE_VITEST_WORKERS"'),
        `这次 vitest 调用没有带上 worker 上限：${run}`,
      ).toBe(true);
    }
  });
});
