#!/usr/bin/env node
/**
 * 合并多份 vitest JSON 报告为一份。
 *
 * 存在理由：gate.sh 的 fast 档分两次跑 vitest（受改动影响的 + 文档守门四个），
 * 因为 --changed 与显式文件混跑会让 vitest 只按 changed 过滤。两次运行各产一份报告，
 * verdict.mjs 只认一份 —— 不合并的话它会读到上一次 unit 档的旧计数，
 * 报出「811 passed」这种与实际运行无关的假绿。
 *
 * 用法：node merge-test-reports.mjs <in1.json> <in2.json> ... <out.json>
 */
import { readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
if (args.length < 2) {
  process.stderr.write('用法: merge-test-reports.mjs <in...> <out>\n');
  process.exit(2);
}
const out = args.pop();
const inputs = args;

const merged = {
  numTotalTestSuites: 0,
  numPassedTestSuites: 0,
  numFailedTestSuites: 0,
  numPendingTestSuites: 0,
  numTotalTests: 0,
  numPassedTests: 0,
  numFailedTests: 0,
  numPendingTests: 0,
  numTodoTests: 0,
  startTime: Date.now(),
  success: true,
  testResults: [],
};

for (const file of inputs) {
  let report;
  try {
    report = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    // 某一份报告缺失（例如该次运行一个测试都没匹配到）不算失败 ——
    // 但要在 stderr 留痕，否则「合并了 0 份」会被误读成「全绿」。
    process.stderr.write(`跳过无法读取的报告：${file}\n`);
    continue;
  }
  for (const key of [
    'numTotalTestSuites',
    'numPassedTestSuites',
    'numFailedTestSuites',
    'numPendingTestSuites',
    'numTotalTests',
    'numPassedTests',
    'numFailedTests',
    'numPendingTests',
    'numTodoTests',
  ]) {
    merged[key] += report[key] ?? 0;
  }
  if (report.success === false) {
    merged.success = false;
  }
  if (Array.isArray(report.testResults)) {
    merged.testResults.push(...report.testResults);
  }
}

writeFileSync(out, `${JSON.stringify(merged, null, 2)}\n`);
process.stdout.write(
  `合并 ${inputs.length} 份报告 → ${out}：` +
    `${merged.numPassedTests}/${merged.numTotalTests} 通过，` +
    `${merged.numFailedTests} 失败\n`,
);
