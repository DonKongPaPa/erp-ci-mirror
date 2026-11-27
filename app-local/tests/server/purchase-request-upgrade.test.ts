// @vitest-environment node
import { authorizationToken } from '@nocobase/app-plugin-authorization';
import { expect } from 'vitest';

import { upgradeR021PurchaseRequest } from '../../cli/authz/upgrade-r021-purchase-request.js';
import { createAppTest } from '../helpers/test-app.js';
import { createStandaloneServer } from '../../server/standalone.js';

/** R-021 波 1 加片验收 6：升级命令补齐缺失授权、重跑不写、别的角色不动。 */
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

test('升级命令补回被删掉的请购单授权，重跑不写，别的角色不动', async ({ app }) => {
  const authz = app.container.resolve(authorizationToken);
  const before = new Map(
    (await authz.permissionSets.list()).map((set) => [set.key, set.revision]),
  );
  const planning = (await authz.permissionSets.get('planning'))!;
  const grants = planning.grants as unknown as Grants;
  const trimmed = grants.filter((grant) => grant.resource.id !== 'purchaseRequests');
  expect(trimmed.length).toBeLessThan(grants.length);
  await authz.permissionSets.update(
    'planning',
    { key: 'planning', grants: trimmed as never },
    planning.revision!,
  );

  const changed = await upgradeR021PurchaseRequest(
    { authorization: authz }, { info: () => {} },
  );
  expect(changed.changed).toEqual(['planning']);
  expect(changed.unchanged).toEqual(['staff', 'purchase']);
  expect(changed.missing).toEqual([]);
  expect(changed.invalid).toEqual([]);
  expect(actionsOf((await authz.permissionSets.get('planning'))!.grants as unknown as Grants,
    'purchaseRequests')).toEqual(['view', 'create', 'update', 'submit', 'void']);

  const revision = (await authz.permissionSets.get('planning'))!.revision;
  const again = await upgradeR021PurchaseRequest(
    { authorization: authz }, { info: () => {} },
  );
  expect(again.changed).toEqual([]);
  expect(again.unchanged).toEqual(['planning', 'staff', 'purchase']);
  expect((await authz.permissionSets.get('planning'))!.revision).toBe(revision);
  for (const [key, value] of before) {
    if (key === 'planning') continue;
    expect((await authz.permissionSets.get(key))!.revision, `${key} 不该被改动`).toBe(value);
  }
}, 30_000);
