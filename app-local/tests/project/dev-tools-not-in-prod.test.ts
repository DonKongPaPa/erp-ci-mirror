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

/**
 * R-037 开发工具不能随正式环境上线。
 *
 * 两条机器能查的边界：演示账户只由开发工具在启动时建，迁移与 seed 里不能提它 ——
 * 那两处在每个环境都会执行，写进去就等于把演示账户带上线；客户端组合在非开发构建里
 * 不登记这个扩展。第二条是源码级检查：`import.meta.env.DEV` 在生产构建里被常量折叠，
 * 登记项随之为空，构建产物里搜不到配置节路径那一半要完整构建，见 R-037 验收第 7 条。
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

  it('registers the client extension only in a development build', () => {
    const source = readFileSync(
      path.join(appRoot, 'client', 'plugins.ts'),
      'utf8',
    );
    // 应用的 Vite 插件要求组合数组里每一项都是显式的工厂调用，条件展开写在数组里会
    // 让构建失败；所以开关包在 `devAccountSwitcherRegistration()` 里，数组里放它的调用。
    const start = source.indexOf('function devAccountSwitcherRegistration');
    expect(start, '组合里找不到开发工具的登记函数。').toBeGreaterThan(-1);
    const gate = source.slice(start, source.indexOf('\n}', start));
    expect(
      gate,
      '这一项只能在 import.meta.env.DEV 为真时登记扩展；否则生产构建也会带上它。',
    ).toContain('import.meta.env.DEV');
    expect(gate).toContain('devAccountSwitcher({ enabled: true })');
    expect(source).toContain('devAccountSwitcherRegistration(),');
  });

  it('keeps the account menu free of a static import of the extension', () => {
    const source = readFileSync(
      path.join(appRoot, 'client', 'layouts', 'components', 'user-menu.tsx'),
      'utf8',
    );
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
