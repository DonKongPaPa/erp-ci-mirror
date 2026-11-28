// @vitest-environment node
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * R-084 验收 1～5。全部用临时仓库做夹具：自己的提交历史、自己的映射表、自己的测试文件，
 * 不读真仓库的提交，也不改真仓库的工作区。
 */
const repoRoot = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../../..');
const selector = path.join(repoRoot, 'scripts', 'ci', 'select-tests.mjs');
const realNodeModules = path.join(repoRoot, 'app-local', 'node_modules');

let temporary: string | undefined;
afterEach(() => {
  if (temporary) rmSync(temporary, { recursive: true, force: true });
  temporary = undefined;
});

function git(root: string, args: string[]): string {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  expect(result.status, `git ${args.join(' ')} 失败：${result.stderr ?? ''}`).toBe(0);
  return (result.stdout ?? '').trim();
}

function write(root: string, relative: string, content: string): void {
  const target = path.join(root, relative);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content);
}

const MAPPING = {
  version: 1,
  preciseLimit: 40,
  stemSuffixes: ['resources', 'schemas', 'provider', 'providers'],
  docOnlyPatterns: [
    '*.md',
    'app-local/**/*.md',
    'wiki/**',
    'HANDOFF/**',
    'raw/**',
    '.agents/**',
    'docs/**',
  ],
  testRoots: ['tests/server', 'tests/client', 'tests/database', 'tests/cli', 'tests/project'],
  testFilePattern: 'app-local/tests/**/*.test.{ts,tsx}',
  stopwords: ['index', 'providers', 'resources', 'src', 'app', 'local', 'tests', 'test'],
  fixedGroups: {
    sharedRegistry: ['tests/server/app-server.test.ts'],
    locale: [
      'tests/client/app-locale-coverage.test.ts',
      'tests/client/layout-i18n.test.tsx',
      'tests/client/auth-i18n.test.tsx',
      'tests/server/approval-failure-copy.test.ts',
    ],
  },
  rules: [
    {
      id: 'sharedRegistry',
      paths: ['app-local/server/providers/index.ts'],
      group: 'sharedRegistry',
    },
    {
      id: 'locale',
      paths: ['app-local/client/locales/**', 'app-local/server/locales/**'],
      group: 'locale',
    },
    {
      id: 'serverModule',
      paths: ['app-local/server/**'],
      derive: 'moduleTokens',
      searchRoots: ['tests/server', 'tests/client', 'tests/database', 'tests/cli'],
    },
    {
      id: 'clientArea',
      paths: ['app-local/client/**'],
      derive: 'moduleTokens',
      searchRoots: ['tests/client'],
    },
    {
      id: 'testFile',
      paths: ['app-local/tests/**'],
      derive: 'moduleTokens',
      searchRoots: ['tests/server', 'tests/client', 'tests/database', 'tests/cli', 'tests/project'],
    },
  ],
};

function makeRepo(): { root: string; base: string } {
  const root = mkdtempSync(path.join(tmpdir(), 'r084-select-'));
  temporary = root;
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.email', 'r084@agents.invalid']);
  git(root, ['config', 'user.name', 'r084']);
  git(root, ['config', 'commit.gpgsign', 'false']);
  write(root, 'app-local/README.md', '# fixture\n');
  symlinkSync(realNodeModules, path.join(root, 'app-local', 'node_modules'), 'dir');
  write(
    root,
    'app-local/vitest.config.mts',
    [
      "import { defineConfig } from 'vitest/config';",
      'export default defineConfig({',
      "  test: { root: new URL('.', import.meta.url).pathname, include: ['tests/**/*.test.ts'], passWithNoTests: true },",
      '});',
      '',
    ].join('\n'),
  );
  write(root, 'scripts/ci/test-modules.json', `${JSON.stringify(MAPPING, null, 2)}\n`);
  write(
    root,
    'app-local/tests/baseline.test.ts',
    "import { expect, it } from 'vitest';\nit('baseline', () => expect(1).toBe(1));\n",
  );
  git(root, ['add', '-A']);
  git(root, ['commit', '-qm', 'baseline']);
  return { root, base: git(root, ['rev-parse', 'HEAD']) };
}

function commitAll(root: string): string {
  git(root, ['add', '-A']);
  git(root, ['commit', '-qm', 'fixtures']);
  return git(root, ['rev-parse', 'HEAD']);
}

function testFile(root: string, name: string, importPath?: string): string {
  const relative = `app-local/tests/${name}`;
  const imports = importPath
    ? `import * as source from '${importPath}';\n`
    : 'const source = 1;\n';
  write(
    root,
    relative,
    `${imports}import { expect, it } from 'vitest';\nit('fixture', () => { expect(source).toBeTruthy(); });\n`,
  );
  return `tests/${name}`;
}

function runSelector(
  root: string,
  args: string[],
): { status: number; output: string; selection: any } {
  const out = path.join(root, '.ci-selected.json');
  const result = spawnSync(
    process.execPath,
    [selector, '--root', root, '--out', out, ...args],
    { encoding: 'utf8', cwd: root },
  );
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  const selection = (() => {
    try {
      return JSON.parse(readFileSync(out, 'utf8'));
    } catch {
      return null;
    }
  })();
  return { status: result.status ?? -1, output, selection };
}

describe('R-084 快速档选测试', () => {
  it('验收 1：同一份改动提交前后选中的文件集合相同', () => {
    const { root, base } = makeRepo();
    write(root, 'app-local/src/foo.ts', 'export const value = 1;\n');
    const a = testFile(root, 'server/a.test.ts', '../../src/foo');
    const b = testFile(root, 'client/b.test.ts', '../../src/foo');
    const c = testFile(root, 'server/c.test.ts', '../../src/foo');
    git(root, ['add', '-A']);

    const before = runSelector(root, ['--base', base]);
    expect(before.status, `${before.output}`).toBe(0);
    expect(before.selection.mode, `${before.output}`).toBe('precise');
    expect([...before.selection.tests].sort(), `${before.output}`).toEqual([a, b, c].sort());

    git(root, ['commit', '-qm', '改动已提交']);
    const after = runSelector(root, ['--base', base]);
    expect(after.status, `${after.output}`).toBe(0);
    expect([...after.selection.tests].sort(), `${after.output}`).toEqual(
      [...before.selection.tests].sort(),
    );
  });

  it('验收 2：依赖集合小的时候只选被引用到的三个文件', () => {
    const { root, base } = makeRepo();
    write(root, 'app-local/src/only-three.ts', 'export const value = 7;\n');
    const chosen = [
      testFile(root, 'server/one.test.ts', '../../src/only-three'),
      testFile(root, 'client/two.test.ts', '../../src/only-three'),
      testFile(root, 'database/three.test.ts', '../../src/only-three'),
    ];
    git(root, ['add', '-A']);

    const result = runSelector(root, ['--base', base]);
    expect(result.status, `${result.output}`).toBe(0);
    expect(result.selection.mode, `${result.output}`).toBe('precise');
    expect([...result.selection.tests].sort(), `${result.output}`).toEqual(chosen.sort());
    expect(result.selection.count, `${result.output}`).toBe(3);
  });

  it('验收 3：依赖集合超过上限时回落到映射的清单组，并打印提示', () => {
    const { root } = makeRepo();
    write(root, 'app-local/server/providers/index.ts', 'export const registry = 1;\n');
    write(root, 'app-local/tests/server/app-server.test.ts', "import { expect, it } from 'vitest';\nit('app', () => expect(1).toBe(1));\n");
    for (let i = 0; i < 45; i += 1) {
      testFile(root, `client/generated-${i}.test.ts`, '../../server/providers/index');
    }
    git(root, ['add', '-A']);
    git(root, ['commit', '-qm', '大量依赖 shared registry 的测试']);
    const base = git(root, ['rev-parse', 'HEAD']);
    write(root, 'app-local/server/providers/index.ts', 'export const registry = 2;\n');
    git(root, ['add', '-A']);

    const result = runSelector(root, ['--base', base]);
    expect(result.status, `${result.output}`).toBe(0);
    expect(result.selection.mode, `${result.output}`).toBe('mapping');
    expect(result.output).toContain('依赖集合过大，已回落到模块映射');
    expect(result.selection.tests, `${result.output}`).toEqual(['tests/server/app-server.test.ts']);
    expect(result.selection.tests, `${result.output}`).not.toContain('tests/client/generated-0.test.ts');
  });

  it('验收 4：映射外的源文件判红并指出文件，纯文档改动照常通过', () => {
    const { root, base } = makeRepo();
    write(root, 'app-local/build/custom/alpha.ts', 'export const alpha = 1;\n');
    const red = runSelector(root, ['--base', base]);
    expect(red.status, `${red.output}`).not.toBe(0);
    expect(red.output).toContain('GATE_UNMAPPED_CHANGE');
    expect(red.output).toContain('app-local/build/custom/alpha.ts');

    rmSync(path.join(root, 'app-local', 'build'), { recursive: true, force: true });
    write(root, 'app-local/README.md', '# 文档改动\n');
    const green = runSelector(root, ['--base', base]);
    expect(green.status, `${green.output}`).toBe(0);
    expect(green.selection.mode, `${green.output}`).toBe('doc-only');
    expect(green.selection.tests, `${green.output}`).toEqual([]);
  });

  it('验收 5：lint 清单只含改动的 JS/TS，闸门 fast 档按清单限定 lint 范围', () => {
    const { root, base } = makeRepo();
    write(root, 'app-local/server/touched.ts', 'export const touched = 1;\n');
    write(root, 'app-local/client/touched.tsx', 'export const touched = 2;\n');
    write(root, 'app-local/README.md', '# doc\n');
    const result = runSelector(root, ['--base', base]);
    expect(result.status, `${result.output}`).toBe(0);
    expect([...result.selection.lintFiles].sort(), `${result.output}`).toEqual([
      'client/touched.tsx',
      'server/touched.ts',
    ]);

    const gate = readFileSync(path.join(repoRoot, 'scripts', 'ci', 'gate.sh'), 'utf8');
    const fastBlock = gate.slice(
      gate.indexOf('if [ "$STAGE" = "fast" ]'),
      gate.indexOf('if [ "$STAGE" = "docs" ]'),
    );
    expect(fastBlock, 'fast 档必须读 select-tests 的 lint 清单').toContain('read_selected lintFiles');
    expect(fastBlock, 'fast 档的 lint 只能查选中的文件').toContain('pnpm exec eslint');
    expect(fastBlock, '一个 JS/TS 都没改时要把 lint 从判据计划里摘掉').toContain('skip_stage "lint"');
  });

  it('复核 1：语言包改动只跑固定组，不拿同批改动的模块名放大', () => {
    const { root } = makeRepo();
    for (const name of [
      'client/app-locale-coverage.test.ts',
      'client/layout-i18n.test.tsx',
      'client/auth-i18n.test.tsx',
      'server/approval-failure-copy.test.ts',
      'server/purchase-request-api.test.ts',
      'server/purchase-orders-api.test.ts',
    ]) {
      testFile(root, name);
    }
    const base = commitAll(root);
    write(root, 'app-local/client/locales/en-US.ts', 'export default {};\n');
    write(root, 'app-local/server/purchase-requests.ts', 'export const x = 1;\n');

    const result = runSelector(root, ['--base', base]);
    expect(result.status, `${result.output}`).toBe(0);
    expect([...result.selection.tests].sort(), `${result.output}`).toEqual(
      [
        'tests/client/app-locale-coverage.test.ts',
        'tests/client/layout-i18n.test.tsx',
        'tests/client/auth-i18n.test.tsx',
        'tests/server/approval-failure-copy.test.ts',
        'tests/server/purchase-request-api.test.ts',
      ].sort(),
    );
    expect(
      result.selection.sources['tests/client/app-locale-coverage.test.ts'],
      '语言包自身只能贡献固定组，不能再按其它改动的模块名关联。',
    ).toEqual(['fixed:locale']);
  });

  it('复核 2：purchase-requests 不选中 purchase-orders，iqc-resources 选中 iqc', () => {
    const { root } = makeRepo();
    for (const name of [
      'server/purchase-request-api.test.ts',
      'server/purchase-orders-api.test.ts',
      'server/iqc-api.test.ts',
      'server/iqc-authz.test.ts',
    ]) {
      testFile(root, name);
    }
    const firstBase = commitAll(root);
    write(root, 'app-local/server/purchase-requests.ts', 'export const x = 1;\n');
    const purchase = runSelector(root, ['--base', firstBase]);
    expect(purchase.status, `${purchase.output}`).toBe(0);
    expect(purchase.selection.tests, `${purchase.output}`).toEqual([
      'tests/server/purchase-request-api.test.ts',
    ]);
    expect(purchase.selection.tests, `${purchase.output}`).not.toContain(
      'tests/server/purchase-orders-api.test.ts',
    );

    const secondBase = commitAll(root);
    write(root, 'app-local/server/iqc-resources.ts', 'export const y = 2;\n');
    const iqc = runSelector(root, ['--base', secondBase]);
    expect(iqc.status, `${iqc.output}`).toBe(0);
    expect([...iqc.selection.tests].sort(), `${iqc.output}`).toEqual([
      'tests/server/iqc-api.test.ts',
      'tests/server/iqc-authz.test.ts',
    ]);
  });

  it('复核 3：目录名不参与匹配，只有测试文件名算数', () => {
    const { root } = makeRepo();
    testFile(root, 'client/iqc/unrelated.test.ts');
    testFile(root, 'server/iqc-api.test.ts');
    const base = commitAll(root);
    write(root, 'app-local/server/iqc-resources.ts', 'export const y = 2;\n');

    const result = runSelector(root, ['--base', base]);
    expect(result.status, `${result.output}`).toBe(0);
    expect(result.selection.tests, `${result.output}`).toEqual([
      'tests/server/iqc-api.test.ts',
    ]);
    expect(result.selection.tests, `${result.output}`).not.toContain(
      'tests/client/iqc/unrelated.test.ts',
    );
  });

  it('复核 4：单复数两边归一，单数主干也能选中复数文件名', () => {
    const { root } = makeRepo();
    testFile(root, 'server/orders-authz.test.ts');
    testFile(root, 'server/order-review-api.test.ts');
    testFile(root, 'server/items-upgrade.test.ts');
    const base = commitAll(root);
    write(root, 'app-local/server/order.ts', 'export const z = 3;\n');

    const result = runSelector(root, ['--base', base]);
    expect(result.status, `${result.output}`).toBe(0);
    expect([...result.selection.tests].sort(), `${result.output}`).toEqual([
      'tests/server/order-review-api.test.ts',
      'tests/server/orders-authz.test.ts',
    ]);
  });

  it('改动里有中文路径的文档时，不被当成没有规则认得的改动', () => {
    // 2026-11-28：Git 默认把非 ASCII 路径转义成带引号的八进制，带引号的名字匹配不上文档规则，
    // 快速档把改了设计文档的合并请求全拦下了（MES 基础设置那一片第一次撞上）。
    // 精确模式不查未登记的改动，所以配一个没有测试引用的源文件，让选测试回落到模块映射。
    const { root, base } = makeRepo();
    write(root, 'app-local/server/orphan.ts', 'export const orphan = 1;\n');
    // 仓库根下的中文名文档：*.md 是文档规则；不放 wiki/ 这类镜像守门看守的目录（它静态扫描测试源码）。
    write(root, '变更说明.md', '# 说明\n');
    git(root, ['add', '-A']);
    git(root, ['commit', '-qm', '带中文路径的改动']);
    const result = runSelector(root, ['--base', base]);
    expect(result.status, `${result.output}`).toBe(0);
    expect(result.output).not.toContain('GATE_UNMAPPED_CHANGE');
    expect(result.selection.mode, `${result.output}`).toBe('mapping');
  });
});
