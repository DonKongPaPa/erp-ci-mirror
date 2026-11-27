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

import AuthzUpgradeR020, {
  upgradeR020,
  type R020UpgradeServices,
} from '../../cli/authz/upgrade-r020.js';
import { createAppTest } from '../helpers/test-app.js';
import { createStandaloneServer } from '../../server/standalone.js';

/**
 * R-020 升级命令：已有环境里 seed 不会补 `warehouse` 角色的新授权，靠这条命令补。
 * 幂等、带 revision、声明对不上整条跳过、只加不改，别的角色一份都不动。
 */
const test = createAppTest({
  scope: 'test',
  createServer: createStandaloneServer,
  config: {
    app: { publicOrigin: 'http://localhost' },
    auth: { secret: 'test-auth-secret-at-least-32-characters' },
  },
});

const TARGET = 'warehouse';
const OTHER_ROLES = ['staff', 'quality_manager', 'quality_inspector', 'dept_manager', 'member'];
const ACTIONS = ['warehouseView', 'stockView', 'stockWrite', 'stockPost', 'stockVoid'] as const;
const PASSWORD = 'R020-upgrade-123!';

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
): R020UpgradeServices => ({ authorization: app.container.resolve(authorizationToken) });
const can = (authz: AppAuthorization, userId: string, action: string) =>
  authz.for({ principal: { type: 'user', id: userId } }).can({
    resource: { type: 'composite', id: 'inventory' },
    action,
  });
const createPerson = async (users: UserManagementService, name: string, roles?: readonly string[]) =>
  (await users.create({
    name,
    email: `${name}@example.test`,
    password: PASSWORD,
    ...(roles === undefined ? {} : { roleScopes: { app: [...roles] } }),
  })).id;

/** 造升级之前的环境：把 inventory 那条授权整条删掉，revision 不动。 */
async function makeOld(connection: DatabaseConnection, authz: AppAuthorization): Promise<void> {
  const set = await authz.permissionSets.get(TARGET);
  if (!set) throw new Error(`permission set ${TARGET} is missing`);
  const next = grantsOf(set).filter(
    (grant) => !(grant.resource.type === 'composite' && grant.resource.id === 'inventory'),
  );
  await connection.query
    .updateTable('authorizationPermissionSets')
    .set({ grants: JSON.stringify(next) })
    .where('key', '=', TARGET)
    .execute();
}

test('新环境 seed 已含仓管角色，五个动作齐备，别的角色一份都不给', async ({ app }) => {
  const authz = app.container.resolve(authorizationToken);
  const users = app.container.resolve(userManagementServiceToken);
  const set = await authz.permissionSets.get(TARGET);
  expect(set, 'seed 应当建 warehouse 角色').toBeDefined();
  const grant = grantsOf(set!).find(
    (entry) => entry.resource.type === 'composite' && entry.resource.id === 'inventory',
  );
  expect(grant?.actions.map((entry) => entry.action).sort()).toEqual([...ACTIONS].sort());
  // 仓库建改不在仓管手里。
  expect(grant?.actions.map((entry) => entry.action)).not.toContain('warehouseManage');

  const keeper = await createPerson(users, 'r020seedkeeper', [TARGET]);
  const staff = await createPerson(users, 'r020seedstaff', ['staff']);
  for (const action of ACTIONS) {
    expect(await can(authz, keeper, action), `仓管应当有 ${action}`).toBe(true);
    expect(await can(authz, staff, action), `普通员工不该有 ${action}`).toBe(false);
  }
  expect(await can(authz, keeper, 'warehouseManage')).toBe(false);
});

test('旧环境只补仓管的五个动作，别的角色逐项不变，重跑不写', async ({ app, connection }) => {
  const authz = app.container.resolve(authorizationToken);
  const users = app.container.resolve(userManagementServiceToken);
  await makeOld(connection, authz);
  const keeper = await createPerson(users, 'r020upgradeeper', [TARGET]);
  expect(await can(authz, keeper, 'stockView')).toBe(false);

  const before = new Map<string, Snapshot>();
  for (const key of [TARGET, ...OTHER_ROLES]) before.set(key, await snapshot(authz, key));

  const lines: string[] = [];
  const report = await upgradeR020(services(app), { info: (message) => lines.push(message) });
  expect(report.changed).toEqual([TARGET]);
  expect(report.unchanged).toEqual([]);
  expect(report.missing).toEqual([]);
  expect(report.invalid).toEqual([]);
  expect(lines.some((line) => line.includes('[r020] warehouse before:'))).toBe(true);
  expect(lines.some((line) => line.includes('[r020] warehouse after:'))).toBe(true);

  const after = await snapshot(authz, TARGET);
  expect(after.revision).not.toBe(before.get(TARGET)!.revision);
  expect(after.grants.slice(0, before.get(TARGET)!.grants.length)).toEqual(
    before.get(TARGET)!.grants,
  );
  expect(after.grants.length).toBe(before.get(TARGET)!.grants.length + 1);
  expect(after.grants.at(-1)?.actions.map((entry) => entry.action).sort()).toEqual(
    [...ACTIONS].sort(),
  );
  for (const action of ACTIONS) expect(await can(authz, keeper, action)).toBe(true);
  for (const key of OTHER_ROLES) {
    expect(await snapshot(authz, key), `${key} 不该被动`).toEqual(before.get(key));
  }

  const second = await upgradeR020(services(app), { info: () => undefined });
  expect(second.changed).toEqual([]);
  expect(second.unchanged).toEqual([TARGET]);
  for (const key of [TARGET, ...OTHER_ROLES]) {
    expect(await snapshot(authz, key), `${key} 重跑不该变化`).toEqual(
      key === TARGET ? after : before.get(key),
    );
  }
});

test('声明对不上时整条跳过、不写库', async ({ app, connection }) => {
  const authz = app.container.resolve(authorizationToken);
  await makeOld(connection, authz);
  const before = await snapshot(authz, TARGET);
  const real = authz.compositeResources.getAction.bind(authz.compositeResources);
  const spy = vi
    .spyOn(authz.compositeResources, 'getAction')
    .mockImplementation((id, action) => (action === 'stockPost' ? undefined : real(id, action)));
  try {
    const report = await upgradeR020(services(app), { info: () => undefined });
    expect(report.invalid).toEqual([TARGET]);
    expect(report.changed).toEqual([]);
    expect(await snapshot(authz, TARGET)).toEqual(before);
  } finally {
    spy.mockRestore();
  }
});

test('角色不存在时记一行跳过，别的角色不动', async ({ app, connection }) => {
  const authz = app.container.resolve(authorizationToken);
  const before = new Map<string, Snapshot>();
  for (const key of OTHER_ROLES) before.set(key, await snapshot(authz, key));
  await connection.query.deleteFrom('authorizationPermissionSets').where('key', '=', TARGET).execute();
  const lines: string[] = [];
  const report = await upgradeR020(services(app), { info: (line) => lines.push(line) });
  expect(report.missing).toEqual([TARGET]);
  expect(report.changed).toEqual([]);
  expect(lines.some((line) => line.includes(TARGET) && line.includes('not found'))).toBe(true);
  for (const key of OTHER_ROLES) {
    expect(await snapshot(authz, key)).toEqual(before.get(key));
  }
});

test('升级命令挂在 authz 主题下，声明与 seed 一致', () => {
  expect(AuthzUpgradeR020.summary).toContain('warehouse');
  expect(AuthzUpgradeR020.description).toContain('inventory');
});
