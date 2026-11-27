import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PAGES as KNOWLEDGE_PAGES } from '@nocobase/app-plugin-knowledge/shared/access';
import { describe, expect, it } from 'vitest';

import { FEEDBACK_PAGE_ID } from '../../client/pages/feedbacks/page-id.js';
import { businessPermissionSets } from '../../database/main/seeds/202611240001_seed_business_permission_sets.js';

import { PARTNERS_PAGE_ID } from '../../client/pages/partners/page-id.js';
import { SHIFTS_PAGE_ID } from '../../client/pages/shifts/page-id.js';

import { EMPLOYEES_PAGE_ID } from '../../client/pages/settings/employees/page-id.js';
import { PARTNERS_PAGE_ID as COMMAND_PARTNERS_PAGE_ID } from '../../cli/authz/upgrade-r014-page.js';

const appRoot = path.resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '../..',
);

/** 读这个应用下的文件。 */
function read(...segments: string[]): string {
  return readFileSync(path.join(appRoot, ...segments), 'utf8');
}

/** 源码里 `{ type: 'page', id: '<id>' }` 形式的页面授权，取出 id。 */
function pageGrantIds(source: string): string[] {
  return [...source.matchAll(/type:\s*'page',\s*id:\s*'([^']+)'/gu)].map(
    (match) => match[1] as string,
  );
}

/**
 * 页面授权的 id 写了两处：seed 里给业务角色写页面授权时用的是它，页面自己的
 * 路由 `authz.resource.id` 也是它。两处对不上时运行期不报错 —— 角色拿着一个不
 * 存在的页面 id，页面就打不开；反过来路由改了 id，seed 写进去的授权就落不到那个
 * 页面上。所以用一个守门测试把两处钉在一起。
 *
 * R-002 之后 seed 多给质量主管、质量员各一条知识库页面授权：它的 id 来自知识库
 * 插件（`PAGES`），页面本身由插件的客户端路由登记（第二个切片接上）。R-026 再给
 * 三个角色（普通员工、质量主管、质量员）一条反馈单页的页面授权 `feedback`，页面
 * 本身在 R-026 的页面切片里登记；路由接上之前这里只钉 seed 一侧，页面切片补
 * `client/routes.ts` 的断言。质量页的路由仍在本应用的 `client/routes.ts` 里。
 *
 * 改 id 属于需要迁移存量授权的变化，不能只改一边（见 app-local/AGENTS.md 的
 * 「Pages and routes」）。
 */
describe('R-013 质量页的授权 id', () => {
  it('names the same page in the role seed and in the route the page authorization protects', () => {
    const seedPageIds = pageGrantIds(
      read(
        'database',
        'main',
        'seeds',
        '202611240001_seed_business_permission_sets.ts',
      ),
    );
    // 质量页一条（R-013），知识库页一条（R-002），反馈单页一条（R-026），客户与供应商页一条字面量（R-014；
    // 销售与采购各引用它一次，下面按解析后的结构数人头）。
    expect(
      seedPageIds.sort(),
      'seed 里的页面授权应当有质量页、知识库页、反馈单页与客户与供应商页',
    ).toEqual(['feedback', 'knowledge', 'partners', 'quality']);

    const routePageIds = pageGrantIds(read('client', 'routes.ts'));
    expect(
      routePageIds,
      'client/routes.ts 里质量页路由的 authz.resource.id 不是 seed 写的 quality',
    ).toContain('quality');

    // 反馈单页的 id 由共享常量给出：常量写成别的值、或路由没用这个常量，角色拿到的
    // 页面授权就落不到这一页上。期望值写死在这里，改常量不会跟着改，断言不会空转。
    expect(FEEDBACK_PAGE_ID, '反馈单页的 id 不是 seed 写的 feedback').toBe(
      'feedback',
    );
    expect(
      read('client', 'routes.ts'),
      '反馈单路由没有用共享的页面 id 常量',
    ).toContain('id: FEEDBACK_PAGE_ID');
    expect(seedPageIds).toContain(FEEDBACK_PAGE_ID);

    // 知识库的页面 id 由插件定：写成别的值时角色编辑器里勾不上那一页。
    expect(
      KNOWLEDGE_PAGES,
      '知识库插件登记的页面 id 与 seed 写的不一致',
    ).toContain('knowledge');
  });
});

describe('R-011 员工页的授权 id', () => {
  it('uses the shared page id in the route and grants it to no business role by default', () => {
    const routes = read('client', 'pages', 'settings', 'routes.ts');
    expect(routes).toContain(`id: EMPLOYEES_PAGE_ID`);
    expect(EMPLOYEES_PAGE_ID).toBe('employees');

    // 读 seed 导出的授权结构，不对源码做字面串匹配 —— 换个引号或引用常量都不影响这里。
    const pageGrants = businessPermissionSets.flatMap((set) =>
      set.grants
        .filter((grant) => grant.resource.type === 'page')
        .map((grant) => ({ role: set.key, id: grant.resource.id })),
    );
    // 先钉住解析本身：其它三个页面授权必须被解析出来，否则下面的反向断言是空的。
    expect(new Set(pageGrants.map(({ id }) => id))).toEqual(
      new Set(['quality', 'feedback', 'knowledge', 'partners']),
    );
    expect(
      pageGrants.map(({ id }) => id),
      '员工页默认只有 root 能进：业务角色的 seed 不能给它授权',
    ).not.toContain(EMPLOYEES_PAGE_ID);
  });
});

describe('R-014 / R-025 页面片的授权 id', () => {
  it('客户与供应商页：路由、seed、升级命令三处是同一个 id，只给销售与采购', () => {
    expect(PARTNERS_PAGE_ID).toBe('partners');
    expect(
      COMMAND_PARTNERS_PAGE_ID,
      '升级命令里的页面 id 与页面不是同一个',
    ).toBe(PARTNERS_PAGE_ID);
    const routes = read('client', 'routes.ts');
    expect(routes, '路由没有用共享的页面 id 常量').toContain(
      'id: PARTNERS_PAGE_ID',
    );
    const holders = businessPermissionSets.flatMap((set) =>
      set.grants
        .filter((grant) => grant.resource.type === 'page')
        .filter((grant) => grant.resource.id === PARTNERS_PAGE_ID)
        .map(() => set.key),
    );
    expect(holders.sort()).toEqual(['purchase', 'sales']);
  });

  it('班次定义页：路由用共享的 id，默认只给 root，业务角色的 seed 一份都不给', () => {
    expect(SHIFTS_PAGE_ID).toBe('shifts');
    expect(read('client', 'routes.ts')).toContain('id: SHIFTS_PAGE_ID');
    const pageGrants = businessPermissionSets.flatMap((set) =>
      set.grants
        .filter((grant) => grant.resource.type === 'page')
        .map((grant) => ({ role: set.key, id: grant.resource.id })),
    );
    expect(
      pageGrants.map(({ id }) => id),
      '班次页默认只有 root 能进：业务角色的 seed 不能给它授权',
    ).not.toContain(SHIFTS_PAGE_ID);
  });
});
