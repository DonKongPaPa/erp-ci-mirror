// @vitest-environment node
import {
  authorizationToken,
  type AppAuthorization,
} from '@nocobase/app-plugin-authorization';
import {
  userManagementServiceToken,
  type UserManagementService,
} from '@nocobase/app-plugin-users/server/tokens';
import type { DatabaseConnection } from '@nocobase/db';
import { expect, vi } from 'vitest';

import AuthzUpgradeR020Page, {
  upgradeR020Page,
  type R020PageUpgradeServices,
} from '../../cli/authz/upgrade-r020-page.js';
import { createAppTest } from '../helpers/test-app.js';
import { createStandaloneServer } from '../../server/standalone.js';

/**
 * R-020 页面片的升级命令：已有环境里 seed 不会给 warehouse / purchase / sales 补页面授权，靠这条命令补。
 * 先补业务授权（upgrade-r020、upgrade-r021），再补页面授权；幂等、带 revision、声明对不上整条跳过、只加不改。
 */
const test = createAppTest({
  scope: 'test',
  createServer: createStandaloneServer,
  config: {
    app: { publicOrigin: 'http://localhost' },
    auth: { secret: 'test-auth-secret-at-least-32-characters' },
  },
});

const KEEPER = 'warehouse';
const BUYERS = ['purchase', 'sales'] as const;
const TARGETS = [KEEPER, ...BUYERS] as const;
const OTHER_ROLES = ['staff', 'quality_manager', 'quality_inspector', 'dept_manager', 'member'];
const KEEPER_PAGES = ['stock', 'inboundOrders', 'outboundOrders', 'warehouses'] as const;
const PAGE_IDS = [...KEEPER_PAGES] as const;
const PASSWORD = 'R020-page-upgrade-123!';

interface JsonGrant {
  resource: { type: string; id: string };
  actions: { action: string; policy?: unknown }[];
}
interface Snapshot {
  grants: JsonGrant[];
  revision: string;
  title: unknown;
}
const grantsOf = (set: { grants: unknown }): JsonGrant[] =>
  JSON.parse(JSON.stringify(set.grants)) as JsonGrant[];
const snapshot = async (authz: AppAuthorization, key: string): Promise<Snapshot> => {
  const set = await authz.permissionSets.get(key);
  if (!set) throw new Error(`permission set ${key} is missing`);
  return { grants: grantsOf(set), revision: set.revision as string, title: set.title };
};
const services = (
  app: { container: { resolve(token: typeof authorizationToken): AppAuthorization } },
): R020PageUpgradeServices => ({ authorization: app.container.resolve(authorizationToken) });
const canOpen = (authz: AppAuthorization, userId: string, id: string) =>
  authz.for({ principal: { type: 'user', id: userId } }).can({
    resource: { type: 'page', id },
    action: 'access',
  });
const createPerson = async (users: UserManagementService, name: string, roles?: readonly string[]) =>
  (await users.create({
    name,
    email: `${name}@example.test`,
    password: PASSWORD,
    ...(roles === undefined ? {} : { roleScopes: { app: [...roles] } }),
  })).id;
const pageIdsOf = (set: Snapshot): string[] =>
  set.grants
    .filter((grant) => grant.resource.type === 'page')
    .map((grant) => grant.resource.id)
    .sort();

/** 造升级之前的环境：把三个角色里的物料与库存页面授权整条删掉，revision 不动。 */
async function makeOld(connection: DatabaseConnection, authz: AppAuthorization): Promise<void> {
  for (const key of TARGETS) {
    const set = await authz.permissionSets.get(key);
    if (!set) throw new Error(`permission set ${key} is missing`);
    const next = grantsOf(set).filter(
      (grant) =>
        !(grant.resource.type === 'page' && (PAGE_IDS as readonly string[]).includes(grant.resource.id)),
    );
    await connection.query
      .updateTable('authorizationPermissionSets')
      .set({ grants: JSON.stringify(next) })
      .where('key', '=', key)
      .execute();
  }
}

test('新环境 seed 已含四页的页面授权：仓管四页，采购与销售有 items、partners 与仓库页', async ({ app }) => {
  const authz = app.container.resolve(authorizationToken);
  const users = app.container.resolve(userManagementServiceToken);
  expect(pageIdsOf(await snapshot(authz, KEEPER))).toEqual([...KEEPER_PAGES].sort());
  // items、partners 是别的片的页面授权；R-020 只补仓库页。
  for (const key of BUYERS)
    expect(pageIdsOf(await snapshot(authz, key))).toEqual([
      'items',
      'partners',
      'warehouses',
    ]);

  const keeper = await createPerson(users, 'r020pageseedkeeper', [KEEPER]);
  const buyer = await createPerson(users, 'r020pageseedbuyer', ['purchase']);
  const staff = await createPerson(users, 'r020pageseedstaff', ['staff']);
  for (const id of KEEPER_PAGES) {
    expect(await canOpen(authz, keeper, id), `仓管应当能打开 ${id}`).toBe(true);
    expect(await canOpen(authz, staff, id), `普通员工不该能打开 ${id}`).toBe(false);
  }
  expect(await canOpen(authz, buyer, 'warehouses')).toBe(true);
  expect(await canOpen(authz, buyer, 'stock')).toBe(false);
});

test('旧环境只补页面授权，别的角色逐项不变，重跑不写', async ({ app, connection }) => {
  const authz = app.container.resolve(authorizationToken);
  const users = app.container.resolve(userManagementServiceToken);
  await makeOld(connection, authz);
  const keeper = await createPerson(users, 'r020pageupgradekeeper', [KEEPER]);
  expect(await canOpen(authz, keeper, 'inboundOrders')).toBe(false);

  const before = new Map<string, Snapshot>();
  for (const key of [...TARGETS, ...OTHER_ROLES]) before.set(key, await snapshot(authz, key));

  const lines: string[] = [];
  const report = await upgradeR020Page(services(app), { info: (message) => lines.push(message) });
  expect([...report.pages.changed].sort()).toEqual([...TARGETS].sort());
  expect(report.pages.unchanged).toEqual([]);
  expect(report.pages.missing).toEqual([]);
  expect(report.pages.invalid).toEqual([]);
  expect(lines.some((line) => line.includes('[r020-page]'))).toBe(true);

  // 只加不改：原有的授权一条一条原样排在前面。
  for (const key of TARGETS) {
    const after = await snapshot(authz, KEEPER === key ? key : key);
    expect(after.revision).not.toBe(before.get(key)!.revision);
    expect(after.grants.slice(0, before.get(key)!.grants.length)).toEqual(before.get(key)!.grants);
  }
  expect(pageIdsOf(await snapshot(authz, KEEPER))).toEqual([...KEEPER_PAGES].sort());
  // items、partners 不是这一片写的，升级前后都该原样保留。
  for (const key of BUYERS)
    expect(pageIdsOf(await snapshot(authz, key))).toEqual([
      'items',
      'partners',
      'warehouses',
    ]);
  for (const id of KEEPER_PAGES) expect(await canOpen(authz, keeper, id)).toBe(true);
  for (const key of OTHER_ROLES) {
    expect(await snapshot(authz, key), `${key} 不该被动`).toEqual(before.get(key));
  }

  const after = new Map<string, Snapshot>();
  for (const key of TARGETS) after.set(key, await snapshot(authz, key));
  const second = await upgradeR020Page(services(app), { info: () => undefined });
  expect(second.pages.changed).toEqual([]);
  expect([...second.pages.unchanged].sort()).toEqual([...TARGETS].sort());
  for (const key of TARGETS) {
    expect(await snapshot(authz, key), `${key} 重跑不该变化`).toEqual(after.get(key));
  }
});

test('业务授权的声明对不上时那个角色整条跳过，页面授权也不写', async ({ app, connection }) => {
  const authz = app.container.resolve(authorizationToken);
  await makeOld(connection, authz);
  const before = await snapshot(authz, KEEPER);
  const real = authz.compositeResources.getAction.bind(authz.compositeResources);
  const spy = vi
    .spyOn(authz.compositeResources, 'getAction')
    .mockImplementation((id, action) => (action === 'stockPost' ? undefined : real(id, action)));
  try {
    const report = await upgradeR020Page(services(app), { info: () => undefined });
    expect(report.grants.invalid).toEqual([KEEPER]);
    expect(report.pages.invalid).toEqual([KEEPER]);
    expect(report.pages.changed).toEqual([...BUYERS]);
    // 仓管一条都没写；采购、销售的 items、partners 原样留着，仓库页照补。
    expect(await snapshot(authz, KEEPER)).toEqual(before);
    for (const key of BUYERS)
      expect(pageIdsOf(await snapshot(authz, key))).toEqual([
        'items',
        'partners',
        'warehouses',
      ]);
  } finally {
    spy.mockRestore();
  }
});

test('角色不存在时记一行跳过，别的角色照补', async ({ app, connection }) => {
  const authz = app.container.resolve(authorizationToken);
  await makeOld(connection, authz);
  await connection.query
    .deleteFrom('authorizationPermissionSets')
    .where('key', '=', 'sales')
    .execute();
  const lines: string[] = [];
  const report = await upgradeR020Page(services(app), { info: (line) => lines.push(line) });
  expect(report.pages.missing).toEqual(['sales']);
  expect([...report.pages.changed].sort()).toEqual(['purchase', KEEPER].sort());
  expect(lines.some((line) => line.includes('sales') && line.includes('not found'))).toBe(true);
  expect(pageIdsOf(await snapshot(authz, KEEPER))).toEqual([...KEEPER_PAGES].sort());
});

test('升级命令挂在 authz 主题下，说明里写明补的是哪些页面', () => {
  expect(AuthzUpgradeR020Page.summary).toContain('page');
  expect(AuthzUpgradeR020Page.description).toContain('warehouses');
  expect(AuthzUpgradeR020Page.description).toContain('Idempotent');
});
