// @vitest-environment node
import { authorizationToken } from '@nocobase/app-plugin-authorization';
import { expect } from 'vitest';

import {
  upgradeR019Bom,
  type R019BomUpgradeServices,
} from '../../cli/authz/upgrade-r019-bom.js';
import {
  upgradeR019BomPages,
  type R019BomPagesUpgradeServices,
} from '../../cli/authz/upgrade-r019-bom-pages.js';
import { createAppTest } from '../helpers/test-app.js';
import { createStandaloneServer } from '../../server/standalone.js';

/**
 * R-019 波 2 验收 7：`upgrade-r019-bom` 在旧环境建 craft（同名只补授权）、
 * 给 craft 与 planning 补两个读动作；重跑不写、revision 不变，别的角色一行不动。
 */
const test = createAppTest({
  createServer: createStandaloneServer,
  config: {
    app: { publicOrigin: 'http://localhost' },
    auth: { secret: 'test-auth-secret-at-least-32-characters' },
  },
});

type Grants = readonly {
  resource: { type: string; id: string };
  actions: readonly { action: string; policy?: { scopes?: Record<string, unknown> } }[];
}[];

const bomActions = (grants: Grants): readonly string[] =>
  grants
    .filter((grant) => grant.resource.type === 'composite' && grant.resource.id === 'boms')
    .flatMap((grant) => grant.actions.map((action) => action.action).sort());

test('新环境 seed 已含两个读动作：升级命令重跑不写，revision 不变', async ({ app }) => {
  const authz = app.container.resolve(authorizationToken);
  const before = new Map(
    (await authz.permissionSets.list()).map((set) => [set.key, set.revision]),
  );
  const report = await upgradeR019Bom({ authorization: authz }, { info: () => {} });
  expect(report.targets).toEqual(['craft', 'planning']);
  expect(report.changed).toEqual([]);
  expect(report.created).toEqual([]);
  expect(report.unchanged).toEqual(['craft', 'planning']);
  expect(report.missing).toEqual([]);
  expect(report.invalid).toEqual([]);
  for (const [key, revision] of before) {
    expect((await authz.permissionSets.get(key))?.revision, `${key} 不该被改动`).toBe(revision);
  }
}, 30_000);

test('旧环境补齐被删掉的读动作，重跑不写；别的角色一行不动', async ({ app }) => {
  const authz = app.container.resolve(authorizationToken);
  for (const key of ['craft', 'planning']) {
    const set = (await authz.permissionSets.get(key))!;
    const trimmed = (set.grants as unknown as Grants).filter(
      (grant) => grant.resource.id !== 'boms',
    );
    expect(trimmed.length).toBeLessThan((set.grants as unknown as Grants).length);
    await authz.permissionSets.update(
      key, { key, grants: trimmed as never }, set.revision!,
    );
  }
  const others = new Map(
    (await authz.permissionSets.list())
      .filter((set) => !['craft', 'planning'].includes(set.key))
      .map((set) => [set.key, set.revision]),
  );

  const report = await upgradeR019Bom({ authorization: authz }, { info: () => {} });
  expect(report.changed).toEqual(['craft', 'planning']);
  expect(report.created).toEqual([]);
  for (const key of ['craft', 'planning']) {
    expect(bomActions((await authz.permissionSets.get(key))!.grants as unknown as Grants))
      .toEqual(['explode', 'view']);
  }
  const revision = (await authz.permissionSets.get('craft'))!.revision;
  const again = await upgradeR019Bom({ authorization: authz }, { info: () => {} });
  expect(again.changed).toEqual([]);
  expect((await authz.permissionSets.get('craft'))!.revision).toBe(revision);
  for (const [key, value] of others) {
    expect((await authz.permissionSets.get(key))?.revision, `${key} 不该被改动`).toBe(value);
  }
}, 30_000);

test('没有 craft 角色时只建 craft：词条、两个读动作、重跑不写', async ({
  app,
  connection,
}) => {
  const authz = app.container.resolve(authorizationToken);
  await connection.query
    .deleteFrom('authorizationPermissionSets')
    .where('key', '=', 'craft')
    .execute();
  expect(await authz.permissionSets.get('craft')).toBeUndefined();

  const report = await upgradeR019Bom({ authorization: authz }, { info: () => {} });
  expect(report.created).toEqual(['craft']);
  expect(report.changed).toEqual([]);
  const created = (await authz.permissionSets.get('craft'))!;
  expect(created.title).toEqual({ key: 'permissionSets.business.craft', ns: 'app-local' });
  expect(bomActions(created.grants as unknown as Grants)).toEqual(['explode', 'view']);
  expect((await authz.permissionSets.get('planning'))?.grants).toBeDefined();

  const again = await upgradeR019Bom({ authorization: authz }, { info: () => {} });
  expect(again.created).toEqual([]);
  expect(again.unchanged).toEqual(['craft', 'planning']);
}, 30_000);

test('声明对不上整条跳过：资源上没有 explode 动作时不写任何角色', async () => {
  const readonly = {
    permissionSets: {
      list: async () => [{ key: 'craft', grants: [], revision: 'r1' }],
      get: async () => undefined,
      create: async () => { throw new Error('不该建角色'); },
      update: async () => { throw new Error('不该写授权'); },
    },
    compositeResources: {
      getAction: (_id: string, action: string) => action !== 'explode',
      validateGrant: () => undefined,
    },
  } as unknown as R019BomUpgradeServices['authorization'];
  const report = await upgradeR019Bom(
    { authorization: readonly },
    { info: () => {} },
  );
  expect(report.invalid).toEqual(['craft', 'planning']);
  expect(report.changed).toEqual([]);
  expect(report.created).toEqual([]);
}, 30_000);

/** BOM 页面片：upgrade-r019-bom-pages 给 craft / planning 补 BOM 页授权，幂等且不动别的角色。 */
test('页面片升级：删掉页面授权后补齐，重跑不写且别的角色不变', async ({
  app,
}) => {
  const authz = app.container.resolve(authorizationToken);
  const services = { authorization: authz } as unknown as R019BomPagesUpgradeServices;
  const logger = { info: () => {} };
  // 同文件前面的 upgrade-r019-bom 用例按 resource.id 去掉过 boms 的两种授权：
  // 这里先把两个角色的页面授权显式清掉，模拟「已有环境还没补页面」的起点。
  for (const key of ['craft', 'planning']) {
    const set = (await authz.permissionSets.get(key))!;
    const trimmed = (set.grants as unknown as Grants).filter(
      (grant) => !(grant.resource.type === 'page' && grant.resource.id === 'boms'),
    );
await authz.permissionSets.update(
      key, { key, grants: trimmed as never }, set.revision!,
    );
  }
  const others = new Map(
    (await authz.permissionSets.list())
      .filter((set) => !['craft', 'planning'].includes(set.key))
      .map((set) => [set.key, set.revision]),
  );

  const fixed = await upgradeR019BomPages(services, logger);
  expect(fixed.pages.changed).toEqual(['craft', 'planning']);
  for (const key of ['craft', 'planning']) {
    const grants = (await authz.permissionSets.get(key))!.grants as unknown as Grants;
    expect(
      grants.some(
        (grant) =>
          grant.resource.type === 'page' &&
          grant.resource.id === 'boms' &&
          grant.actions.some((action) => action.action === 'access'),
      ),
    ).toBe(true);
  }
  const revision = (await authz.permissionSets.get('craft'))!.revision;
  expect((await upgradeR019BomPages(services, logger)).pages.changed).toEqual([]);
  expect((await authz.permissionSets.get('craft'))!.revision).toBe(revision);
  for (const [key, value] of others) {
    expect((await authz.permissionSets.get(key))?.revision, `${key} 不该被改动`).toBe(value);
  }
}, 30_000);
