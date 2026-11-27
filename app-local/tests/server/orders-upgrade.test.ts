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

import AuthzUpgradeR021, {
  upgradeR021,
  type R021UpgradeServices,
} from '../../cli/authz/upgrade-r021.js';
import { createAppTest } from '../helpers/test-app.js';
import { createStandaloneServer } from '../../server/standalone.js';

/**
 * R-021/R-022 升级命令：已有环境里的采购/销售角色拿不到订单授权与只读引用，
 * 靠 upgrade-r021 补齐。幂等、带 revision、声明对不上整条跳过、只加不改。
 */
const test = createAppTest({
  scope: 'test',
  createServer: createStandaloneServer,
  config: {
    app: { publicOrigin: 'http://localhost' },
    auth: { secret: 'test-auth-secret-at-least-32-characters' },
  },
});

const TARGETS = ['purchase', 'sales'] as const;
const OTHERS = ['staff', 'warehouse', 'quality_manager', 'quality_inspector', 'dept_manager', 'member'];
const ORDER_ACTIONS = [
  'view', 'create', 'update', 'submit', 'cancel',
] as const;
const PURCHASE_ACTIONS = [...ORDER_ACTIONS, 'createReceipt'] as const;
const SALES_ACTIONS = [...ORDER_ACTIONS, 'createIssue'] as const;
const NEW_RESOURCES = ['purchaseOrders', 'salesOrders', 'items', 'inventory'] as const;
const PASSWORD = 'R021-upgrade-123!';

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
): R021UpgradeServices => ({ authorization: app.container.resolve(authorizationToken) });
const can = (authz: AppAuthorization, userId: string, resource: string, action: string) =>
  authz.for({ principal: { type: 'user', id: userId } }).can({
    resource: { type: 'composite', id: resource }, action,
  });
const createPerson = async (users: UserManagementService, name: string, roles?: readonly string[]) =>
  (await users.create({
    name,
    email: `${name}@example.test`,
    password: PASSWORD,
    ...(roles === undefined ? {} : { roleScopes: { app: [...roles] } }),
  })).id;

const isNewGrant = (grant: JsonGrant): boolean =>
  grant.resource.type === 'composite' && NEW_RESOURCES.includes(
    grant.resource.id as (typeof NEW_RESOURCES)[number],
  );

/** 造升级之前的环境：把两份角色的新授权整条删掉，revision 不动。 */
async function makeOld(connection: DatabaseConnection, authz: AppAuthorization): Promise<void> {
  for (const key of TARGETS) {
    const set = await authz.permissionSets.get(key);
    if (!set) throw new Error(`permission set ${key} is missing`);
    const next = grantsOf(set).filter((grant) => !isNewGrant(grant));
    await connection.query
      .updateTable('authorizationPermissionSets')
      .set({ grants: JSON.stringify(next) })
      .where('key', '=', key)
      .execute();
  }
}

test('新环境 seed：采购与销售各有订单六动作、只读引用，别的角色一份都不给', async ({ app }) => {
  const authz = app.container.resolve(authorizationToken);
  const users = app.container.resolve(userManagementServiceToken);
  const buyer = await createPerson(users, 'r021seedbuyer', ['purchase']);
  const seller = await createPerson(users, 'r022seedseller', ['sales']);
  const staff = await createPerson(users, 'r021seedstaff', ['staff']);
  const expected: Record<string, { resource: string; actions: readonly string[] }[]> = {
    purchase: [
      { resource: 'purchaseOrders', actions: PURCHASE_ACTIONS },
      { resource: 'items', actions: ['view'] },
      { resource: 'inventory', actions: ['warehouseView'] },
      { resource: 'suppliers', actions: ['view', 'create', 'update'] },
    ],
    sales: [
      { resource: 'salesOrders', actions: SALES_ACTIONS },
      { resource: 'items', actions: ['view'] },
      { resource: 'inventory', actions: ['warehouseView'] },
      { resource: 'customers', actions: ['view', 'create', 'update'] },
    ],
  };
  for (const key of TARGETS) {
    const set = await authz.permissionSets.get(key);
    expect(set, `seed 应当建 ${key} 角色`).toBeDefined();
    const grants = grantsOf(set!);
    for (const want of expected[key]!) {
      const grant = grants.find((entry) => entry.resource.id === want.resource);
      expect(grant, `${key} 应当有 ${want.resource}`).toBeDefined();
      expect(grant!.actions.map((entry) => entry.action).sort()).toEqual([...want.actions].sort());
    }
  }
  for (const action of PURCHASE_ACTIONS) {
    expect(await can(authz, buyer, 'purchaseOrders', action), `采购应当有 ${action}`).toBe(true);
    expect(await can(authz, seller, 'purchaseOrders', action)).toBe(false);
  }
  for (const action of SALES_ACTIONS) {
    expect(await can(authz, seller, 'salesOrders', action), `销售应当有 ${action}`).toBe(true);
    expect(await can(authz, buyer, 'salesOrders', action)).toBe(false);
  }
  expect(await can(authz, buyer, 'items', 'view')).toBe(true);
  expect(await can(authz, buyer, 'inventory', 'warehouseView')).toBe(true);
  expect(await can(authz, staff, 'purchaseOrders', 'view')).toBe(false);
  expect(await can(authz, staff, 'salesOrders', 'view')).toBe(false);
});

test('旧环境只补两个角色的新授权：原有授权不动、revision 更新，重跑不写', async ({ app, connection }) => {
  const authz = app.container.resolve(authorizationToken);
  const users = app.container.resolve(userManagementServiceToken);
  await makeOld(connection, authz);
  const buyer = await createPerson(users, 'r021upgradebuyer', ['purchase']);
  const seller = await createPerson(users, 'r022upgradeseller', ['sales']);
  expect(await can(authz, buyer, 'purchaseOrders', 'view')).toBe(false);
  expect(await can(authz, seller, 'salesOrders', 'view')).toBe(false);

  const before = new Map<string, Snapshot>();
  for (const key of [...TARGETS, ...OTHERS]) before.set(key, await snapshot(authz, key));

  const lines: string[] = [];
  const report = await upgradeR021(services(app), { info: (message) => lines.push(message) });
  expect(report.changed).toEqual([...TARGETS]);
  expect(report.unchanged).toEqual([]);
  expect(report.missing).toEqual([]);
  expect(report.invalid).toEqual([]);
  expect(lines.some((line) => line.includes('[r021] purchase before:'))).toBe(true);
  expect(lines.some((line) => line.includes('[r021] sales after:'))).toBe(true);

  const after = new Map<string, Snapshot>();
  for (const key of [...TARGETS, ...OTHERS]) after.set(key, await snapshot(authz, key));
  for (const key of TARGETS) {
    const old = before.get(key)!;
    const now = after.get(key)!;
    expect(now.revision).not.toBe(old.revision);
    expect(now.grants.slice(0, old.grants.length)).toEqual(old.grants);
    expect(now.grants.length - old.grants.length).toBe(3);
    const expectedNew = key === 'purchase'
      ? ['purchaseOrders', 'items', 'inventory']
      : ['salesOrders', 'items', 'inventory'];
    expect(now.grants.slice(old.grants.length).map((grant) => grant.resource.id).sort()).toEqual(
      expectedNew.sort(),
    );
  }
  for (const key of OTHERS) {
    expect(after.get(key), `${key} 不该被动`).toEqual(before.get(key));
  }
  for (const action of PURCHASE_ACTIONS) expect(await can(authz, buyer, 'purchaseOrders', action)).toBe(true);
  for (const action of SALES_ACTIONS) expect(await can(authz, seller, 'salesOrders', action)).toBe(true);

  const second = await upgradeR021(services(app), { info: () => undefined });
  expect(second.changed).toEqual([]);
  expect(second.unchanged).toEqual([...TARGETS]);
  for (const key of [...TARGETS, ...OTHERS]) {
    expect(await snapshot(authz, key), `${key} 重跑不该变化`).toEqual(after.get(key));
  }
});

test('声明对不上时整条跳过、不写库', async ({ app, connection }) => {
  const authz = app.container.resolve(authorizationToken);
  await makeOld(connection, authz);
  const before = new Map<string, Snapshot>();
  for (const key of TARGETS) before.set(key, await snapshot(authz, key));
  const real = authz.compositeResources.getAction.bind(authz.compositeResources);
  const spy = vi
    .spyOn(authz.compositeResources, 'getAction')
    .mockImplementation((id, action) => (action === 'submit' ? undefined : real(id, action)));
  try {
    const report = await upgradeR021(services(app), { info: () => undefined });
    expect(report.invalid).toEqual([...TARGETS]);
    expect(report.changed).toEqual([]);
    for (const key of TARGETS) expect(await snapshot(authz, key)).toEqual(before.get(key));
  } finally {
    spy.mockRestore();
  }
});

test('角色不存在时记一行跳过，另一个角色照常补', async ({ app, connection }) => {
  const authz = app.container.resolve(authorizationToken);
  await makeOld(connection, authz);
  await connection.query.deleteFrom('authorizationPermissionSets').where('key', '=', 'purchase').execute();
  const before = new Map<string, Snapshot>();
  for (const key of OTHERS) before.set(key, await snapshot(authz, key));
  const lines: string[] = [];
  const report = await upgradeR021(services(app), { info: (line) => lines.push(line) });
  expect(report.missing).toEqual(['purchase']);
  expect(report.changed).toEqual(['sales']);
  expect(lines.some((line) => line.includes('purchase') && line.includes('not found'))).toBe(true);
  const seller = await authz.permissionSets.get('sales');
  expect(grantsOf(seller!).map((grant) => grant.resource.id)).toEqual(
    expect.arrayContaining(['salesOrders', 'items', 'inventory']),
  );
  for (const key of OTHERS) expect(await snapshot(authz, key)).toEqual(before.get(key));
});

test('升级命令挂在 authz 主题下，声明与 seed 一致', () => {
  expect(AuthzUpgradeR021.summary).toContain('purchase');
  expect(AuthzUpgradeR021.summary).toContain('sales');
  expect(AuthzUpgradeR021.description).toContain('purchaseOrders');
  expect(AuthzUpgradeR021.description).toContain('salesOrders');
});
