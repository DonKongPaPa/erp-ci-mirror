import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const appRoot = path.resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '../..',
);

/** Every file under a directory, recursively, as paths relative to the application root. */
function filesUnder(directory: string): string[] {
  return readdirSync(path.join(appRoot, directory), {
    withFileTypes: true,
  }).flatMap((entry) => {
    const relative = path.join(directory, entry.name);
    if (entry.isDirectory()) return filesUnder(relative);
    return [relative];
  });
}

function read(relative: string): string {
  return readFileSync(path.join(appRoot, relative), 'utf8');
}

/**
 * 静态引入的模块路径：`import … from '…'` 与 `import '…'`。`import type` 编译后不留痕迹，不算；
 * 动态引入 `import('…')` 也不在里面，它由下面的测试单独守。
 */
function staticImportSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  for (const match of source.matchAll(
    /\bimport\s+(type\s+)?[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]/gu,
  )) {
    if (match[1] === undefined) specifiers.push(match[2] ?? '');
  }
  for (const match of source.matchAll(/\bimport\s*['"]([^'"]+)['"]/gu)) {
    specifiers.push(match[1] ?? '');
  }
  return specifiers;
}

/**
 * 开发工具自己的源码。它们互相引用不算 —— 这一片整体不进部署产物，
 * 要守的是「删掉它们之后，别处不能还指着它们」。
 */
const isDevToolServerSource = (file: string): boolean =>
  file.startsWith('server/dev-tools/') ||
  [
    'server/routes/dev-account-switcher.ts',
    'server/routes/dev-requirements-board.ts',
    'server/routes/dev-confirmations.ts',
    'server/routes/dev-feedback.ts',
    'server/providers/dev-account-switcher.ts',
    'server/config/dev-tools.ts',
  ].includes(file);

const isDevToolClientSource = (file: string): boolean =>
  file.startsWith('client/extensions/dev-account-switcher/') ||
  file.startsWith('client/extensions/dev-requirements-board/') ||
  file.startsWith('client/extensions/dev-confirmations/') ||
  file.startsWith('client/extensions/dev-feedback/');

/** 服务端开发工具模块的引入路径（源码里写的是 `.js`）。 */
const DEV_TOOL_SERVER_MODULE =
  /\/dev-tools\/|\/dev-account-switcher\.js$|\/dev-requirements-board\.js$|\/dev-confirmations\.js$|\/dev-feedback\.js$|\/config\/dev-tools\.js$/u;

/** 切换器的代码模块；它的词条表不在此列，语言包那一条另有测试。 */
const SWITCHER_CODE_MODULE =
  /\/dev-account-switcher\/(?:plugin|section|index)\.js$/u;

/** 看板的代码模块；词条表同样只由语言包在开发构建里并入。 */
const BOARD_CODE_MODULE = /\/dev-requirements-board\/(?:index|model)\.js$/u;

/** 待确认事项的代码模块；词条表同样只由语言包在开发构建里并入。 */
const CONFIRMATIONS_CODE_MODULE = /\/dev-confirmations\/(?:index|model)\.js$/u;

/** 测试反馈的代码模块；词条表同样只由语言包在开发构建里并入。 */
const FEEDBACK_CODE_MODULE = /\/dev-feedback\/(?:index|model|panel|register)\.js$/u;

/**
 * `check-dist.sh` 对 `dist/server` 全文断言零命中的标记。源码里带着它们的注释会被原样编进产物
 * （服务端是逐文件编译，注释不删），所以在源码这一层就不许出现。
 */
const SERVER_ARTIFACT_MARKERS = [
  'switch-account',
  'dev-account-switcher',
  'dev/requirements-board',
  'requirements-board',
  'dev/confirmations',
  'dev-confirmations',
  'dev/feedback',
  'dev-feedback',
  'demo.quality_manager',
  'demo.quality_inspector',
  'demo.dept_manager',
  'demo.staff',
  'demo.warehouse',
  'demo.purchase',
  'demo.sales',
  'demo.finance',
  'demo.planning',
];

/**
 * R-037 开发工具不能随正式环境上线。
 *
 * 两条机器能查的边界：演示账户只由开发工具在启动时建，迁移与 seed 里不能提它 ——
 * 那两处在每个环境都会执行，写进去就等于把演示账户带上线；客户端组合在非开发构建里
 * 不登记这个扩展。
 */
describe('R-037 开发工具不进正式环境', () => {
  it('mentions no demo account in any migration or seed', () => {
    const offenders = filesUnder('database').filter((file) =>
      readFileSync(path.join(appRoot, file), 'utf8').includes('demo.'),
    );
    expect(
      offenders,
      '演示账户由开发工具在启动时建，不能走迁移或 seed：它们在生产环境也会执行。',
    ).toEqual([]);
  });

  it('keeps the account menu free of a static import of the extension', () => {
    const source = read('client/layouts/components/user-menu.tsx');
    const imports = source
      .split('\n')
      .filter(
        (line) =>
          /^\s*import\b/u.test(line) && line.includes('dev-account-switcher'),
      );
    expect(
      imports.filter((line) => !/^\s*import\s+type\b/u.test(line)),
      '头像菜单只能通过 service token 拿这段 UI；静态引入会把它的代码带进生产构建。',
    ).toEqual([]);
  });
});

/**
 * R-073 部署产物里没有开发与演示功能 —— 是「没有」，不是「关着」。
 *
 * 用户 2026-11-27：「你要在部署版本上删掉演示的功能（注意不是关闭功能而是移除）防止风险。」
 * 这里是不用构建就能跑的源码级一半：主组合不引用开发工具、切换器只经「开发期常量 + 动态引入」进模块图。
 * 产物内容那一半由 `scripts/release/check-dist.sh` 断言，由 `deploy-dist-configs.test.ts` 守着。
 */
describe('R-073 部署产物里没有开发与演示功能（源码守门）', () => {
  const clientSources = filesUnder('client').filter(
    (file) => !isDevToolClientSource(file),
  );
  const serverSources = filesUnder('server').filter(
    (file) => !isDevToolServerSource(file),
  );

  it('the client composition never statically imports the switcher code', () => {
    for (const file of clientSources) {
      const offenders = staticImportSpecifiers(read(file)).filter((specifier) =>
        SWITCHER_CODE_MODULE.test(specifier),
      );
      expect(
        offenders,
        `${file} 静态引入了切换器的代码模块：静态引入会把它带进生产构建的模块图。`,
      ).toEqual([]);
    }
  });

  it('the switcher code is reached only by a dynamic import behind the development constant', () => {
    const loader = 'client/extensions/development-extensions.ts';
    const source = read(loader);
    const gate = source.indexOf('if (!import.meta.env.DEV) return;');
    const dynamicImport = source.search(
      /await import\(\s*['"]\.\/dev-account-switcher\/index\.js['"]/u,
    );
    expect(
      gate,
      '开发扩展的入口没有「非开发构建直接返回」这道门。',
    ).toBeGreaterThan(-1);
    expect(dynamicImport, '开发扩展的入口没有动态引入切换器。').toBeGreaterThan(
      gate,
    );
    for (const file of clientSources.filter((file) => file !== loader)) {
      expect(
        read(file),
        `${file} 动态引入了切换器：除开发扩展的入口外不许有别处引入它。`,
      ).not.toMatch(/\bimport\s*\(\s*['"][^'"]*dev-account-switcher/u);
    }
  });

  it('the board page is reached only by a dynamic import behind the development constant', () => {
    const loader = 'client/extensions/development-extensions.ts';
    const source = read(loader);
    const gate = source.indexOf('if (!import.meta.env.DEV) return defineAppRoutes([]);');
    const dynamicImport = source.search(
      /componentLoader:\s*\(\)\s*=>\s*import\(\s*['"]\.\/dev-requirements-board\/index\.js['"]/u,
    );
    expect(
      gate,
      '看板路由没有「非开发构建直接返回空」这道门。',
    ).toBeGreaterThan(-1);
    expect(dynamicImport, '看板路由的页面不是动态引入的。').toBeGreaterThan(
      gate,
    );
    for (const file of clientSources) {
      expect(
        staticImportSpecifiers(read(file)).filter((specifier) =>
          BOARD_CODE_MODULE.test(specifier),
        ),
        `${file} 静态引入了看板的代码模块：静态引入会把它带进生产构建的模块图。`,
      ).toEqual([]);
    }
  });

  it('the confirmations page is reached only by a dynamic import behind the development constant', () => {
    const loader = 'client/extensions/development-extensions.ts';
    const source = read(loader);
    const gate = source.indexOf('if (!import.meta.env.DEV) return defineAppRoutes([]);');
    const dynamicImport = source.search(
      /componentLoader:\s*\(\)\s*=>\s*import\(\s*['"]\.\/dev-confirmations\/index\.js['"]/u,
    );
    expect(
      gate,
      '待确认事项的路由没有「非开发构建直接返回空」这道门。',
    ).toBeGreaterThan(-1);
    expect(dynamicImport, '待确认事项的页面不是动态引入的。').toBeGreaterThan(
      gate,
    );
    for (const file of clientSources) {
      expect(
        staticImportSpecifiers(read(file)).filter((specifier) =>
          CONFIRMATIONS_CODE_MODULE.test(specifier),
        ),
        `${file} 静态引入了待确认事项的代码模块：静态引入会把它带进生产构建的模块图。`,
      ).toEqual([]);
    }
  });

  it('the feedback page and its floating panel are reached only by dynamic imports behind the development constant', () => {
    const loader = 'client/extensions/development-extensions.ts';
    const source = read(loader);
    const gate = source.indexOf('if (!import.meta.env.DEV) return defineAppRoutes([]);');
    const pageImport = source.search(
      /componentLoader:\s*\(\)\s*=>\s*import\(\s*['"]\.\/dev-feedback\/index\.js['"]/u,
    );
    const panelImport = source.search(
      /await import\(\s*['"]\.\/dev-feedback\/register\.js['"]/u,
    );
    expect(
      gate,
      '测试反馈的路由没有「非开发构建直接返回空」这道门。',
    ).toBeGreaterThan(-1);
    expect(pageImport, '测试反馈的页面不是动态引入的。').toBeGreaterThan(gate);
    expect(panelImport, '悬浮面板不是动态引入的。').toBeGreaterThan(-1);
    for (const file of clientSources) {
      expect(
        staticImportSpecifiers(read(file)).filter((specifier) =>
          FEEDBACK_CODE_MODULE.test(specifier),
        ),
        `${file} 静态引入了测试反馈的代码模块：静态引入会把它带进生产构建的模块图。`,
      ).toEqual([]);
    }
  });

  it('the switcher locale entries are merged only by a development-guarded spread', () => {
    for (const locale of ['en-US', 'zh-CN']) {
      const source = read(`client/locales/${locale}.ts`);
      expect(
        source,
        `client/locales/${locale}.ts 没有引入切换器的词条表。`,
      ).toContain(
        `import devTools from '../extensions/dev-account-switcher/locales/${locale}.js';`,
      );
      expect(
        source,
        `client/locales/${locale}.ts 没有引入看板的词条表。`,
      ).toContain(
        `import requirementsBoard from '../extensions/dev-requirements-board/locales/${locale}.js';`,
      );
      expect(
        source,
        `client/locales/${locale}.ts 没有引入待确认事项的词条表。`,
      ).toContain(
        `import confirmations from '../extensions/dev-confirmations/locales/${locale}.js';`,
      );
      expect(
        source,
        `client/locales/${locale}.ts 没有引入测试反馈的词条表。`,
      ).toContain(
        `import feedback from '../extensions/dev-feedback/locales/${locale}.js';`,
      );
      expect(
        source,
        `client/locales/${locale}.ts 并入 devTools 词条时没有用 import.meta.env.DEV 挡：生产构建的语言包会带上「切换账户」「需求池看板」「待确认事项」「测试反馈」这些文案。`,
      ).toMatch(
        /\.\.\.\(\s*import\.meta\.env\.DEV\s*\?\s*\{\s*devTools:\s*\{\s*\.\.\.devTools,\s*\.\.\.requirementsBoard,\s*\.\.\.confirmations,\s*\.\.\.feedback\s*,?\s*\}\s*,?\s*\}\s*:\s*\{\}\s*\),/u,
      );
    }
    for (const file of clientSources.filter(
      (file) => !file.startsWith('client/locales/'),
    )) {
      const specifiers = staticImportSpecifiers(read(file));
      expect(
        specifiers,
        `${file} 引入了切换器的词条表：词条只能由两份语言包并入。`,
      ).toEqual(
        expect.not.arrayContaining([
          expect.stringMatching(/dev-account-switcher\/locales\//u),
        ]),
      );
      expect(
        specifiers,
        `${file} 引入了看板的词条表：词条只能由两份语言包并入。`,
      ).toEqual(
        expect.not.arrayContaining([
          expect.stringMatching(/dev-requirements-board\/locales\//u),
        ]),
      );
      expect(
        specifiers,
        `${file} 引入了待确认事项的词条表：词条只能由两份语言包并入。`,
      ).toEqual(
        expect.not.arrayContaining([
          expect.stringMatching(/dev-confirmations\/locales\//u),
        ]),
      );
      expect(
        specifiers,
        `${file} 引入了测试反馈的词条表：词条只能由两份语言包并入。`,
      ).toEqual(
        expect.not.arrayContaining([
          expect.stringMatching(/dev-feedback\/locales\//u),
        ]),
      );
    }
  });

  it('the account menu and its section token name no development tool', () => {
    for (const file of [
      'client/layouts/user-menu-section.ts',
      'client/layouts/components/user-menu.tsx',
    ]) {
      const source = read(file);
      for (const marker of [
        'dev-account-switcher',
        'dev-tools',
        'DevAccountSwitcher',
      ]) {
        expect(
          source,
          `${file} 里出现了 ${marker}：头像菜单是生产常驻代码，它的 service token 名会原样进产物。`,
        ).not.toContain(marker);
      }
    }
  });

  it('the server composition never references the development tool modules', () => {
    for (const file of [
      'server/routes/index.ts',
      'server/providers/index.ts',
      'server/config/index.ts',
    ]) {
      const source = read(file);
      expect(
        staticImportSpecifiers(source).filter((specifier) =>
          DEV_TOOL_SERVER_MODULE.test(specifier),
        ),
        `${file} 引用了开发工具的模块：产物里没有这些文件，引用了生产启动就崩。`,
      ).toEqual([]);
      // 生产常驻的启动守卫文件名里带 dev-tools，所以这里不查这个字串本身，只查上面那条引入路径。
      expect(source, `${file} 里出现了 dev-account-switcher。`).not.toContain(
        'dev-account-switcher',
      );
    }
  });

  it('nothing outside the development tool modules statically imports them', () => {
    for (const file of serverSources) {
      const offenders = staticImportSpecifiers(read(file)).filter((specifier) =>
        DEV_TOOL_SERVER_MODULE.test(specifier),
      );
      expect(offenders, `${file} 静态引入了开发工具的模块。`).toEqual([]);
    }
  });

  it('the development tool entry is a dynamic import behind the development check', () => {
    const entry = 'server/embedded.ts';
    const source = read(entry);
    const gate = source.indexOf(
      'if (isDevelopmentNodeEnv(runtime.env.NODE_ENV)) {',
    );
    const dynamicImport = source.indexOf(
      "await import('./dev-tools/register.js')",
    );
    expect(
      gate,
      '开发工具的登记入口没有「只在开发环境」这道门。',
    ).toBeGreaterThan(-1);
    expect(dynamicImport, '开发工具的登记入口不是动态引入。').toBeGreaterThan(
      gate,
    );
    for (const file of serverSources.filter((file) => file !== entry)) {
      expect(
        read(file),
        `${file} 动态引入了开发工具的模块：除登记入口外不许有别处引入它。`,
      ).not.toMatch(
        /\bimport\s*\(\s*['"][^"']*(?:dev-tools|dev-account-switcher)/u,
      );
    }
  });

  it('production-resident server sources carry none of the artifact markers', () => {
    for (const file of serverSources) {
      const source = read(file);
      for (const marker of SERVER_ARTIFACT_MARKERS) {
        expect(
          source,
          `${file} 里出现了标记 ${marker}：注释也会被编进 dist/server，产物自检会在这里命中。`,
        ).not.toContain(marker);
      }
    }
  });

  it('the production guard stays in the server composition', () => {
    // 运行时守卫是第二道防线：非开发环境里配置写了开启，应用必须起不来（R-037 的约束，R-073 不动它）。
    const composition = read('server/providers/index.ts');
    expect(composition).toContain(
      "import DevToolsGuardProvider from './dev-tools-guard.js';",
    );
    expect(composition).toContain('DevToolsGuardProvider,');
    const guard = read('server/providers/dev-tools-guard.ts');
    expect(guard).toContain('isDevelopmentNodeEnv(this.app.nodeEnv)');
    expect(guard).toContain('开发工具不能在生产环境开启');
  });
});
