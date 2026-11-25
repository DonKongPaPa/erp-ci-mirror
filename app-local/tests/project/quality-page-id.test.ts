import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

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
 * 质量页的授权 id 在两处各写了一遍：seed 里给四个业务角色写页面授权时用的是它，
 * `client/routes.ts` 的质量页路由 `authz.resource.id` 也是它。两处对不上时运行期
 * 不报错 —— 角色拿着一个不存在的页面 id，页面就打不开；反过来路由改了 id，seed
 * 写进去的授权就落不到那个页面上。所以用一个守门测试把两处钉在一起。
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
    expect(
      seedPageIds,
      'seed 里的页面授权应当只有质量页一条，id 是 quality',
    ).toEqual(['quality']);

    const routePageIds = pageGrantIds(read('client', 'routes.ts'));
    expect(
      routePageIds,
      'client/routes.ts 里质量页路由的 authz.resource.id 不是 seed 写的 quality',
    ).toContain('quality');
  });
});
