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
 * 退出码：所有阶段通过为 0，否则为 1。CI 直接看退出码，人看 verdict.json。
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
  const options = { stage: 'unit', out: '.ci/verdict.json', skip: [], results: {} };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--stage') options.stage = argv[++index];
    else if (flag === '--out') options.out = argv[++index];
    else if (flag === '--skip') options.skip.push(argv[++index]);
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

const options = parseArgs(process.argv.slice(2));
const skipped = new Set(options.skip);

const stages = (STAGE_PLANS[options.stage] ?? STAGE_PLANS.unit)
  .filter((name) => !skipped.has(name))
  .map((name) => {
    const result = options.results[name];
    return {
      name,
      status: result?.status ?? 'not-run',
      durationMs: result?.durationMs ?? null,
    };
  });

const tests = readTestSummary(path.join(REPO_ROOT, '.ci/vitest.json'));
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
  },
  stages,
  tests,
  verdict: failedStages.length === 0 ? 'passed' : 'failed',
  failedStages: failedStages.map((stage) => stage.name),
};

mkdirSync(path.dirname(options.out), { recursive: true });
writeFileSync(options.out, `${JSON.stringify(verdict, null, 2)}\n`);

const summary =
  `verdict=${verdict.verdict} commit=${verdict.commitShort}` +
  (verdict.dirty ? ' (dirty)' : '') +
  (failedStages.length ? ` failed=${verdict.failedStages.join(',')}` : '');
process.stdout.write(`${summary}\n${options.out}\n`);

process.exit(verdict.verdict === 'passed' ? 0 : 1);
