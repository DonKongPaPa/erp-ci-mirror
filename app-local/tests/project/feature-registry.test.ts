// @vitest-environment node
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { createApplicationRoutes } from '../../client/routes.js';
import type { RegistryRow } from '../../server/dev-tools/feedback.js';

/**
 * R-087 验收第 1 条：入库的功能登记表必须与应用的页面授权路由严格对齐。
 *
 * 页面行（带 `route` 的条目）的 id 集合要恰好等于 `client/routes.ts` 里显式声明页面授权的路由 id
 * 集合：少一条、多一条、重复、source 指不到文件都红。功能点行不参与页面集合，但 id 仍要唯一、
 * `page` 要指到一条真的页面行。变异自检：临时给 routes.ts 加一条不登记的页面路由，第一条用例必须红。
 */

const appRoot = path.resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '../..',
);
const registryFile = path.resolve(
  appRoot,
  '..',
  'HANDOFF',
  'tasks',
  'feature-registry.json',
);

function readRegistry(): readonly RegistryRow[] {
  return JSON.parse(readFileSync(registryFile, 'utf8')) as RegistryRow[];
}

const flatten = (routes: readonly any[]): any[] =>
  routes.flatMap((route) => [route, ...flatten(route.children ?? [])]);

function pageRouteIds(): readonly string[] {
  const contributions = createApplicationRoutes() as readonly any[];
  return flatten(contributions.flatMap((item) => item.routes ?? []))
    .filter(
      (route) =>
        typeof route.authz === 'object' &&
        route.authz !== null &&
        route.authz.resource?.type === 'page' &&
        typeof route.authz.resource.id === 'string',
    )
    .map((route) => String(route.authz.resource.id));
}

describe('功能登记表守门', () => {
  it('每条带页面授权的路由恰好一条页面行，缺了、多了、重复都红', () => {
    const routeIds = pageRouteIds();
    expect(routeIds.length).toBeGreaterThan(0);
    const pageRows = readRegistry().filter((row) => row.route !== undefined);
    const rowIds = pageRows.map((row) => row.id);

    expect(new Set(rowIds).size, '页面行 id 有重复。').toBe(rowIds.length);
    expect(
      rowIds.filter((id) => !routeIds.includes(id)),
      '登记表里有路由不存在的页面行。',
    ).toEqual([]);
    expect(
      routeIds.filter((id) => !rowIds.includes(id)),
      '有页面授权路由没登记：往 client/routes.ts 加页面时必须同步更新 feature-registry.json。',
    ).toEqual([]);
    expect(rowIds.length).toBe(routeIds.length);
  });

  it('所有 id 唯一，功能点行的 page 指到一条页面行', () => {
    const rows = readRegistry();
    const ids = rows.map((row) => row.id);
    expect(new Set(ids).size, '登记表 id 有重复。').toBe(ids.length);
    const pageIds = new Set(
      rows.filter((row) => row.route !== undefined).map((row) => row.id),
    );
    expect(
      rows
        .filter((row) => row.route === undefined)
        .map((row) => row.page)
        .filter((page) => !pageIds.has(page)),
      '功能点行指到了不存在的页面。',
    ).toEqual([]);
  });

  it('每一行的 source 都指到真实存在的文件', () => {
    const missing = readRegistry()
      .filter((row) => !existsSync(path.join(appRoot, row.source)))
      .map((row) => `${row.id}: ${row.source}`);
    expect(missing, '登记表里有 source 指不到文件的行。').toEqual([]);
  });

  it('betaAt 只留空或 ISO 时刻，状态是已约定的取值', () => {
    const statuses = new Set(['unfeedbacked', 'feedbacked', 'seen']);
    for (const row of readRegistry()) {
      expect(statuses.has(row.status), `${row.id} 的 status 不合法`).toBe(true);
      expect(
        row.betaAt === '' || !Number.isNaN(Date.parse(row.betaAt)),
        `${row.id} 的 betaAt 既不是空串也不是时刻`,
      ).toBe(true);
    }
  });
});
