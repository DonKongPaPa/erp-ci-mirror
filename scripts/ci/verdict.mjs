#!/usr/bin/env node
/**
 * 汇总一次 CI 运行的结果，写成 verdict.json。
 *
 * 存在的理由：用户要求「每个变动要和提交对上号」。任何一次流水线运行都必须能
 * 追溯到唯一的提交号，并且结果是一份机器可读的判据，而不是要人去翻日志。
 *
 * 用法：
 *   node scripts/ci/verdict.mjs --stage unit --out .ci/verdict.json
 *   node scripts/ci/verdict.mjs --stage unit --out .ci/verdict.json --skip lint
 *
 *   # R-058 第二片：核对上游单测线的判据（beta 作业用）
 *   node scripts/ci/verdict.mjs --check-upstream \
 *     --upstream-unit .ci/upstream/verdict.json --expect-commit <sha>
 *   # 证据齐全时把上游 test 阶段继承进最终判据：
 *   node scripts/ci/verdict.mjs --stage beta --out .ci/verdict.json \
 *     --upstream-unit .ci/upstream/verdict.json --upstream-artifact verdict-unit-<sha> \
 *     --expect-commit <sha> --result lint=passed:1 ...
 *
 * 退出码：所有阶段通过为 0，否则为 1。CI 直接看退出码，人看 verdict.json。
 * --check-upstream 的退出码 0 表示证据可用、可以跳过单测阶段；非 0 表示照旧全跑。
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 判据文件里的相对路径一律相对仓库根解析，不依赖调用者的 cwd：
// gate.sh 会 cd 进 app-local 再调用本脚本，用 cwd 会读不到报告。
const REPO_ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');

// 每个档位固定包含哪些阶段。只统计本档位该跑的，没参与的阶段不写进判据，
// 否则 unit 档会因为「没跑 build」而被判失败。
const STAGE_PLANS = {
  fast: ['lint', 'component-check', 'test'],
  docs: ['test', 'evidence', 'compliance'],
  unit: ['lint', 'typecheck', 'component-check', 'test'],
  beta: ['lint', 'typecheck', 'component-check', 'test', 'build', 'e2e'],
  all: ['lint', 'typecheck', 'component-check', 'test', 'build', 'e2e', 'evidence', 'compliance'],
};

function parseArgs(argv) {
  const options = {
    stage: 'unit', out: '.ci/verdict.json', skip: [], results: {},
    vitestMaxWorkers: null, cores: null,
    // R-058 第二片：beta 继承上游单测线判据所需的输入。
    upstreamUnit: null, upstreamArtifact: null, expectCommit: null,
    checkUpstream: false, summaryOut: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--stage') options.stage = argv[++index];
    else if (flag === '--out') options.out = argv[++index];
    // 闸门把生效的 worker 上限与核数传进来，判据里能看出有没有被钳位（R-058）。
    else if (flag === '--vitest-max-workers') options.vitestMaxWorkers = Number(argv[++index]) || null;
    else if (flag === '--cores') options.cores = Number(argv[++index]) || null;
    else if (flag === '--skip') options.skip.push(argv[++index]);
    else if (flag === '--upstream-unit') options.upstreamUnit = argv[++index];
    else if (flag === '--upstream-artifact') options.upstreamArtifact = argv[++index];
    else if (flag === '--expect-commit') options.expectCommit = argv[++index];
    else if (flag === '--check-upstream') options.checkUpstream = true;
    // 单测线上传的「必要摘要」：verdict.json 的紧凑子集，beta 不必拖整份报告。
    else if (flag === '--summary-out') options.summaryOut = argv[++index];
    else if (flag === '--result') {
      // --result lint=passed:1200  或  --result test=failed:8400
      const [name, encoded] = argv[++index].split('=');
      const [status, duration] = (encoded ?? '').split(':');
      options.results[name] = { status, durationMs: Number(duration ?? 0) || null };
    }
  }
  return options;
}

function git(...args) {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

/** 读一个由闸门生成的单值文件；不存在或读不出就返回空串。 */
function readTrim(file) {
  try {
    return readFileSync(file, 'utf8').trim();
  } catch {
    return '';
  }
}

/** 收集测试套件的机器可读摘要（vitest --reporter=json 的产物）。 */
function readTestSummary(file) {
  try {
    const report = JSON.parse(readFileSync(file, 'utf8'));
    const files = Array.isArray(report.testResults) ? report.testResults : [];
    const failed = files
      .filter((entry) => entry.status === 'failed')
      .map((entry) => path.relative(REPO_ROOT, entry.name ?? ''));
    return {
      total: report.numTotalTests ?? null,
      passed: report.numPassedTests ?? null,
      failed: report.numFailedTests ?? null,
      skipped: report.numPendingTests ?? null,
      failedFiles: failed,
    };
  } catch {
    return null;
  }
}

/**
 * 证据路径可能是工作流注入的相对路径，而 verdict.mjs 会在 gate.sh  cd 进 app-local
 * 之后被调用。相对路径一律按仓库根解析，不依赖调用者的 cwd（PR #210 查错 #1）。
 */
function resolveEvidencePath(file) {
  if (!file) return file;
  return path.isAbsolute(file) ? file : path.resolve(REPO_ROOT, file);
}

/**
 * 核对上游单测线的判据 —— 可用性与组合规则的唯一真相都在这里（R-058 第二片）。
 * 四项缺一不可：拿到证据、提交号等于本次触发的提交、verdict=passed、失败数为 0、
 * 档位确实是单测线跑的 unit。任何一项对不上就返回不可用，闸门照旧全跑。
 * 宁可慢，不许把没验过的单测记成通过（假绿）。
 */
function readUpstreamUnit(file, expectedCommit) {
  if (!file) {
    return { acceptable: false, skipUnit: false, reason: 'missing-upstream-path', failedChecks: ['file'] };
  }
  let data;
  try {
    data = JSON.parse(readFileSync(resolveEvidencePath(file), 'utf8'));
  } catch {
    return { acceptable: false, skipUnit: false, reason: 'unreadable-upstream-verdict', failedChecks: ['file'] };
  }
  const checks = [
    ['commit', typeof expectedCommit === 'string' && expectedCommit.length > 0 && data.commit === expectedCommit],
    ['verdict', data.verdict === 'passed'],
    ['failed', data.tests?.failed === 0],
    ['stage', data.stage === 'unit'],
    // 一条测试都没跑的「判据」不算证据：zero-test 假绿（PR #210 查错 #2）。
    ['total', Number.isInteger(data.tests?.total) && data.tests.total > 0],
  ];
  const failedChecks = checks.filter(([, ok]) => !ok).map(([name]) => name);
  return {
    acceptable: failedChecks.length === 0,
    skipUnit: failedChecks.length === 0,
    failedChecks,
    commit: data.commit ?? null,
    stage: data.stage ?? null,
    verdict: data.verdict ?? null,
    total: data.tests?.total ?? null,
    passed: data.tests?.passed ?? null,
    failed: data.tests?.failed ?? null,
    skipped: data.tests?.skipped ?? null,
    failedFiles: Array.isArray(data.tests?.failedFiles) ? data.tests.failedFiles : [],
  };
}

const options = parseArgs(process.argv.slice(2));

// 核对模式：只判证据，不写判据。gate.sh 在决定是否跳过单测阶段前调用它。
if (options.checkUpstream) {
  const decision = readUpstreamUnit(options.upstreamUnit, options.expectCommit);
  process.stdout.write(`${JSON.stringify(decision)}\n`);
  process.exit(decision.acceptable ? 0 : 1);
}

const upstream = options.upstreamUnit
  ? readUpstreamUnit(options.upstreamUnit, options.expectCommit)
  : null;
// 继承只在核对通过时发生。核对不通过时 gate.sh 本来就照旧全跑；这里再守一道，
// 就算被误传进来也不会把不可用的证据写进判据。
const inherited = Boolean(upstream?.acceptable);
// 传了证据却核不过：宁可整份判据变红，也不许「证据不可用却被记成通过」。
const upstreamRejected = Boolean(options.upstreamUnit && !inherited);
const skipped = new Set(options.skip);

const stages = (STAGE_PLANS[options.stage] ?? STAGE_PLANS.unit)
  .filter((name) => !skipped.has(name))
  .map((name) => {
    const result = options.results[name];
    // 继承的 test 阶段：状态来自上游判据，显式标记为继承，不能写成自己跑的。
    if (name === 'test' && inherited) {
      return {
        name,
        status: 'passed',
        durationMs: null,
        inherited: true,
        source: 'upstream-artifact',
      };
    }
    return {
      name,
      status: result?.status ?? 'not-run',
      durationMs: result?.durationMs ?? null,
    };
  });

let tests = readTestSummary(path.join(REPO_ROOT, '.ci/vitest.json'));
if (inherited) {
  // 继承时绝不读本地可能残留的 vitest.json，否则会把旧报告当成这一轮跑出来的。
  tests = {
    total: upstream.total,
    passed: upstream.passed,
    failed: upstream.failed,
    skipped: upstream.skipped,
    failedFiles: upstream.failedFiles,
    source: 'upstream-artifact',
  };
}
const startedAtFile = process.env.TEST_DB_STARTED_AT_FILE ??
  path.join(REPO_ROOT, '.ci', 'test-db-started-at');
const restartedFile = process.env.TEST_DB_RESTARTED_FILE ??
  path.join(REPO_ROOT, '.ci', 'test-db-restarted');
const startedAt = readTrim(startedAtFile);
const restartedFlag = readTrim(restartedFile);
// 三态：真重启 / 确认没重启 / 没法判断（复核失败或时刻文件为空）。
const restartedDuringRun = restartedFlag === '1' ? true : restartedFlag === '0' ? false : null;
// 只有这一轮真的做过容器核对才写 testDb；旧文件不算证据（复查应改 1）。
const dbChecked = process.env.TEST_DB_CHECKED === '1';
const failedStages = stages.filter((stage) => stage.status !== 'passed');
const verdict = {
  // 追溯三要素：哪次运行、哪个提交、什么时候。
  commit: git('rev-parse', 'HEAD'),
  commitShort: git('rev-parse', '--short', 'HEAD'),
  branch: git('rev-parse', '--abbrev-ref', 'HEAD'),
  // 工作区不干净时明确标出来：这份 verdict 对应的不是提交本身。
  dirty: git('status', '--porcelain').length > 0,
  stage: options.stage,
  generatedAt: new Date().toISOString(),
  // CI 环境信息尽量带上，便于判断是本机还是 Actions 跑出来的。
  runner: {
    provider: process.env.GITHUB_ACTIONS === 'true' ? 'github-actions' : 'local',
    workflow: process.env.GITHUB_WORKFLOW ?? null,
    runId: process.env.GITHUB_RUN_ID ?? null,
    job: process.env.GITHUB_JOB ?? null,
    node: process.version,
    vitestMaxWorkers: options.vitestMaxWorkers,
    cores: options.cores,
  },
  stages,
  tests,
  // R-058 第二片：单测证据来自上游产物时，如实写明哪个产物、哪个提交、哪个档位。
  // 没有继承时这个字段完全不出现，本地行为与旧版逐字节一致。
  ...(inherited
    ? {
        unitEvidence: {
          source: 'upstream-artifact',
          artifact: options.upstreamArtifact ?? null,
          commit: upstream.commit,
          expectedCommit: options.expectCommit ?? null,
          stage: upstream.stage,
          tests: {
            total: upstream.total,
            passed: upstream.passed,
            failed: upstream.failed,
            skipped: upstream.skipped,
          },
        },
      }
    : {}),
  // R-059：只有跑过本地容器核对才写 testDb；CI 注入 POSTGRES_HOST 的分支保持原样。
  // 核对过但读不到时刻时，两个字段都写 null —— 不能让「没写」被误读成「没重启」。
  ...(dbChecked
    ? {
        testDb: {
          startedAt: startedAt || null,
          restartedDuringRun,
        },
      }
    : {}),
  verdict: failedStages.length === 0 && !upstreamRejected ? 'passed' : 'failed',
  failedStages: [
    ...failedStages.map((stage) => stage.name),
    ...(upstreamRejected ? ['unit-evidence-rejected'] : []),
  ],
};

mkdirSync(path.dirname(options.out), { recursive: true });
writeFileSync(options.out, `${JSON.stringify(verdict, null, 2)}\n`);
// 单测线上传的紧凑摘要：verdict.json 的子集，供 beta 下载核对。
if (options.summaryOut) {
  mkdirSync(path.dirname(options.summaryOut), { recursive: true });
  const summary = {
    stage: verdict.stage,
    verdict: verdict.verdict,
    commit: verdict.commit,
    failedStages: verdict.failedStages,
    tests: tests && {
      total: tests.total,
      passed: tests.passed,
      failed: tests.failed,
      skipped: tests.skipped,
    },
  };
  writeFileSync(options.summaryOut, `${JSON.stringify(summary, null, 2)}\n`);
}

const summaryLine =
  `verdict=${verdict.verdict} commit=${verdict.commitShort}` +
  (verdict.dirty ? ' (dirty)' : '') +
  (failedStages.length ? ` failed=${verdict.failedStages.join(',')}` : '');
process.stdout.write(`${summaryLine}\n${options.out}\n`);

process.exit(verdict.verdict === 'passed' ? 0 : 1);
