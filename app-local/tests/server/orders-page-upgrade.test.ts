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

import {
  PURCHASE_ORDERS_PAGE_ID,
  SALES_ORDERS_PAGE_ID,
  upgradeR021Page,
} from '../../cli/authz/upgrade-r021-page.js';
import { createAppTest } from '../helpers/test-app.js';
import { createStandaloneServer } from '../../server/standalone.js';

/**
 * R-021 / R-022 页面片的升级命令 `upgrade-r021-page`：已有环境里 seed 不会给采购、销售补订单页的页面授权，
 * 靠这条命令补。每个用例从 seed 的形状出发，用 SQL 把两条页面授权删掉，再跑命令；断言有效权限 `can()`、
 * 库里的形状、幂等与 revision。声明对不上时这个角色整条跳过，页面授权也不写。真 Postgres。
 */
const test = createAppTest({
  scope: 'test',
  createServer: createStandaloneServer,
  config: {
    app: { publicOrigin: 'http://localhost' },
    auth: { secret: 'test-auth-secret-at-least-32-characters' },
  },
});

const PASSWORD = 'R021-page-upgrade-123!';
const PAGES = {
  purchase: PURCHASE_ORDERS_PAGE_ID,
  sales: SALES_ORDERS_PAGE_ID,
} as const;
const ROLE_KEYS = ['purchase', 'sales'] as const;

interface JsonGrant {
  resource: { type: string; id: string };
  actions: { action: string; policy?: unknown }[];
}
const grantsOf = (set: { grants: unknown }): JsonGrant[] =>
  JSON.parse(JSON.stringify(set.grants)) as JsonGrant[];
const pageGrants = (set: { grants: unknown }): string[] =>
  grantsOf(set)
    .filter((grant) => grant.resource.type === 'page')
    .map((grant) => grant.resource.id);

type TestApp = Parameters<Parameters<typeof test>[1]>[0]['app'];
const resolveAuthz = (app: TestApp): AppAuthorization =>
  app.container.resolve(authorizationToken) as AppAuthorization;
const services = (app: TestApp) => ({ authorization: resolveAuthz(app) });
const pageCan = (authz: AppAuthorization, userId: string, id: string) =>
  authz
    .for({ principal: { type: 'user', id: userId } })
    .can({ resource: { type: 'page', id }, action: 'access' });

const createPerson = async (
  users: UserManagementService,
  name: string,
  roles?: readonly string[],
): Promise<string> =>
  (
    await users.create({
      name,
      email: `${name}@example.test`,
      password: PASSWORD,
      ...(roles === undefined ? {} : { roleScopes: { app: [...roles] } }),
    })
  ).id;

/** 造升级之前的环境：把两份角色的订单页授权删掉，业务授权与 revision 不动。 */
async function removePageGrants(
  connection: DatabaseConnection,
  authz: AppAuthorization,
): Promise<void> {
  for (const key of ROLE_KEYS) {
    const set = await authz.permissionSets.get(key);
    if (!set) throw new Error(`permission set ${key} is missing`);
    const next = grantsOf(set).filter(
      (grant) =>
        !(
          grant.resource.type === 'page' &&
          Object.values(PAGES).includes(grant.resource.id as never)
        ),
    );
    await connection.query
      .updateTable('authorizationPermissionSets')
      .set({ grants: JSON.stringify(next) })
      .where('key', '=', key)
      .execute();
  }
}

test('新环境 seed：采购只进采购订单页，销售只进销售订单页', async ({ app }) => {
  const authz = resolveAuthz(app);
  const users = app.container.resolve(userManagementServiceToken);
  const buyer = await createPerson(users, 'r021pageseedbuyer', ['purchase']);
  const seller = await createPerson(users, 'r022pageseedseller', ['sales']);

  expect(await pageCan(authz, buyer, PAGES.purchase)).toBe(true);
  expect(await pageCan(authz, buyer, PAGES.sales)).toBe(false);
  expect(await pageCan(authz, seller, PAGES.sales)).toBe(true);
  expect(await pageCan(authz, seller, PAGES.purchase)).toBe(false);
});

test('旧环境：各补各的订单页，别的角色不动，重跑不写', async ({
  app,
  connection,
}) => {
  const authz = resolveAuthz(app);
  const users = app.container.resolve(userManagementServiceToken);
  await removePageGrants(connection, authz);
  const buyer = await createPerson(users, 'r021pagebuyer', ['purchase']);
  const seller = await createPerson(users, 'r022pageseller', ['sales']);
  const keeper = await createPerson(users, 'r021pagekeeper', ['warehouse']);

  // 前置条件：升级前两个角色都进不了订单页。
  expect(await pageCan(authz, buyer, PAGES.purchase)).toBe(false);
  expect(await pageCan(authz, seller, PAGES.sales)).toBe(false);

  const update = vi.spyOn(authz.permissionSets, 'update');
  const report = await upgradeR021Page(services(app), {
    info: () => undefined,
  });
  // 业务授权 seed 已经给过：那一步什么都不写；这一步只写两份角色各一次。
  expect(report.grants.changed).toEqual([]);
  expect(update).toHaveBeenCalledTimes(2);
  expect(report.pages.changed).toEqual(['purchase', 'sales']);
  expect(await pageCan(authz, buyer, PAGES.purchase)).toBe(true);
  expect(await pageCan(authz, buyer, PAGES.sales)).toBe(false);
  expect(await pageCan(authz, seller, PAGES.sales)).toBe(true);
  expect(await pageCan(authz, seller, PAGES.purchase)).toBe(false);
  expect(await pageCan(authz, keeper, PAGES.purchase)).toBe(false);
  expect(await pageCan(authz, keeper, PAGES.sales)).toBe(false);

  // 只加不改：订单页各一条，原有的页面授权（客户与供应商页、仓库页、物料页）原样还在。
  const purchase = await authz.permissionSets.get('purchase');
  expect(pageGrants(purchase!)).toEqual([
    'partners',
    'warehouses',
    'items',
    PAGES.purchase,
  ]);
  const sales = await authz.permissionSets.get('sales');
  expect(pageGrants(sales!)).toEqual([
    'partners',
    'warehouses',
    'items',
    PAGES.sales,
  ]);

  // 幂等：重跑什么都不写，revision 也不变。
  const revision = sales?.revision;
  const again = await upgradeR021Page(services(app), { info: () => undefined });
  expect(again.pages.unchanged).toEqual(['purchase', 'sales']);
  expect(again.pages.changed).toEqual([]);
  expect(update).toHaveBeenCalledTimes(2);
  expect((await authz.permissionSets.get('sales'))?.revision).toBe(revision);
  update.mockRestore();
});

test('声明对不上整条跳过：采购的订单动作展不开时，采购的页面授权也不写，销售照常', async ({
  app,
  connection,
}) => {
  const authz = resolveAuthz(app);
  const users = app.container.resolve(userManagementServiceToken);
  await removePageGrants(connection, authz);
  const buyer = await createPerson(users, 'r021pagebuy2', ['purchase']);
  const seller = await createPerson(users, 'r022pagesell2', ['sales']);

  const getAction = authz.compositeResources.getAction.bind(
    authz.compositeResources,
  );
  const spy = vi
    .spyOn(authz.compositeResources, 'getAction')
    .mockImplementation((resource: string, action: string) =>
      resource === 'purchaseOrders' && action === 'createReceipt'
        ? undefined
        : getAction(resource, action),
    );
  try {
    const report = await upgradeR021Page(services(app), {
      info: () => undefined,
    });
    expect(report.grants.invalid).toEqual(['purchase']);
    expect(report.pages.invalid).toEqual(['purchase']);
    expect(report.pages.changed).toEqual(['sales']);
    expect(await pageCan(authz, buyer, PAGES.purchase)).toBe(false);
    expect(await pageCan(authz, seller, PAGES.sales)).toBe(true);
  } finally {
    spy.mockRestore();
  }
});
