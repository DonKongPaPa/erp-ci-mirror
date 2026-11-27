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

import AuthzUpgradeR076, {
  upgradeR076,
  type R076UpgradeServices,
} from '../../cli/authz/upgrade-r076.js';
import { createAppTest } from '../helpers/test-app.js';
import { createStandaloneServer } from '../../server/standalone.js';

/**
 * R-076 升级命令：已有环境靠它补打印授权。幂等、带 revision、声明对不上整条跳过、
 * 只加不改，别的角色一行不动。
 */
const test = createAppTest({
  scope: 'test',
  createServer: createStandaloneServer,
  config: {
    app: { publicOrigin: 'http://localhost' },
    auth: { secret: 'test-auth-secret-at-least-32-characters' },
  },
});

const TARGETS = ['warehouse', 'purchase', 'sales'] as const;
const OTHERS = ['staff', 'quality_manager', 'dept_manager', 'member', 'finance'] as const;
const PASSWORD = 'R076-upgrade-123!';

interface JsonGrant {
  resource: { type: string; id: string };
  actions: { action: string; policy?: unknown }[];
}
interface Snapshot { grants: JsonGrant[]; revision: string; title: unknown }
const grantsOf = (set: { grants: unknown }): JsonGrant[] =>
  JSON.parse(JSON.stringify(set.grants)) as JsonGrant[];
const snapshot = async (authz: AppAuthorization, key: string): Promise<Snapshot> => {
  const set = await authz.permissionSets.get(key);
  if (!set) throw new Error(`permission set ${key} is missing`);
  return { grants: grantsOf(set), revision: set.revision as string, title: set.title };
};
const services = (
  app: { container: { resolve(token: typeof authorizationToken): AppAuthorization } },
): R076UpgradeServices => ({ authorization: app.container.resolve(authorizationToken) });
const makeUser = async (users: UserManagementService, name: string, role: string): Promise<string> =>
  (await users.create({
    name,
    email: `${name}@example.test`,
    password: PASSWORD,
    roleScopes: { app: [role] },
  })).id;
const can = (authz: AppAuthorization, userId: string, resource: string, action: string) =>
  authz.for({ principal: { type: 'user', id: userId } }).can({
    resource: { type: 'composite', id: resource },
    action,
  });

/** 造升级之前的环境：把三份打印授权整条删掉，revision 不动。 */
async function makeOld(connection: DatabaseConnection, authz: AppAuthorization): Promise<void> {
  for (const key of TARGETS) {
    const set = await authz.permissionSets.get(key);
    if (!set) throw new Error(`permission set ${key} is missing`);
    const next = grantsOf(set).filter(
      (grant) => !grant.resource.id.startsWith('docPrint'),
    );
    await connection.query
      .updateTable('authorizationPermissionSets')
      .set({ grants: JSON.stringify(next) })
      .where('key', '=', key)
      .execute();
  }
}

const expected = (key: string): Record<string, string[]> => ({
  warehouse: {
    docPrintInternalIssue: ['print'],
    docPrintSalesIssue: ['print'],
    docPrintPurchaseReceipt: ['print'],
  },
  purchase: { docPrintPurchaseReceipt: ['print', 'printPrice'] },
  sales: { docPrintSalesIssue: ['print', 'printPrice'] },
})[key] ?? {};

test('新环境 seed 已按最窄口径落地：仓管无价格，采购/销售只在自己的单据上有价格', async ({ app }) => {
  const authz = app.container.resolve(authorizationToken);
  const users = app.container.resolve(userManagementServiceToken);
  for (const key of TARGETS) {
    const set = await authz.permissionSets.get(key);
    expect(set, `seed 应当有 ${key}`).toBeDefined();
    for (const [resource, actions] of Object.entries(expected(key))) {
      const grant = grantsOf(set!).find((entry) => entry.resource.id === resource);
      expect(grant?.actions.map((entry) => entry.action).sort(), `${key}/${resource}`).toEqual([...actions].sort());
    }
    expect(grantsOf(set!).some((grant) => grant.resource.id.startsWith('docPrint'))).toBe(
      key === 'warehouse' || key === 'purchase' || key === 'sales',
    );
  }
  const keeper = await makeUser(users, 'r076seedkeeper', 'warehouse');
  const buyer = await makeUser(users, 'r076seedbuyer', 'purchase');
  const seller = await makeUser(users, 'r076seedseller', 'sales');
  const staff = await makeUser(users, 'r076seedstaff', 'staff');
  expect(await can(authz, keeper, 'docPrintInternalIssue', 'print')).toBe(true);
  expect(await can(authz, keeper, 'docPrintInternalIssue', 'printPrice')).toBe(false);
  expect(await can(authz, keeper, 'docPrintPurchaseReceipt', 'printPrice')).toBe(false);
  expect(await can(authz, buyer, 'docPrintPurchaseReceipt', 'printPrice')).toBe(true);
  expect(await can(authz, buyer, 'docPrintSalesIssue', 'print')).toBe(false);
  expect(await can(authz, seller, 'docPrintSalesIssue', 'printPrice')).toBe(true);
  expect(await can(authz, seller, 'docPrintPurchaseReceipt', 'print')).toBe(false);
  expect(await can(authz, staff, 'docPrintInternalIssue', 'print')).toBe(false);
});

test('旧环境只补三个角色的打印授权，别的角色逐项不变，重跑不写', async ({ app, connection }) => {
  const authz = app.container.resolve(authorizationToken);
  const users = app.container.resolve(userManagementServiceToken);
  await makeOld(connection, authz);
  const keeper = await makeUser(users, 'r076upgradekeeper', 'warehouse');
  expect(await can(authz, keeper, 'docPrintPurchaseReceipt', 'print')).toBe(false);

  const before = new Map<string, Snapshot>();
  for (const key of [...TARGETS, ...OTHERS]) before.set(key, await snapshot(authz, key));

  const report = await upgradeR076(services(app), { info: () => undefined });
  expect(report.changed).toEqual([...TARGETS]);
  expect(report.unchanged).toEqual([]);
  expect(report.missing).toEqual([]);
  expect(report.invalid).toEqual([]);

  for (const key of TARGETS) {
    const after = await snapshot(authz, key);
    expect(after.revision).not.toBe(before.get(key)!.revision);
    expect(after.grants.slice(0, before.get(key)!.grants.length)).toEqual(before.get(key)!.grants);
    for (const [resource, actions] of Object.entries(expected(key))) {
      const grant = after.grants.find((entry) => entry.resource.id === resource);
      expect(grant?.actions.map((entry) => entry.action).sort(), `${key}/${resource}`).toEqual([...actions].sort());
    }
  }
  for (const key of OTHERS) {
    expect(await snapshot(authz, key), `${key} 不该被动`).toEqual(before.get(key));
  }

  const after = new Map<string, Snapshot>();
  for (const key of TARGETS) after.set(key, await snapshot(authz, key));
  const second = await upgradeR076(services(app), { info: () => undefined });
  expect(second.changed).toEqual([]);
  expect(second.unchanged).toEqual([...TARGETS]);
  for (const key of [...TARGETS, ...OTHERS]) {
    expect(await snapshot(authz, key), `${key} 重跑不该变化`).toEqual(
      TARGETS.includes(key as (typeof TARGETS)[number])
        ? after.get(key)
        : before.get(key),
    );
  }
});

test('声明对不上时该角色整条跳过、不写库', async ({ app, connection }) => {
  const authz = app.container.resolve(authorizationToken);
  await makeOld(connection, authz);
  const before = new Map<string, Snapshot>();
  for (const key of [...TARGETS, ...OTHERS]) before.set(key, await snapshot(authz, key));
  const real = authz.compositeResources.getAction.bind(authz.compositeResources);
  const spy = vi
    .spyOn(authz.compositeResources, 'getAction')
    .mockImplementation((id, action) => (id === 'docPrintSalesIssue' && action === 'printPrice' ? undefined : real(id, action)));
  try {
    const report = await upgradeR076(services(app), { info: () => undefined });
    expect(report.invalid).toEqual(['sales']);
    expect(report.changed).toEqual(['warehouse', 'purchase']);
    expect(await snapshot(authz, 'sales')).toEqual(before.get('sales'));
    expect(await snapshot(authz, 'staff')).toEqual(before.get('staff'));
  } finally {
    spy.mockRestore();
  }
});

test('命令挂在 authz 主题下，声明与种子一致', () => {
  expect(AuthzUpgradeR076.summary).toContain('print');
  expect(AuthzUpgradeR076.description).toContain('printPrice');
});
