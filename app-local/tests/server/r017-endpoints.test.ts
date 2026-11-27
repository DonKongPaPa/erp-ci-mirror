// @vitest-environment node
import { randomUUID } from 'node:crypto';

import {
  DEFAULT_ADMIN_CREDENTIALS,
  signIn,
  type TestSession,
} from '@nocobase/app-plugin-authentication/testing';
import { authorizationToken } from '@nocobase/app-plugin-authorization';
import type { Application } from '@nocobase/app-server/application';
import { expect } from 'vitest';

import { createAppTest } from '../helpers/test-app.js';
import { createStandaloneServer } from '../../server/standalone.js';

/**
 * R-017 M3：审批端点的授权与隔离。全在真 Postgres 的应用里跑。
 *
 * 先授权后读内容、行级资格与「不存在」同形、候选人只回三列、写端点要 Origin、
 * 业务角色调不了框架用户列表 —— 每一条都对着验收 D3/D4/D5/C5h。
 * 测试数据一律编造；邮箱只是「不能按邮箱匹配」的诱饵。
 */
const test = createAppTest({
  scope: 'test',
  createServer: createStandaloneServer,
  config: {
    app: { publicOrigin: 'http://localhost' },
    auth: { secret: 'test-auth-secret-at-least-32-characters' },
  },
});

const ORIGIN = 'http://localhost';
const PASSWORD = 'R017-endpoint-test-123!';
const TIMEOUT = 30_000;
const marker = () => randomUUID().replaceAll('-', '').slice(0, 10);

interface Row {
  [key: string]: unknown;
}

const init = (body: unknown = {}, method = 'POST'): RequestInit => ({
  method,
  headers: {
    'content-type': 'application/json',
    origin: ORIGIN,
    'x-request-id': 'r017-compare',
    'Idempotency-Key': `${Date.now()}.${randomUUID()}`,
  },
  body: JSON.stringify(body),
});

const read = (): RequestInit => ({
  method: 'GET',
  headers: { 'x-request-id': 'r017-compare' },
});

async function bodyOf(response: Response): Promise<Row> {
  const text = await response.text();
  let parsed: Row;
  try {
    parsed = JSON.parse(text) as Row;
  } catch {
    parsed = { raw: text };
  }
  return { ...parsed, _text: text };
}

async function expectStatus(response: Response, status: number): Promise<Row> {
  const body = await bodyOf(response);
  expect(response.status).toBe(status);
  return body;
}

async function makeUser(
  admin: TestSession,
  testApp: Parameters<typeof signIn>[0],
  app: Application,
  role: 'staff' | 'sales' | 'none',
): Promise<{ id: string; session: TestSession; name: string; email: string }> {
  const suffix = marker();
  const name = `审批${suffix}`;
  const username = `r017${suffix}`;
  const email = `mail${suffix}@example.test`;
  const created = await expectStatus(
    await admin.fetch(
      '/users',
      init({
        name,
        username,
        email,
        password: PASSWORD,
        roleScopes: role === 'sales' ? { app: ['sales'] } : { app: [] },
      }),
    ),
    201,
  );
  const id = String((created.data as Row | undefined)?.id ?? created.id ?? '');
  expect(id).not.toBe('');
  const authz = app.container.resolve(authorizationToken);
  if (role !== 'staff') {
    await authz.permissionSets.revoke(`user:${id}:staff`);
  }
  const session = await signIn(testApp, { username, password: PASSWORD });
  return { id, session, name, email };
}

async function createApproval(
  session: TestSession,
  approvers: readonly string[],
  candidates: readonly string[] = [],
  amount = 10,
): Promise<Row> {
  const body = await expectStatus(
    await session.fetch(
      '/approvals',
      init({
        collectionName: 'leaveRequests',
        dataKey: `leave-${marker()}`,
        workflowKey: 'leave',
        data: { amount, approvers: [...approvers], candidates: [...candidates] },
        submit: true,
      }),
    ),
    201,
  );
  return (body.data ?? {}) as Row;
}

async function tasksOf(session: TestSession, scope = 'pending'): Promise<Row[]> {
  const body = await expectStatus(
    await session.fetch(`/approvals/tasks?scope=${scope}`, read()),
    200,
  );
  return (body.data ?? []) as Row[];
}

test('没有审批授权：staff 之外的角色与零角色用户全部 403', async ({
  testApp,
  app,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const seller = await makeUser(admin, testApp, app, 'sales');
  const nobody = await makeUser(admin, testApp, app, 'none');
  const staff = await makeUser(admin, testApp, app, 'staff');
  const paths = [
    ['/approvals/mine', read()],
    ['/approvals/tasks', read()],
    ['/approvals', init({ collectionName: 'x', dataKey: 'x', workflowKey: 'leave', data: {}, submit: false })],
  ] as const;
  for (const who of [seller, nobody]) {
    for (const [path, options] of paths) {
      const response = await who.session.fetch(path, options);
      expect(response.status, `${path} 不该放行`).toBe(403);
    }
    expect(
      (await who.session.fetch('/users', read())).status,
      '业务角色不该拿到框架用户列表',
    ).toBe(403);
  }
  expect((await staff.session.fetch('/approvals/mine', read())).status).toBe(200);
}, TIMEOUT);

test('写端点缺 Origin 一律 403，且邮箱不出现在任何响应里', async ({
  testApp,
  app,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const applicant = await makeUser(admin, testApp, app, 'staff');
  const withoutOrigin: RequestInit = {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ collectionName: 'leaveRequests', dataKey: 'x', workflowKey: 'leave', data: {}, submit: false }),
  };
  const response = await applicant.session.fetch('/approvals', withoutOrigin);
  expect(response.status).toBe(403);
  const csrf = (await bodyOf(response)).error;
  expect(csrf?.reason).toBe('INVALID_CSRF_ORIGIN');
  const created = await createApproval(applicant.session, [applicant.id]);
  const detail = await expectStatus(
    await applicant.session.fetch(`/approvals/${String(created.id)}`, read()),
    200,
  );
  expect(JSON.stringify(detail)).not.toContain(applicant.email);
}, TIMEOUT);

test('不是自己的单与不存在的单 404 逐字节一致；详情只回姓名不含邮箱', async ({
  testApp,
  app,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const owner = await makeUser(admin, testApp, app, 'staff');
  const other = await makeUser(admin, testApp, app, 'staff');
  const created = await createApproval(owner.session, [owner.id]);
  const id = String(created.id);
  const missing = await bodyOf(
    await other.session.fetch(`/approvals/no-such-id-${marker()}`, read()),
  );
  const foreign = await bodyOf(
    await other.session.fetch(`/approvals/${id}`, read()),
  );
  expect(foreign.status ?? 404).toBe(404);
  expect(foreign._text).toBe(missing._text);
  const detail = await expectStatus(
    await owner.session.fetch(`/approvals/${id}`, read()),
    200,
  );
  const text = JSON.stringify(detail);
  expect(text).not.toContain(owner.email);
}, TIMEOUT);

test('我的申请与我的待办按申请人/审批人隔离，状态过滤正确', async ({
  testApp,
  app,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const applicant = await makeUser(admin, testApp, app, 'staff');
  const approver = await makeUser(admin, testApp, app, 'staff');
  const outsider = await makeUser(admin, testApp, app, 'staff');
  const created = await createApproval(applicant.session, [approver.id]);
  const mine = await expectStatus(
    await applicant.session.fetch('/approvals/mine?scope=active', read()),
    200,
  );
  expect((mine.data as Row[]).map((row) => row.id)).toContain(created.id);
  const othersMine = await expectStatus(
    await outsider.session.fetch('/approvals/mine?scope=active', read()),
    200,
  );
  expect((othersMine.data as Row[]).map((row) => row.id)).not.toContain(created.id);
  const tasks = await tasksOf(approver.session);
  expect(tasks).toHaveLength(1);
  expect(String(tasks[0]?.approvalId)).toBe(String(created.id));
  expect(await tasksOf(outsider.session)).toHaveLength(0);
}, TIMEOUT);

test('通过、拒绝、退回、撤回与作废都经状态转移；不是自己的任务 404 同形', async ({
  testApp,
  app,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const applicant = await makeUser(admin, testApp, app, 'staff');
  const approver = await makeUser(admin, testApp, app, 'staff');
  const outsider = await makeUser(admin, testApp, app, 'staff');
  await createApproval(applicant.session, [approver.id]);
  const [task] = await tasksOf(approver.session);
  expect(task).toBeDefined();
  const taskId = String(task!.id);

  const missing = await bodyOf(
    await outsider.session.fetch(`/approvals/tasks/no-such-${marker()}/approve`, init({})),
  );
  const foreign = await bodyOf(
    await outsider.session.fetch(`/approvals/tasks/${taskId}/approve`, init({})),
  );
  expect(foreign._text).toBe(missing._text);

  const approved = await expectStatus(
    await approver.session.fetch(`/approvals/tasks/${taskId}/approve`, init({ comment: '同意' })),
    200,
  );
  expect((approved.data as Row | undefined)?.status).toBe('approved');
  const after = await expectStatus(
    await approver.session.fetch(`/approvals/tasks/${taskId}/approve`, init({})),
    409,
  );
  expect(after.error?.reason).toBeDefined();

  const rejected = await createApproval(applicant.session, [approver.id]);
  const [rejectTask] = await tasksOf(approver.session);
  // 上一单已终态，待办里只剩新建的这一条。
  expect(String(rejectTask?.approvalId)).toBe(String(rejected.id));
  await expectStatus(
    await approver.session.fetch(`/approvals/tasks/${String(rejectTask!.id)}/reject`, init({ comment: '不同意' })),
    200,
  );

  const returned = await createApproval(applicant.session, [approver.id]);
  const [returnTask] = await tasksOf(approver.session);
  await expectStatus(
    await approver.session.fetch(`/approvals/tasks/${String(returnTask!.id)}/return`, init({ comment: '补材料' })),
    200,
  );
  const resubmit = await expectStatus(
    await applicant.session.fetch(`/approvals/${String(returned.id)}`, init({ data: { amount: 10, approvers: [approver.id] }, submit: true }, 'PATCH')),
    200,
  );
  expect((resubmit.data as Row).currentRound).toBe(2);

  const pending = await createApproval(applicant.session, [approver.id]);
  const withdrawn = await expectStatus(
    await applicant.session.fetch(`/approvals/${String(pending.id)}/withdraw`, init({})),
    200,
  );
  expect((withdrawn.data as Row).status).toBe('draft');
  const aborted = await expectStatus(
    await applicant.session.fetch(`/approvals/${String(pending.id)}/abort`, init({})),
    200,
  );
  expect((aborted.data as Row).status).toBe('aborted');
  const terminal = await expectStatus(
    await applicant.session.fetch(`/approvals/${String(pending.id)}/withdraw`, init({})),
    422,
  );
  expect(terminal.error?.reason).toBeDefined();
}, TIMEOUT);

test('候选人：只有本任务审批人能调，只回三列，转交与加签只落在候选人范围', async ({
  testApp,
  app,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const applicant = await makeUser(admin, testApp, app, 'staff');
  const approver = await makeUser(admin, testApp, app, 'staff');
  const candidate = await makeUser(admin, testApp, app, 'staff');
  const outsider = await makeUser(admin, testApp, app, 'staff');
  await createApproval(applicant.session, [approver.id], [candidate.id, outsider.id]);
  const [task] = await tasksOf(approver.session);
  const taskId = String(task!.id);

  const path = `/approvals/tasks/${taskId}/candidates?type=delegate&q=&page=1&pageSize=20`;
  const notFound = await bodyOf(
    await outsider.session.fetch(`/approvals/tasks/no-such-${marker()}/candidates?type=delegate&q=`, read()),
  );
  const foreign = await bodyOf(await outsider.session.fetch(path, read()));
  expect(foreign._text).toBe(notFound._text);
  const listed = await expectStatus(await approver.session.fetch(path, read()), 200);
  const rows = (listed.data ?? []) as Row[];
  // 候选人范围之外的人（申请人、管理员）不能被搜出来。
  expect(new Set(rows.map((row) => row.id))).toEqual(
    new Set([candidate.id, outsider.id]),
  );
  for (const row of rows) {
    expect(Object.keys(row).sort()).toEqual(['id', 'name', 'username']);
    expect(JSON.stringify(row)).not.toContain('@');
  }
  const mailOnly = await expectStatus(
    await approver.session.fetch(`/approvals/tasks/${taskId}/candidates?type=delegate&q=${encodeURIComponent(marker())}&page=1&pageSize=20`, read()),
    200,
  );
  expect((mailOnly.data as Row[]).filter((row) => row.id === candidate.id)).toHaveLength(0);

  const delegated = await expectStatus(
    await approver.session.fetch(`/approvals/tasks/${taskId}/delegate`, init({ toUserId: candidate.id, comment: '转给你' })),
    200,
  );
  expect((delegated.data as Row).status).toBe('processing');
  await expectStatus(
    await approver.session.fetch(`/approvals/tasks/${taskId}/add-sign`, init({ userIds: [candidate.id], comment: '加签', position: 'before' })),
    409,
  );

  const second = await createApproval(applicant.session, [approver.id], [candidate.id]);
  const [secondTask] = await tasksOf(approver.session);
  const added = await expectStatus(
    await approver.session.fetch(`/approvals/tasks/${String(secondTask!.id)}/add-sign`, init({ userIds: [candidate.id], comment: '加签', position: 'before' })),
    200,
  );
  expect((added.data as Row).status).toBe('processing');
  expect(String(second!.id)).not.toBe('');
}, TIMEOUT);

test('并发：两个审批人同时处理同一任务，只有一个成功', async ({
  testApp,
  app,
  connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const applicant = await makeUser(admin, testApp, app, 'staff');
  const approver = await makeUser(admin, testApp, app, 'staff');
  await createApproval(applicant.session, [approver.id]);
  const [task] = await tasksOf(approver.session);
  const taskId = String(task!.id);
  // 不放睡眠：两条真请求各自开事务，靠任务行的条件更新裁决。
  const [left, right] = await Promise.all([
    approver.session.fetch(`/approvals/tasks/${taskId}/approve`, init({ comment: 'A' })),
    approver.session.fetch(`/approvals/tasks/${taskId}/approve`, init({ comment: 'B' })),
  ]);
  const statuses = [left.status, right.status].sort();
  expect(statuses).toEqual([200, 409]);
  const row = await connection.query
    .selectFrom('approvalRecords')
    .select(['status'])
    .where('id', '=', taskId)
    .executeTakeFirstOrThrow();
  expect(row.status).toBe('approved');
}, TIMEOUT);
