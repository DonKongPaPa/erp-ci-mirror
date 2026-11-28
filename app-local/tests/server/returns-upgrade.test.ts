// @vitest-environment node
import {
  authorizationToken,
  type AppAuthorization,
} from '@nocobase/app-plugin-authorization';
import type { DatabaseConnection } from '@nocobase/db';
import { expect, vi } from 'vitest';

import AuthzUpgradeR020Returns, {
  neededGrants,
  TARGETS,
  upgradeR020Returns,
  type R020ReturnsUpgradeServices,
} from '../../cli/authz/upgrade-r020-returns.js';
import { createAppTest } from '../helpers/test-app.js';
import { createStandaloneServer } from '../../server/standalone.js';

/** R-020 波 2 加片二升级命令：只加不改、幂等、带 revision，声明对不上整条跳过。 */
const test = createAppTest({
  scope: 'test',
  createServer: createStandaloneServer,
  config: {
    app: { publicOrigin: 'http://localhost' },
    auth: { secret: 'test-auth-secret-at-least-32-characters' },
  },
});

const services = (
  app: { container: { resolve(token: typeof authorizationToken): AppAuthorization } },
): R020ReturnsUpgradeServices => ({ authorization: app.container.resolve(authorizationToken) });

type JsonGrant = { resource: { type: string; id: string }; actions: { action: string }[] };
const grantsOf = (set: { grants: unknown }): JsonGrant[] =>
  JSON.parse(JSON.stringify(set.grants)) as JsonGrant[];

async function stripReturnGrants(connection: DatabaseConnection, key: string): Promise<void> {
  const row = await connection.query
    .selectFrom('authorizationPermissionSets')
    .select('grants')
    .where('key', '=', key)
    .executeTakeFirstOrThrow();
  const stored = JSON.parse(String(row.grants)) as JsonGrant[];
  const next = stored.filter((grant) =>
    !(grant.resource.type === 'composite' &&
      ['purchaseReturns', 'salesReturns'].includes(grant.resource.id)));
  await connection.query
    .updateTable('authorizationPermissionSets')
    .set({ grants: JSON.stringify(next) })
    .where('key', '=', key)
    .execute();
}

const RESOURCE_IDS = ['purchaseReturns', 'salesReturns'];

test('R-020 退货: seed 已含四个角色的新授权，声明与命令一致', async ({ app }) => {
  const authz = app.container.resolve(authorizationToken);
  expect(TARGETS).toEqual(['purchase', 'sales', 'warehouse', 'finance']);
  expect(neededGrants('someone-else')).toEqual([]);
  expect(AuthzUpgradeR020Returns.description).toContain('purchaseReturns');
  for (const target of TARGETS) {
    const set = await authz.permissionSets.get(target);
    expect(set, `seed 应当建 ${target}`).toBeDefined();
    const grants = grantsOf(set!);
    for (const wanted of neededGrants(target)) {
      const found = grants.find((entry) =>
        entry.resource.type === wanted.resource.type && entry.resource.id === wanted.resource.id);
      expect(found, `${target} 缺少 ${wanted.resource.id}`).toBeDefined();
      for (const action of wanted.actions) {
        expect(found?.actions.map((entry) => entry.action)).toContain(action.action);
      }
    }
  }
  // 本片授权只落在四个角色上，别的角色一点不含。
  for (const target of ['staff', 'quality_manager', 'quality_inspector', 'dept_manager']) {
    const grants = grantsOf((await authz.permissionSets.get(target))!);
    expect(grants.filter((grant) => RESOURCE_IDS.includes(grant.resource.id))).toEqual([]);
  }
});

test('R-020 退货: 升级命令补出缺的授权，重跑不写，别的角色不动', async ({ app, connection }) => {
  const authz = app.container.resolve(authorizationToken);
  for (const target of TARGETS) await stripReturnGrants(connection, target);
  const before = (await authz.permissionSets.list()).find((set) => set.key === 'staff');
  const beforeRevision = (await authz.permissionSets.get('warehouse'))?.revision;
  const report = await upgradeR020Returns(services(app), { info: () => {} });
  expect(report.changed).toEqual([...TARGETS]);
  expect(report.unchanged).toEqual([]);
  expect(report.invalid).toEqual([]);
  expect(report.missing).toEqual([]);

  for (const target of TARGETS) {
    const grants = grantsOf((await authz.permissionSets.get(target))!);
    for (const wanted of neededGrants(target)) {
      expect(grants.some((entry) =>
        entry.resource.id === wanted.resource.id &&
        wanted.actions.every((action) => entry.actions.some((have) => have.action === action.action)),
      ), `${target} 的 ${wanted.resource.id} 没补上`).toBe(true);
    }
  }
  expect((await authz.permissionSets.list()).find((set) => set.key === 'staff')).toEqual(before);
  expect((await authz.permissionSets.get('warehouse'))?.revision).not.toBe(beforeRevision);

  const revision = (await authz.permissionSets.get('warehouse'))?.revision;
  const again = await upgradeR020Returns(services(app), { info: () => {} });
  expect(again.unchanged).toEqual([...TARGETS]);
  expect(again.changed).toEqual([]);
  expect((await authz.permissionSets.get('warehouse'))?.revision).toBe(revision);
});

test('R-020 退货: 声明对不上时整条跳过，不写任何角色', async ({ app, connection }) => {
  const authz = app.container.resolve(authorizationToken);
  await stripReturnGrants(connection, 'finance');
  const before = grantsOf((await authz.permissionSets.get('finance'))!);
  const revision = (await authz.permissionSets.get('finance'))?.revision;
  const getAction = vi.spyOn(authz.compositeResources, 'getAction').mockReturnValue(undefined);
  try {
    const report = await upgradeR020Returns(services(app), { info: () => {} });
    expect(report.invalid).toEqual([...TARGETS]);
    expect(report.changed).toEqual([]);
  } finally {
    getAction.mockRestore();
  }
  expect(grantsOf((await authz.permissionSets.get('finance'))!)).toEqual(before);
  expect((await authz.permissionSets.get('finance'))?.revision).toBe(revision);
});
