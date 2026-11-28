// @vitest-environment node
import {
  authorizationToken,
  type AppAuthorization,
} from '@nocobase/app-plugin-authorization';
import type { DatabaseConnection } from '@nocobase/db';
import { expect, vi } from 'vitest';

import AuthzUpgradeR023Mes, {
  neededGrants,
  PRODUCTION_TARGET,
  TARGETS,
  upgradeR023Mes,
  type R023MesUpgradeServices,
} from '../../cli/authz/upgrade-r023-mes.js';
import { createAppTest } from '../helpers/test-app.js';
import { createStandaloneServer } from '../../server/standalone.js';

/**
 * R-023 W3-1 升级命令：建 production、只加不改、幂等、带 revision，
 * 声明对不上整条跳过；重跑不写、revision 不变。
 */
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
): R023MesUpgradeServices => ({ authorization: app.container.resolve(authorizationToken) });

type JsonGrant = {
  resource: { type: string; id: string };
  actions: { action: string }[];
};
const grantsOf = (set: { grants: unknown }): JsonGrant[] =>
  JSON.parse(JSON.stringify(set.grants)) as JsonGrant[];

async function stripMesGrants(connection: DatabaseConnection, key: string): Promise<void> {
  const row = await connection.query
    .selectFrom('authorizationPermissionSets').select('grants')
    .where('key', '=', key).executeTakeFirstOrThrow();
  const stored = JSON.parse(String(row.grants)) as JsonGrant[];
  const next = stored.filter((grant) =>
    !(grant.resource.type === 'composite' && grant.resource.id === 'mesSettings'));
  await connection.query.updateTable('authorizationPermissionSets')
    .set({ grants: JSON.stringify(next) }).where('key', '=', key).execute();
}

test('R-023 W3-1: 种子已给各角色准备好本片动作，声明与命令一致', async ({ app }) => {
  const authz = app.container.resolve(authorizationToken);
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
  expect(AuthzUpgradeR023Mes.description).toContain('mesSettings.view');
  expect(AuthzUpgradeR023Mes.description).toContain('production');
  expect(neededGrants('someone-else')).toEqual([]);
  expect((await authz.permissionSets.get(PRODUCTION_TARGET))?.title).toEqual({
    key: 'permissionSets.business.production', ns: 'app-local',
  });
});

test('R-023 W3-1: 缺 production 时新建，缺动作时只补，重跑不写且 revision 不变', async ({
  app, connection,
}) => {
  const authz = app.container.resolve(authorizationToken);
  for (const target of TARGETS.filter((key) => key !== PRODUCTION_TARGET)) {
    await stripMesGrants(connection, target);
  }
  await connection.query.deleteFrom('authorizationPermissionSets')
    .where('key', '=', PRODUCTION_TARGET).execute();
  const beforeStaff = (await authz.permissionSets.list()).find((set) => set.key === 'staff');
  const beforeRevision = (await authz.permissionSets.get('warehouse'))?.revision;

  const report = await upgradeR023Mes(services(app), { info: () => {} });
  expect(report.changed.sort()).toEqual(
    TARGETS.filter((key) => key !== PRODUCTION_TARGET).sort(),
  );
  expect(report.created).toEqual([PRODUCTION_TARGET]);
  expect(report.unchanged).toEqual([]);
  expect(report.invalid).toEqual([]);
  expect(report.missing).toEqual([]);

  for (const target of TARGETS) {
    const grants = grantsOf((await authz.permissionSets.get(target))!);
    const wanted = neededGrants(target)[0]!;
    expect(grants.some((entry) =>
      entry.resource.id === wanted.resource.id &&
      wanted.actions.every((action) => entry.actions.some((have) => have.action === action.action)),
    ), `${target} 的 mesSettings 动作没补上`).toBe(true);
  }
  expect((await authz.permissionSets.list()).find((set) => set.key === 'staff')).toEqual(beforeStaff);
  expect((await authz.permissionSets.get('warehouse'))?.revision).not.toBe(beforeRevision);

  const revision = (await authz.permissionSets.get('warehouse'))?.revision;
  const again = await upgradeR023Mes(services(app), { info: () => {} });
  expect(again.unchanged.sort()).toEqual([...TARGETS].sort());
  expect(again.changed).toEqual([]);
  expect(again.created).toEqual([]);
  expect((await authz.permissionSets.get('warehouse'))?.revision).toBe(revision);
});

test('R-023 W3-1: 声明对不上时整条跳过，不写任何角色', async ({ app, connection }) => {
  const authz = app.container.resolve(authorizationToken);
  await stripMesGrants(connection, 'finance');
  const before = grantsOf((await authz.permissionSets.get('finance'))!);
  const revision = (await authz.permissionSets.get('finance'))?.revision;
  const getAction = vi.spyOn(authz.compositeResources, 'getAction').mockReturnValue(undefined);
  try {
    const report = await upgradeR023Mes(services(app), { info: () => {} });
    expect(report.invalid).toEqual([...TARGETS]);
    expect(report.changed).toEqual([]);
    expect(report.created).toEqual([]);
  } finally {
    getAction.mockRestore();
  }
  expect(grantsOf((await authz.permissionSets.get('finance'))!)).toEqual(before);
  expect((await authz.permissionSets.get('finance'))?.revision).toBe(revision);
});
