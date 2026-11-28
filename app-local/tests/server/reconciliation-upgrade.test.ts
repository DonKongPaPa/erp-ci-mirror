// @vitest-environment node
import { authorizationToken } from '@nocobase/app-plugin-authorization';
import { expect } from 'vitest';

import { createAppTest } from '../helpers/test-app.js';
import { upgradeR065Reconcile } from '../../cli/authz/upgrade-r065-reconcile.js';
import { createStandaloneServer } from '../../server/standalone.js';

/** R-065 复刻波 2 验收 7：升级命令补齐本片授权、重跑不写；别的角色与已有授权不动。 */
const test = createAppTest({
  createServer: createStandaloneServer,
  config: {
    app: { publicOrigin: 'http://localhost' },
    auth: { secret: 'test-auth-secret-at-least-32-characters' },
  },
});

const RESOURCES = [
  ['incomeRecords', ['view', 'create', 'update', 'confirm', 'void']],
  ['saleInvoiceRecords', ['view', 'create', 'update', 'confirm', 'void']],
  ['receivableRecons', ['view', 'create', 'update', 'confirm', 'void']],
  ['payableRecons', ['view', 'create', 'update', 'confirm', 'void']],
  ['salesOrders', ['financeView']],
] as const;

type Grants = readonly {
  resource: { type: string; id: string };
  actions: readonly { action: string }[];
}[];

const actionsOf = (grants: Grants, id: string): readonly string[] =>
  grants
    .filter((grant) => grant.resource.type === 'composite' && grant.resource.id === id)
    .flatMap((grant) => grant.actions.map((action) => action.action));

test('升级命令补齐被删掉的本片授权，重跑不写，别的角色不动', async ({ app }) => {
  const authz = app.container.resolve(authorizationToken);
  const before = new Map(
    (await authz.permissionSets.list()).map((set) => [set.key, set.revision]),
  );

  const finance = (await authz.permissionSets.get('finance'))!;
  const grants = finance.grants as unknown as Grants;
  const kept = grants.filter((grant) => !RESOURCES.some(([id]) => grant.resource.id === id));
  expect(kept.length, '前置条件：finance 原本带着本片授权').toBeLessThan(grants.length);
  await authz.permissionSets.update('finance', { key: 'finance', grants: kept as never }, finance.revision!);

  const changed = await upgradeR065Reconcile({ authorization: authz }, { info: () => {} });
  expect(changed.changed).toEqual(['finance']);
  expect(changed.created).toEqual([]);
  expect(changed.unchanged).toEqual([]);
  expect(changed.missing).toEqual([]);
  expect(changed.invalid).toEqual([]);

  const after = (await authz.permissionSets.get('finance'))!.grants as unknown as Grants;
  for (const [id, actions] of RESOURCES) {
    expect(actionsOf(after, id), `${id} 的动作`).toEqual([...actions]);
  }
  // 已有的 slice-1 授权一份不改、不重排。
  expect(after.slice(0, kept.length)).toEqual(kept);

  const revision = (await authz.permissionSets.get('finance'))!.revision;
  const again = await upgradeR065Reconcile({ authorization: authz }, { info: () => {} });
  expect(again.changed).toEqual([]);
  expect(again.unchanged).toEqual(['finance']);
  expect((await authz.permissionSets.get('finance'))!.revision).toBe(revision);
  for (const [key, value] of before) {
    if (key === 'finance') continue;
    expect((await authz.permissionSets.get(key))!.revision, `${key} 不该被改动`).toBe(value);
  }
}, 30_000);

test('升级命令在没有 finance 角色的旧环境建出角色，只带本片声明的授权', async ({ app }) => {
  const authz = app.container.resolve(authorizationToken);
  expect(await authz.permissionSets.get('finance')).toBeDefined();
  await authz.permissionSets.delete('finance');
  const lines: string[] = [];
  const report = await upgradeR065Reconcile(
    { authorization: authz }, { info: (line) => lines.push(line) },
  );
  expect(report.created).toEqual(['finance']);
  const grants = (await authz.permissionSets.get('finance'))!.grants as unknown as Grants;
  for (const [id, actions] of RESOURCES) {
    expect(actionsOf(grants, id), `${id} 的动作`).toEqual([...actions]);
  }
  expect(lines.join('\n')).toContain('role created');

  const again = await upgradeR065Reconcile({ authorization: authz }, { info: () => {} });
  expect(again.unchanged).toEqual(['finance']);
  expect(again.created).toEqual([]);
}, 30_000);
