import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '../../..',
);
const verdictScript = path.join(repoRoot, 'scripts', 'ci', 'verdict.mjs');
const gate = readFileSync(
  path.join(repoRoot, 'scripts', 'ci', 'gate.sh'),
  'utf8',
);
const verdictSrc = readFileSync(verdictScript, 'utf8');
const workflow = readFileSync(
  path.join(repoRoot, '.github', 'workflows', 'gate.yml'),
  'utf8',
);

const GOOD_COMMIT = 'a'.repeat(40);

type Evidence = {
  stage?: unknown;
  verdict?: unknown;
  commit?: unknown;
  tests?: unknown;
  failedStages?: unknown;
  [key: string]: unknown;
};

function makeEvidence(overrides: Evidence = {}): Evidence {
  return {
    stage: 'unit',
    verdict: 'passed',
    commit: GOOD_COMMIT,
    tests: { total: 10, passed: 10, failed: 0, skipped: 0, failedFiles: [] },
    failedStages: [],
    ...overrides,
  };
}

function writeEvidence(dir: string, evidence: Evidence | null): string | null {
  if (evidence === null) return path.join(dir, 'missing.json');
  const file = path.join(dir, 'upstream-verdict.json');
  writeFileSync(file, `${JSON.stringify(evidence)}\n`);
  return file;
}

function checkUpstream(file: string | null, expectedCommit = GOOD_COMMIT) {
  const args = [verdictScript, '--check-upstream', '--expect-commit', expectedCommit];
  if (file) args.push('--upstream-unit', file);
  const result = spawnSync(process.execPath, args, { encoding: 'utf8' });
  const output = `${result.stdout}${result.stderr}`.trim();
  let decision: Evidence | null = null;
  try {
    decision = JSON.parse(result.stdout.trim()) as Evidence;
  } catch {
    // 判据没产出 JSON 本身就是失败。
  }
  return { status: result.status, output, decision };
}

function runVerdict(dir: string, upstreamFile: string, artifact: string) {
  const out = path.join(dir, 'verdict.json');
  const result = spawnSync(
    process.execPath,
    [
      verdictScript,
      '--stage', 'beta',
      '--out', out,
      '--upstream-unit', upstreamFile,
      '--upstream-artifact', artifact,
      '--expect-commit', GOOD_COMMIT,
      '--result', 'lint=passed:1',
      '--result', 'typecheck=passed:1',
      '--result', 'component-check=passed:1',
      '--result', 'build=passed:1',
      '--result', 'e2e=passed:1',
    ],
    { encoding: 'utf8' },
  );
  return {
    status: result.status,
    output: `${result.stdout}${result.stderr}`,
    verdict: JSON.parse(readFileSync(out, 'utf8')) as {
      verdict: string;
      verdictStages?: unknown;
      tests?: Record<string, unknown> & { source?: string };
      stages: Array<{ name: string; status: string; inherited?: boolean; source?: string }>;
      unitEvidence?: {
        source?: string;
        artifact?: string;
        commit?: string;
        stage?: string;
        tests?: { failed?: number };
      };
    },
  };
}

/**
 * 极小的 YAML 重复键探测器：GitHub 遇到同一个 mapping 里重复的键会拒绝整份工作流，
 * 本地常见的宽松解析器却静默取最后一个值。这里只查「同一缩进的同一层 mapping 里键是否重复」，
 * 块标量（run: |）里的内容整段跳过；不需要引入外部 YAML 依赖。
 */
function duplicateYamlKeys(text: string): string[] {
  const duplicates: string[] = [];
  const stack: Array<{ indent: number; keys: Set<string> }> = [
    { indent: -1, keys: new Set() },
  ];
  let blockIndent: number | null = null;
  for (const raw of text.split(/\r?\n/u)) {
    if (!raw.trim()) continue;
    const indent = /^ */u.exec(raw)?.[0].length ?? 0;
    if (blockIndent !== null) {
      if (indent > blockIndent) continue;
      blockIndent = null;
    }
    const trimmed = raw.trim();
    if (trimmed.startsWith('#')) continue;
    const listMatch = /^-\s+([A-Za-z_][\w-]*):(?:\s|$)/u.exec(trimmed);
    const keyMatch = /^([A-Za-z_][\w-]*):(?:\s|$)/u.exec(trimmed);
    const match = listMatch ?? keyMatch;
    if (!match) continue;
    const key = match[1];
    const effective = listMatch ? indent + 2 : indent;
    // 普通键：只在缩回更浅的层时出栈，同层要留着才能查重。
    // 列表项的 "- key:" 则开启一个新的 mapping，先弹出同层，避免把相邻两项误判成重复。
    while (
      stack.length > 1 &&
      stack[stack.length - 1].indent > (listMatch ? effective - 1 : effective)
    ) {
      stack.pop();
    }
    if (listMatch && stack.length > 1 && stack[stack.length - 1].indent >= effective) {
      stack.pop();
    }
    const top = stack[stack.length - 1];
    if (top.indent === effective) {
      if (top.keys.has(key)) duplicates.push(`${key}@${effective}`);
      else top.keys.add(key);
    } else {
      stack.push({ indent: effective, keys: new Set([key]) });
    }
    const after = trimmed.slice(match[0].length).trim();
    if (/^[|>][+-]?\d*$/u.test(after)) blockIndent = effective;
  }
  return duplicates;
}

/**
 * R-058 第二片：beta 作业凭单测线的判据跳过重复的 vitest。
 * 证据对不上时宁可照旧全跑，也不许把没验过的单测记成通过（假绿）。
 * 这里用真的 verdict.mjs CLI 跑判据，不靠静态字符串假装测过。
 */
describe('beta 档的上游单测证据（R-058 第二片）', () => {
  it('上游证据缺失 → 判为不可用（照旧全跑）', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'r058-missing-'));
    try {
      const result = checkUpstream(writeEvidence(dir, null));
      expect(result.status, `判据进程退出 ${result.status}；${result.output}`).not.toBe(0);
      expect(result.decision?.acceptable, `${result.output}`).toBe(false);
      expect(String(result.decision?.reason ?? '')).toMatch(/missing|unreadable/u);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('提交号不符 → 判为不可用（照旧全跑）', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'r058-commit-'));
    try {
      const result = checkUpstream(
        writeEvidence(dir, makeEvidence({ commit: 'b'.repeat(40) })),
      );
      expect(result.status, `判据进程退出 ${result.status}；${result.output}`).not.toBe(0);
      expect(result.decision?.acceptable, `${result.output}`).toBe(false);
      expect(result.decision?.failedChecks).toContain('commit');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('verdict 不是 passed → 判为不可用（照旧全跑）', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'r058-verdict-'));
    try {
      const result = checkUpstream(
        writeEvidence(dir, makeEvidence({ verdict: 'failed' })),
      );
      expect(result.status, `判据进程退出 ${result.status}；${result.output}`).not.toBe(0);
      expect(result.decision?.acceptable, `${result.output}`).toBe(false);
      expect(result.decision?.failedChecks).toContain('verdict');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('失败数非 0 → 判为不可用（照旧全跑）', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'r058-failed-'));
    try {
      const result = checkUpstream(
        writeEvidence(
          dir,
          makeEvidence({
            verdict: 'passed',
            tests: { total: 10, passed: 9, failed: 1, skipped: 0, failedFiles: ['a.test.ts'] },
          }),
        ),
      );
      expect(result.status, `判据进程退出 ${result.status}；${result.output}`).not.toBe(0);
      expect(result.decision?.acceptable, `${result.output}`).toBe(false);
      expect(result.decision?.failedChecks).toContain('failed');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('档位不是单测线实际跑的 unit → 判为不可用（照旧全跑）', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'r058-stage-'));
    try {
      const result = checkUpstream(writeEvidence(dir, makeEvidence({ stage: 'fast' })));
      expect(result.status, `判据进程退出 ${result.status}；${result.output}`).not.toBe(0);
      expect(result.decision?.acceptable, `${result.output}`).toBe(false);
      expect(result.decision?.failedChecks).toContain('stage');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('证据齐全 → 可跳过单测，最终判据带上游产物与提交的 provenance', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'r058-valid-'));
    try {
      const file = writeEvidence(dir, makeEvidence())!;
      const checked = checkUpstream(file);
      expect(checked.status, `判据进程退出 ${checked.status}；${checked.output}`).toBe(0);
      expect(checked.decision?.acceptable, `${checked.output}`).toBe(true);
      expect(checked.decision?.skipUnit).toBe(true);

      const artifact = `verdict-unit-${GOOD_COMMIT}`;
      const final = runVerdict(dir, file, artifact);
      expect(final.status, `判据进程退出 ${final.status}；${final.output}`).toBe(0);
      expect(final.verdict.verdict).toBe('passed');
      expect(final.verdict.unitEvidence, '判据必须写明单测证据来自上游').toBeDefined();
      expect(final.verdict.unitEvidence?.source).toBe('upstream-artifact');
      expect(final.verdict.unitEvidence?.artifact).toBe(artifact);
      expect(final.verdict.unitEvidence?.commit).toBe(GOOD_COMMIT);
      expect(final.verdict.unitEvidence?.stage).toBe('unit');
      const testStage = final.verdict.stages.find((item) => item.name === 'test');
      expect(testStage, 'test 阶段不能凭空消失').toBeDefined();
      expect(testStage?.status).toBe('passed');
      expect(testStage?.inherited, 'test 阶段必须标记为继承，不能写成自己跑的').toBe(true);
      expect(testStage?.source).toBe('upstream-artifact');
      expect(final.verdict.tests?.source).toBe('upstream-artifact');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('上游一条测试都没跑（total=0）→ 判为不可用，不许空转假绿', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'r058-zero-tests-'));
    try {
      const result = checkUpstream(
        writeEvidence(
          dir,
          makeEvidence({
            tests: { total: 0, passed: 0, failed: 0, skipped: 0, failedFiles: [] },
          }),
        ),
      );
      expect(result.status, `判据进程退出 ${result.status}；${result.output}`).not.toBe(0);
      expect(result.decision?.acceptable, `${result.output}`).toBe(false);
      expect(result.decision?.failedChecks).toContain('total');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('不可用的证据即使被传进最终判据，也不得报 passed', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'r058-reject-final-'));
    try {
      const file = writeEvidence(
        dir,
        makeEvidence({
          tests: { total: 0, passed: 0, failed: 0, skipped: 0, failedFiles: [] },
        }),
      )!;
      const out = path.join(dir, 'verdict.json');
      const result = spawnSync(
        process.execPath,
        [
          verdictScript,
          '--stage', 'beta',
          '--out', out,
          '--upstream-unit', file,
          '--expect-commit', GOOD_COMMIT,
          // 即使 gate.sh 误把各阶段都记成 passed，也不许空转过关。
          '--result', 'lint=passed:1',
          '--result', 'typecheck=passed:1',
          '--result', 'component-check=passed:1',
          '--result', 'test=passed:1',
          '--result', 'build=passed:1',
          '--result', 'e2e=passed:1',
        ],
        { encoding: 'utf8' },
      );
      expect(result.status, `判据进程退出 ${result.status}；${result.stderr}`).not.toBe(0);
      const verdict = JSON.parse(readFileSync(out, 'utf8')) as {
        verdict: string;
        failedStages: string[];
        unitEvidence?: unknown;
      };
      expect(verdict.verdict).toBe('failed');
      expect(verdict.failedStages).toContain('unit-evidence-rejected');
      expect(verdict.unitEvidence, '不可用的证据不许写进 provenance').toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('生产链路：相对路径 + app-local cwd + 工作流注入的环境变量仍能继承并通过', () => {
    // PR #210 查错 #3：旧用例全用临时目录绝对路径，抓不到 cd 之后的相对路径失效。
    const rel = `.ci/upstream-chain-${process.pid}`;
    const abs = path.join(repoRoot, rel);
    mkdirSync(abs, { recursive: true });
    const out = path.join(abs, 'verdict.json');
    try {
      writeFileSync(
        path.join(abs, 'verdict-summary.json'),
        `${JSON.stringify(makeEvidence())}\n`,
      );
      // 照 gate.yml 注入的三个变量与 gate.sh write_verdict 的拼法来。
      const env = {
        ...process.env,
        GATE_BETA_UPSTREAM_UNIT: `${rel}/verdict-summary.json`,
        GATE_EXPECTED_COMMIT: GOOD_COMMIT,
        GATE_UPSTREAM_ARTIFACT: `verdict-unit-${GOOD_COMMIT}`,
      };
      const result = spawnSync(
        process.execPath,
        [
          verdictScript,
          '--stage', 'beta',
          '--out', out,
          '--upstream-unit', env.GATE_BETA_UPSTREAM_UNIT,
          '--expect-commit', env.GATE_EXPECTED_COMMIT,
          '--upstream-artifact', env.GATE_UPSTREAM_ARTIFACT,
          '--result', 'lint=passed:1',
          '--result', 'typecheck=passed:1',
          '--result', 'component-check=passed:1',
          '--result', 'build=passed:1',
          '--result', 'e2e=passed:1',
        ],
        { encoding: 'utf8', cwd: path.join(repoRoot, 'app-local'), env },
      );
      expect(result.status, `判据进程退出 ${result.status}；${result.stderr}`).toBe(0);
      const verdict = JSON.parse(readFileSync(out, 'utf8')) as {
        verdict: string;
        stages: Array<{ name: string; status: string; inherited?: boolean }>;
        unitEvidence?: { artifact?: string; commit?: string };
      };
      const testStage = verdict.stages.find((item) => item.name === 'test');
      expect(testStage?.inherited, '相对路径必须按仓库根解析，test 阶段应标记为继承').toBe(true);
      expect(testStage?.status).toBe('passed');
      expect(verdict.verdict).toBe('passed');
      expect(verdict.unitEvidence?.artifact).toBe(env.GATE_UPSTREAM_ARTIFACT);
      expect(verdict.unitEvidence?.commit).toBe(GOOD_COMMIT);
    } finally {
      rmSync(abs, { recursive: true, force: true });
    }
  });

  it('gate.sh 只在 beta 档、且核对通过时才跳过 test 阶段', () => {
    expect(
      gate.includes('if [ "$STAGE" = "beta" ] && [ -n "${GATE_BETA_UPSTREAM_UNIT:-}" ]'),
      '开关只认 beta 档和显式注入的证据路径。',
    ).toBe(true);
    expect(
      gate.includes('--check-upstream'),
      '跳过单测之前必须让 verdict.mjs 核对证据，规则不能写在 gate.sh 里另算一遍。',
    ).toBe(true);
    expect(
      gate.includes('if [ "$UPSTREAM_UNIT_READY" -eq 1 ]; then\n  skip_notice "test'),
      '证据可用时跳过 test 阶段（vitest）。',
    ).toBe(true);
    expect(
      gate.includes('--upstream-artifact "${GATE_UPSTREAM_ARTIFACT:-}"'),
      '最终判据要拿到产物名才能写出 provenance。',
    ).toBe(true);
    // 不开开关时本地行为照旧：test 阶段仍无条件跑。
    expect(
      gate.includes('else\n  step test\n  started='),
      '证据不可用时照旧跑 test 阶段。',
    ).toBe(true);
  });

  it('gate.yml 上传 unit 判据产物、beta 下载后再把开关交给闸门', () => {
    expect(workflow).toContain('name: verdict-unit-${{ github.sha }}');
    expect(workflow).toContain('.ci/verdict.json');
    expect(workflow).toContain('actions/download-artifact@v4');
    expect(workflow).toContain('name: verdict-unit-${{ github.sha }}');
    expect(workflow).toContain('GATE_BETA_UPSTREAM_UNIT');
    expect(workflow).toContain('GATE_EXPECTED_COMMIT: ${{ github.sha }}');
    // 闸门在 cd 进 app-local 之后还会用这个路径，必须是绝对路径（PR #210 查错 #1）。
    expect(workflow).toContain(
      'GATE_BETA_UPSTREAM_UNIT=$GITHUB_WORKSPACE/.ci/upstream/verdict-summary.json',
    );
    expect(workflow).toContain(
      'if [ -f "$GITHUB_WORKSPACE/.ci/upstream/verdict-summary.json" ]; then',
    );
  });

  it('工作流没有重复键（GitHub 会拒绝整份文件）', () => {
    // 先验证探测器本身不是「永远返回空」的摆设。
    const sample = ['a: 1', 'b:', '  a: 2', '  a: 3', 'c: 4'].join('\n');
    expect(duplicateYamlKeys(sample)).toContain('a@2');
    expect(duplicateYamlKeys(workflow)).toEqual([]);
  });

  it('组合判据规则只写在 verdict.mjs 一处', () => {
    expect(verdictSrc).toContain('failedStages.length === 0 && !upstreamRejected ? \'passed\' : \'failed\'');
    expect(verdictSrc).toContain('function readUpstreamUnit');
    expect(
      gate.includes('verdict=passed'),
      'gate.sh 只负责喂证据和阶段结果，不自己算最终判据。',
    ).toBe(false);
  });
});
