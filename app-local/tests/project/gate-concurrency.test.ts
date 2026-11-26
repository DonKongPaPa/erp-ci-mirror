import { readFileSync } from 'node:fs';
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
 * R-055 闸门的并发治理：多个副本同时跑重阶段会把共享的 16 核机器压满。
 * 这组测试守的是脚本层面的契约 —— 锁覆盖哪些档、等待怎么报、worker 上限怎么传。
 * 真实的两副本串行、kill -9 不留死锁由验收实录覆盖（见 R-055 设计文档）。
 */
describe('gate.sh 并发治理（R-055）', () => {
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
    const fastBlock = gate.slice(
      gate.indexOf('if [ "$STAGE" = "fast" ]'),
      gate.indexOf('if [ "$STAGE" = "docs" ]'),
    );
    expect(
      fastBlock.includes('acquire_heavy_lock'),
      'fast 档是快速反馈，不能也去排队。',
    ).toBe(false);
    const docsBlock = gate.slice(
      gate.indexOf('if [ "$STAGE" = "docs" ]'),
      gate.indexOf(callAnchor),
    );
    expect(
      docsBlock.includes('acquire_heavy_lock'),
      'docs 档只跑项目组测试与两个扫描，不入锁。',
    ).toBe(false);
    expect(gate.includes(callAnchor), '抢锁的调用点必须在 fast / docs 的早退之后。').toBe(
      true,
    );
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

  it('caps vitest workers at min(cores - 4, 8), floor 2, with an override', () => {
    expect(
      gate.includes('${VITEST_MAX_WORKERS:-}'),
      '必须留 VITEST_MAX_WORKERS 给 CI 覆盖。',
    ).toBe(true);
    expect(
      gate.includes('GATE_VITEST_WORKERS=$((cpu_count - 4))'),
      '默认必须是核数减 4，给桌面留核。',
    ).toBe(true);
    expect(
      gate.includes('[ "$GATE_VITEST_WORKERS" -lt 2 ]'),
      'worker 数至少 2，不能低到失去并发。',
    ).toBe(true);
    expect(
      gate.includes('[ "$GATE_VITEST_WORKERS" -gt 8 ]'),
      'worker 数封顶 8，防止核数多的机器又失控。',
    ).toBe(true);
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
