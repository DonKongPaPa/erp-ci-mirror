import { spawnSync } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * 端到端里的稳定性测试要开浏览器，而浏览器二进制不在依赖里（R-039）。
 *
 * 2026-11-25 第一次在 CI 上跑稳定性测试，beta 基线红了：runner 上没有 Chromium，每条要开浏览器的测试各报一次
 * `browserType.launch: Executable doesn't exist`。两处补上：CI 的 beta 作业自己装浏览器；闸门在浏览器缺失时
 * 明确失败，而不是让每条测试各报一次看不出原因的错。
 */

const repoRoot = path.resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '../../..',
);
const gate = readFileSync(
  path.join(repoRoot, 'scripts', 'ci', 'gate.sh'),
  'utf8',
);

/** `require_e2e_browser` 的完整定义，供行为测试单独跑它。函数体里没有花括号块。 */
function browserCheckFunction(): string {
  const start = gate.indexOf('require_e2e_browser() {');
  expect(
    start,
    'gate.sh 里找不到 require_e2e_browser：端到端不会在浏览器缺失时明确失败。',
  ).toBeGreaterThan(-1);
  const end = gate.indexOf('\n}\n', start);
  expect(end, 'require_e2e_browser 的函数体没有结束。').toBeGreaterThan(start);
  return gate.slice(start, end + 3);
}

const temporary: string[] = [];

afterEach(() => {
  for (const directory of temporary.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

/**
 * 一份假的 `@playwright/test`：`chromium.executablePath()` 指向给定的路径。
 * `create` 为假时那个路径不存在（模拟没装浏览器）。
 */
function appReportingBrowserAt(executable: string, create: boolean): string {
  const app = mkdtempSync(path.join(tmpdir(), 'nb3-e2e-browser-'));
  temporary.push(app);
  if (create) {
    closeSync(openSync(executable, 'w'));
    temporary.push(executable);
  }
  const packageDirectory = path.join(
    app,
    'node_modules',
    '@playwright',
    'test',
  );
  mkdirSync(packageDirectory, { recursive: true });
  writeFileSync(
    path.join(packageDirectory, 'package.json'),
    JSON.stringify({ name: '@playwright/test', main: 'index.js' }),
  );
  writeFileSync(
    path.join(packageDirectory, 'index.js'),
    `module.exports = { chromium: { executablePath: () => ${JSON.stringify(executable)} } };\n`,
  );
  return app;
}

function runCheck(app: string): { status: number; output: string } {
  const script = [
    'set -uo pipefail',
    browserCheckFunction(),
    `require_e2e_browser ${JSON.stringify(app)}`,
    'exit $?',
  ].join('\n');
  const result = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
  return {
    status: result.status ?? -1,
    output: `${result.stdout}${result.stderr}`,
  };
}

describe('端到端的浏览器', () => {
  it('闸门在跑端到端之前先查浏览器', () => {
    const check = gate.indexOf('require_e2e_browser "$APP" || return 1');
    const start = gate.indexOf('run_e2e() {');
    expect(check, 'run_e2e 里没有调用 require_e2e_browser。').toBeGreaterThan(
      start,
    );
    expect(check, '浏览器检查必须在起应用之前。').toBeLessThan(
      gate.indexOf('启动开发服务器用于整合测试'),
    );
  });

  it('浏览器在就放行', () => {
    const executable = path.join(
      mkdtempSync(path.join(tmpdir(), 'nb3-e2e-exe-')),
      'chrome',
    );
    const result = runCheck(appReportingBrowserAt(executable, true));
    expect(result.status).toBe(0);
    expect(result.output).toBe('');
  });

  it('浏览器不在就明确失败，并说出该跑什么', () => {
    const missing = path.join(
      mkdtempSync(path.join(tmpdir(), 'nb3-e2e-none-')),
      'not-installed',
    );
    const result = runCheck(appReportingBrowserAt(missing, false));
    expect(result.status).toBe(1);
    expect(result.output).toContain('Chromium 没装');
    expect(result.output).toContain('pnpm exec playwright install chromium');
  });

  it('CI 的 beta 作业自己装浏览器，并把录像与 trace 传上来', () => {
    // 用 python 的 PyYAML 读真的 workflow（与「重复键」那条测试同一个解析器）。
    const workflow = path.join(repoRoot, '.github', 'workflows', 'gate.yml');
    const steps: { name?: string; run?: string; uses?: string }[] = JSON.parse(
      execFileSync(
        'python3',
        [
          '-c',
          'import json, sys, yaml; print(json.dumps(yaml.safe_load(sys.stdin)["jobs"]["beta"]["steps"]))',
        ],
        { input: readFileSync(workflow, 'utf8'), encoding: 'utf8' },
      ),
    );
    const names = steps.map((step) => step.name ?? '');
    const install = names.indexOf('安装端到端要用的浏览器');
    const runGate = names.indexOf('跑 beta 闸门（含 build）');

    expect(install, 'beta 作业里没有装浏览器这一步。').toBeGreaterThan(-1);
    expect(runGate).toBeGreaterThan(-1);
    expect(install, '要在跑闸门之前装。').toBeLessThan(runGate);
    expect(steps[install].run).toContain(
      'playwright install --with-deps chromium',
    );
    expect(
      steps.some(
        (step) =>
          step.name === '上传端到端的录像与 trace' &&
          step.uses === 'actions/upload-artifact@v4',
      ),
      '稳定性测试失败时留下的录像与 trace 要作为产物传上来，否则远端红了只能看到一句断言。',
    ).toBe(true);
  });
});
