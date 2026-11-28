// @vitest-environment node
import { authorizationToken } from '@nocobase/app-plugin-authorization';
import { expect } from 'vitest';

import { upgradeR066 } from '../../cli/authz/upgrade-r066.js';
import { createAppTest } from '../helpers/test-app.js';
import { createStandaloneServer } from '../../server/standalone.js';

/** R-066 验收 7：升级命令补齐缺失授权、重跑不写、别的角色不动。 */
const test = createAppTest({
  createServer: createStandaloneServer,
  config: {
    app: { publicOrigin: 'http://localhost' },
    auth: { secret: 'test-auth-secret-at-least-32-characters' },
  },
});

const RESOURCE = 'financeRequests';

type Grants = readonly {
  resource: { type: string; id: string };
  actions: readonly { action: string; policy?: { scopes?: Record<string, unknown> } }[];
}[];

const actionsOf = (grants: Grants): readonly string[] =>
  grants
    .filter((grant) => grant.resource.type === 'composite' && grant.resource.id === RESOURCE)
    .flatMap((grant) => grant.actions.map((action) => action.action));

test('升级命令补回被删掉的请款单授权，重跑不写，别的角色不动', async ({ app }) => {
  const authz = app.container.resolve(authorizationToken);
  const before = new Map((await authz.permissionSets.list()).map((set) => [set.key, set.revision]));
  const staff = (await authz.permissionSets.get('staff'))!;
  const grants = staff.grants as unknown as Grants;
  const trimmed = grants.filter((grant) => grant.resource.id !== RESOURCE);
  expect(trimmed.length).toBeLessThan(grants.length);
  await authz.permissionSets.update('staff', { key: 'staff', grants: trimmed as never }, staff.revision!);

  const changed = await upgradeR066({ authorization: authz }, { info: () => {} });
  expect(changed.changed).toEqual(['staff']);
  expect(changed.unchanged).toEqual(['finance']);
  expect(changed.missing).toEqual([]);
  expect(changed.invalid).toEqual([]);
  expect(actionsOf((await authz.permissionSets.get('staff'))!.grants as unknown as Grants)).toEqual([
    'view', 'create', 'update', 'submit', 'void',
  ]);
  const scoped = ((await authz.permissionSets.get('staff'))!.grants as unknown as Grants)
    .filter((grant) => grant.resource.id === RESOURCE)
    .flatMap((grant) => grant.actions);
  expect(scoped.every((action) => action.policy?.scopes?.financeRequestDocs === 'financeRequest.creatorOwn')).toBe(true);

  const revision = (await authz.permissionSets.get('staff'))!.revision;
  const again = await upgradeR066({ authorization: authz }, { info: () => {} });
  expect(again.changed).toEqual([]);
  expect(again.unchanged).toEqual(['staff', 'finance']);
  expect((await authz.permissionSets.get('staff'))!.revision).toBe(revision);
  for (const [key, value] of before) {
    if (key === 'staff') continue;
    expect((await authz.permissionSets.get(key))!.revision, `${key} 不该被改动`).toBe(value);
  }
}, 30_000);
