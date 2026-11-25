import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * 四道门在闸门里的接线（R-039）。
 *
 * 样式守门与可访问性是 pytest 式的测试与 lint 规则，组件复用检查与稳定性测试则是
 * 闸门自己调用的。这组测试守两件事：
 *   1. 四道门真的接在 fast / unit / beta / all 的正确档位上；
 *   2. 组件复用检查的判据（脚本缺失、退出码 1 与 2）真的让闸门失败 ——
 *      没跑、没扫完都不能当作通过。
 */

const repoRoot = path.resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '../../..',
);
const gate = readFileSync(
  path.join(repoRoot, 'scripts', 'ci', 'gate.sh'),
  'utf8',
);

/** `run_component_check` 的完整定义，供行为测试单独跑它。函数体没有嵌套的花括号块。 */
function componentCheckFunction(): string {
  const start = gate.indexOf('run_component_check() {');
  expect(
    start,
    'gate.sh 里找不到 run_component_check：组件复用检查没有接进闸门。',
  ).toBeGreaterThan(-1);
  const end = gate.indexOf('\n}\n', start);
  expect(end, 'run_component_check 的函数体没有结束。').toBeGreaterThan(start);
  return gate.slice(start, end + 3);
}

function runCheck(mode: string, app: string) {
  const script = [
    'set -uo pipefail',
    `APP=${JSON.stringify(app)}`,
    `ROOT=${JSON.stringify(app)}`,
    componentCheckFunction(),
    `run_component_check ${mode} || exit $?`,
    'exit 0',
  ].join('\n');
  const result = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
  return {
    status: result.status ?? -1,
    output: `${result.stdout}${result.stderr}`,
  };
}

function withChecker(body: string): string {
  const app = mkdtempSync(path.join(tmpdir(), 'nb3-component-check-'));
  const directory = path.join(
    app,
    '.agents',
    'skills',
    'nocobase-app-development',
    'scripts',
  );
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, 'check-ui-components.mjs'), body);
  return app;
}

describe('frontend gates in gate.sh', () => {
  it('runs the style guard in the fast channel', () => {
    const fastBlock = gate.slice(
      gate.indexOf('if [ "$STAGE" = "fast" ]'),
      gate.indexOf('run_stage lint pnpm lint\nrun_stage typecheck'),
    );
    expect(
      fastBlock.includes('tests/project/frontend-style-guard.test.ts'),
      'fast 档必须显式跑样式守门 —— 它查的是 client/，--changed 关联不到它。',
    ).toBe(true);
  });

  it('runs the component reuse check on changed files in fast and on everything in unit', () => {
    expect(
      gate.includes('run_stage component-check run_component_check changed'),
      'fast 档必须只查改动过的客户端文件。',
    ).toBe(true);
    expect(
      gate.includes('run_stage component-check run_component_check all'),
      'unit 档必须全量跑组件复用检查（实测约 2 秒，放得下）。',
    ).toBe(true);
  });

  it('adds the stability tests to the end-to-end run', () => {
    expect(
      gate.includes('tests/playwright/stability'),
      'beta 与 all 档的端到端必须带上稳定性测试。',
    ).toBe(true);
  });

  it('keeps a failure recording of the stability tests', () => {
    const playwright = readFileSync(
      path.join(repoRoot, 'app-local', 'playwright.config.ts'),
      'utf8',
    );
    expect(
      configRetains(playwright, 'trace'),
      '稳定性测试失败时必须留下 trace。',
    ).toBe(true);
    expect(
      configRetains(playwright, 'video'),
      '稳定性测试失败时必须留下录像。',
    ).toBe(true);
  });

  it('fails loudly when the component checker is missing', () => {
    const app = mkdtempSync(path.join(tmpdir(), 'nb3-component-missing-'));
    try {
      const result = runCheck('all', app);
      expect(
        result.status,
        '组件复用检查脚本不在时必须失败，不许悄悄通过。',
      ).toBe(1);
      expect(result.output).toContain('组件复用检查脚本不存在');
      expect(result.output).toContain('缺脚本不是通过');
    } finally {
      rmSync(app, { recursive: true, force: true });
    }
  });

  it('passes only on exit code 0', () => {
    for (const [exitCode, expected] of [
      [0, 0],
      [1, 1],
      [2, 1],
      [3, 1],
    ] as const) {
      const app = withChecker(`process.exit(${exitCode});`);
      try {
        const result = runCheck('all', app);
        expect(
          result.status,
          `组件复用检查退出码 ${exitCode} 的处理不对：1（有发现）与 2（扫描不完整）都算失败。`,
        ).toBe(expected);
        if (exitCode === 0) expect(result.output).toContain('组件复用检查通过');
        else if (exitCode === 1) expect(result.output).toContain('退出码 1');
        else if (exitCode === 2) expect(result.output).toContain('退出码 2');
        else expect(result.output).toContain(`退出码 ${exitCode}`);
      } finally {
        rmSync(app, { recursive: true, force: true });
      }
    }
  });
});

/** `use: { trace: 'retain-on-failure', video: 'retain-on-failure' }` 里的一项是否保留失败记录。 */
function configRetains(config: string, key: string): boolean {
  return new RegExp(`${key}:\\s*'retain-on-failure'`, 'u').test(config);
}
