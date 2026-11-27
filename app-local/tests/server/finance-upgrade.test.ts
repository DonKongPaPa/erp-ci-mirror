// @vitest-environment node
import { authorizationToken } from '@nocobase/app-plugin-authorization';
import { expect } from 'vitest';

import { createAppTest } from '../helpers/test-app.js';
import { upgradeR065 } from '../../cli/authz/upgrade-r065.js';
import { createStandaloneServer } from '../../server/standalone.js';

/** R-065 验收 7：旧环境里没有 finance 角色时建出来，重跑不写；别的角色不动。 */
const test = createAppTest({
  createServer: createStandaloneServer,
  config: {
    app: { publicOrigin: 'http://localhost' },
    auth: { secret: 'test-auth-secret-at-least-32-characters' },
  },
});

type Grants = readonly {
  resource: { type: string; id: string };
  actions: readonly { action: string }[];
}[];

const actionsOf = (grants: Grants, id: string): readonly string[] =>
  grants
    .filter((grant) => grant.resource.type === 'composite' && grant.resource.id === id)
    .flatMap((grant) => grant.actions.map((action) => action.action));

test('升级命令在没有财务角色的旧环境建角色并补齐授权；重跑不写', async ({ app }) => {
  const authz = app.container.resolve(authorizationToken);
  const before = new Map(
    (await authz.permissionSets.list()).map((set) => [set.key, set.revision]),
  );
  expect(before.get('finance')).toBeDefined();
  await authz.permissionSets.delete('finance');
  expect(await authz.permissionSets.get('finance')).toBeUndefined();

  const lines: string[] = [];
  const created = await upgradeR065({ authorization: authz }, { info: (line) => lines.push(line) });
  expect(created.created).toEqual(['finance']);
  expect(created.changed).toEqual([]);
  const finance = await authz.permissionSets.get('finance');
  expect(finance).toBeDefined();
  expect(finance!.title).toEqual({ key: 'permissionSets.business.finance', ns: 'app-local' });
  const grants = finance!.grants as unknown as Grants;
  expect(actionsOf(grants, 'expenses')).toEqual(['view', 'create', 'update', 'confirm', 'void']);
  expect(actionsOf(grants, 'invoiceReceipts')).toEqual(['view', 'create', 'update', 'confirm', 'void']);
  expect(actionsOf(grants, 'purchaseOrders')).toEqual(['financeView']);
  expect(actionsOf(grants, 'bizDict')).toContain('view');
  expect(actionsOf(grants, 'bizOptions')).toContain('view');

  const revision = finance!.revision;
  const again = await upgradeR065({ authorization: authz }, { info: () => {} });
  expect(again.unchanged).toEqual(['finance']);
  expect(again.changed).toEqual([]);
  expect(again.created).toEqual([]);
  expect((await authz.permissionSets.get('finance'))!.revision).toBe(revision);
  for (const [key, value] of before) {
    if (key === 'finance') continue;
    expect((await authz.permissionSets.get(key))!.revision, `${key} 不该被改动`).toBe(value);
  }
  expect(lines.join('\n')).toContain('role created');
}, 30_000);
