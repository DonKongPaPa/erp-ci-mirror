// @vitest-environment node
import { expect } from 'vitest';

import seed, {
  APPROVAL_GRANT,
  grantStaffApprovalActions,
  type StoredGrant,
} from '../../database/main/seeds/202611280002_seed_staff_approval_grants.js';
import { createAppTest } from '../helpers/test-app.js';
import { createStandaloneServer } from '../../server/standalone.js';

/**
 * R-017 M3：新种子在三种情形下的行为。真库，直接改 `authorizationPermissionSets`
 * 的 grants 列造「已有/管理员改过/全新」三种环境，再调用同一个 seed 函数。
 *
 * 原种子 202611240001 不被改名、不被改写；这里只验新种子的 append 与幂等。
 */
const test = createAppTest({
  scope: 'test',
  createServer: createStandaloneServer,
  config: {
    app: { publicOrigin: 'http://localhost' },
    auth: { secret: 'test-auth-secret-at-least-32-characters' },
  },
});

const CUSTOM: StoredGrant = {
  resource: { type: 'page', id: 'custom-page' },
  actions: [{ action: 'access' }],
};

async function grantsOf(query: Parameters<typeof grantStaffApprovalActions>[0]) {
  const row = await query
    .selectFrom('authorizationPermissionSets')
    .select(['grants'])
    .where('key', '=', 'staff')
    .executeTakeFirstOrThrow();
  const raw = (row as { grants?: unknown }).grants;
  return typeof raw === 'string'
    ? (JSON.parse(raw) as StoredGrant[])
    : (raw as StoredGrant[]);
}

async function setGrants(
  query: Parameters<typeof grantStaffApprovalActions>[0],
  grants: readonly StoredGrant[],
) {
  await query
    .updateTable('authorizationPermissionSets')
    .set({ grants: JSON.stringify(grants) })
    .where('key', '=', 'staff')
    .execute();
}

test('新种子：seed 名字固定，动作与范围只给本人', () => {
  expect(seed.name).toBe('202611280002_seed_staff_approval_grants');
  expect(APPROVAL_GRANT.resource).toEqual({ type: 'composite', id: 'approval' });
  expect(APPROVAL_GRANT.actions.map((entry) => entry.action)).toEqual([
    'submit',
    'review',
  ]);
  expect(APPROVAL_GRANT.actions[0]?.policy?.scopes).toEqual({
    approvals: 'approval.applicantOwn',
  });
  expect(APPROVAL_GRANT.actions[1]?.policy?.scopes).toEqual({
    approvalRecords: 'approval.assigneeOwn',
  });
});

test('已持有两个动作时不写，重复执行幂等', async ({ connection }) => {
  const query = connection.query;
  const before = await grantsOf(query);
  expect(before).toContainEqual(APPROVAL_GRANT);
  expect(await grantStaffApprovalActions(query)).toBe('already');
  expect(await grantsOf(query)).toEqual(before);
});

test('管理员改过 staff 后：保留他的授权、只补缺的审批动作', async ({
  connection,
}) => {
  const query = connection.query;
  const current = (await grantsOf(query)).filter(
    (grant) => grant.resource.id !== 'approval',
  );
  await setGrants(query, [CUSTOM, ...current]);
  expect(await grantStaffApprovalActions(query)).toBe('granted');
  const after = await grantsOf(query);
  expect(after[0]).toEqual(CUSTOM);
  expect(after).toContainEqual(APPROVAL_GRANT);
  expect(await grantStaffApprovalActions(query)).toBe('already');
  expect(await grantsOf(query)).toEqual(after);
});

test('全新库：staff 原来没有 approval 授权时补上两个动作；角色不存在时跳过', async ({
  connection,
}) => {
  const query = connection.query;
  const existing = (await grantsOf(query)).filter(
    (grant) => grant.resource.id !== 'approval',
  );
  await setGrants(query, existing);
  expect(
    (await grantsOf(query)).some((grant) => grant.resource.id === 'approval'),
  ).toBe(false);
  expect(await grantStaffApprovalActions(query)).toBe('granted');
  const after = await grantsOf(query);
  expect(after).toContainEqual(APPROVAL_GRANT);
  // 角色不存在：原种子会建它，新种子这一轮什么都不写。
  await query
    .deleteFrom('authorizationPermissionSets')
    .where('key', '=', 'staff')
    .execute();
  expect(await grantStaffApprovalActions(query)).toBe('missing-role');
});
