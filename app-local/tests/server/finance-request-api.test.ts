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
import {
  createDictEntry,
  createEmployee,
  get,
  write,
  type Row,
} from '../helpers/orders.js';
import { createStandaloneServer } from '../../server/standalone.js';
import { financeRequestsServiceToken } from '../../server/providers/finance-requests.js';

/**
 * R-066 端到端：建 → 提交 → 审批通过 → 转支出记录草稿；拒绝、重复、双向断言与并发。
 * 真 Postgres，测试数据一律编造；邮箱只作「不外泄」的诱饵。
 */
const test = createAppTest({
  createServer: createStandaloneServer,
  config: {
    app: { publicOrigin: 'http://localhost' },
    auth: { secret: 'test-auth-secret-at-least-32-characters' },
  },
});

const PATH = '/finance-requests';
const TIMEOUT = 30_000;
const PASSWORD = 'R066-request-test-123!';
const marker = () => randomUUID().replaceAll('-', '').slice(0, 10);

interface Body extends Row {
  id?: string;
  status?: string;
  docNo?: string;
  approvalId?: string | null;
  expenseRecordId?: string | null;
  amount?: number;
  reason?: string;
  handler?: Row;
  files?: Row[];
  expenseTypeLabel?: string | null;
  projectLabel?: string | null;
  request?: Row;
  error?: { reason?: string };
}

async function bodyOf(response: Response): Promise<Body & { _text: string }> {
  const text = await response.text();
  let parsed: Body;
  try {
    parsed = JSON.parse(text) as Body;
  } catch {
    parsed = { raw: text };
  }
  return { ...parsed, _text: text };
}

async function expectStatus(response: Response, status: number): Promise<Body & { _text: string }> {
  const body = await bodyOf(response);
  expect(response.status, `期望 ${status}，实际 ${response.status}：${body._text}`).toBe(status);
  return body;
}

async function makeUser(
  admin: TestSession,
  testApp: Parameters<typeof signIn>[0],
  roles: readonly string[],
): Promise<{ id: string; email: string; session: TestSession }> {
  const username = `r066${marker()}`;
  const email = `${username}@example.test`;
  const created = await expectStatus(
    await admin.fetch('/users', write({
      name: username,
      username,
      email,
      password: PASSWORD,
      roleScopes: { app: [...roles] },
    })),
    201,
  );
  const id = String((created.data as Row | undefined)?.id ?? created.id ?? '');
  expect(id).not.toBe('');
  return { id, email, session: await signIn(testApp, { username, password: PASSWORD }) };
}

async function pendingTask(session: TestSession, approvalId?: string): Promise<Row> {
  const body = await expectStatus(
    await session.fetch('/approvals/tasks?scope=pending', get()),
    200,
  );
  const rows = ((body.data ?? []) as Row[]).filter(
    (row) => approvalId === undefined || String(row.approvalId) === approvalId,
  );
  expect(rows.length, `审批 ${approvalId ?? ''} 的任务应有一张待处理`).toBeGreaterThanOrEqual(1);
  return rows[0]!;
}

/**
 * 候选人是 finance 在岗员工与 root，单节点沿 R-017 默认会签：全部任务都通过才终态。
 * 任务 id 与经办人从真库里读，逐个用对应会话批准，避免共享 root 跨测试留下的任务干扰。
 */
async function approveAll(
  approver: { readonly id: string; readonly session: TestSession },
  testApp: Parameters<typeof signIn>[0],
  approvalId: string,
  connection: Parameters<typeof createDictEntry>[0],
): Promise<void> {
  const rootSession = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const rootRow = await connection.query
    .selectFrom('user').select('id').where('username', '=', 'nocobase').executeTakeFirst();
  const rootId = String(rootRow?.id ?? '');
  expect(rootId, '默认管理员账号应存在').not.toBe('');
  for (;;) {
    const rows = await connection.query
      .selectFrom('approvalRecords')
      .innerJoin('approvalRounds', 'approvalRecords.roundId', 'approvalRounds.id')
      .select([
        'approvalRecords.id as id',
        'approvalRecords.assigneeId as assigneeId',
      ])
      .where('approvalRounds.approvalId', '=', approvalId)
      .where('approvalRecords.status', '=', 'pending')
      .execute();
    if (rows.length === 0) break;
    const task = rows[0]!;
    const isRoot = String(task.assigneeId) === rootId;
    expect(isRoot || String(task.assigneeId) === approver.id, `意外的审批人 ${String(task.assigneeId)}`).toBe(true);
    const session = isRoot ? rootSession : approver.session;
    await expectStatus(
      await session.fetch(`/approvals/tasks/${String(task.id)}/approve`, write({ comment: '同意' })),
      200,
    );
  }
}

/** 测试库跨用例共用：只留本用例新造的 finance 审批人，避免旧审批人累积成会签票。 */
async function isolateFinance(testApp: Parameters<typeof signIn>[0], keeperId: string): Promise<void> {
  const app = (testApp as unknown as { application: Application }).application;
  const sets = app.container.resolve(authorizationToken).permissionSets;
  for (const assignment of await sets.listAssignments('finance')) {
    if (assignment.subject.type === 'user' && assignment.subject.id !== keeperId) {
      await sets.revoke(`user:${assignment.subject.id}:finance`);
    }
  }
}

async function makeDraft(
  session: TestSession,
  extra: Record<string, unknown> = {},
): Promise<Body> {
  const body = await expectStatus(
    await session.fetch(PATH, write({ docType: 'payment_request', amount: 128.5, reason: '差旅报销', ...extra })),
    201,
  );
  expect(body.status).toBe('draft');
  return body;
}

test('正向：建 → 提交 → 审批通过 → 转一张支出记录草稿（金额、类型、经办人、事由一致）', async ({
  testApp, connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const staff = await makeUser(admin, testApp, ['staff']);
  const approver = await makeUser(admin, testApp, ['finance']);
  await isolateFinance(testApp, approver.id);
  await createEmployee(connection, staff.id);
  const expenseType = `ET-${marker()}`;
  const project = `PJ-${marker()}`;
  await createDictEntry(connection, 'expense_type', expenseType);
  await createDictEntry(connection, 'project', project);

  const form = new FormData();
  form.append('file', new File(['附件内容'], '凭证.pdf', { type: 'application/pdf' }));
  const file = await expectStatus(
    await staff.session.fetch('/doc-files', {
      method: 'POST', headers: { origin: 'http://localhost' }, body: form,
    }),
    201,
  );

  const draft = await makeDraft(staff.session, {
    expenseTypeCode: expenseType, projectCode: project, fileIds: [String(file.id)],
  });
  expect(String(draft.docNo)).toMatch(/^QK-\d{8}-\d{4,}$/u);
  expect(draft).toMatchObject({ status: 'draft', amount: 128.5, approvalId: null });
  expect(draft.expenseTypeLabel).toEqual(expect.any(String));
  expect(draft.projectLabel).toEqual(expect.any(String));
  expect(draft.handler).toEqual({ userId: staff.id, name: expect.any(String) });
  expect(Object.keys(draft)).not.toContain('createdById');
  expect(Object.keys(draft.handler ?? {})).toEqual(['userId', 'name']);
  expect(JSON.stringify(draft)).not.toContain(staff.email);
  expect(Object.keys(draft.files?.[0] ?? {})).toEqual(['id', 'name', 'contentType', 'size']);

  const submitted = await expectStatus(
    await staff.session.fetch(`${PATH}/${String(draft.id)}/submit`, write()), 200,
  );
  expect(submitted.status).toBe('approving');
  expect(String(submitted.approvalId ?? '')).not.toBe('');

  const before = await expectStatus(await staff.session.fetch(`${PATH}/${String(draft.id)}`, get()), 200);
  expect(before.status, '审批通过之前状态不变').toBe('approving');
  await approveAll({ id: approver.id, session: approver.session }, testApp, String(submitted.approvalId ?? ''), connection);
  expect((await expectStatus(await staff.session.fetch(`${PATH}/${String(draft.id)}`, get()), 200)).status).toBe('approved');

  const converted = await expectStatus(
    await approver.session.fetch(`${PATH}/${String(draft.id)}/create-expense`, write()), 200,
  );
  const expenseRecordId = String(converted.expenseRecordId ?? '');
  expect(expenseRecordId).not.toBe('');
  expect(converted.request?.status).toBe('converted');
  expect(converted.request?.expenseRecordId).toBe(expenseRecordId);

  const record = await expectStatus(await admin.fetch(`/expenses/${expenseRecordId}`, get()), 200);
  expect(record.status).toBe('draft');
  expect(record.totalAmount).toBe(128.5);
  expect(record.expenseTypeCode).toBe(expenseType);
  expect(record.handler).toEqual({ userId: staff.id, name: expect.any(String) });
  expect(record.remark).toBe('差旅报销');
  expect(record.bindMode).toBe('none');
  expect(record.payeeName).toBeNull();
  expect(record.lines).toHaveLength(0);
  // 附件不复制：支出记录上没有来源单的文件。
  expect(record.files).toHaveLength(0);
  // 回链可查：来源单上记着转出去的标识。
  expect((await expectStatus(await staff.session.fetch(`${PATH}/${String(draft.id)}`, get()), 200)).expenseRecordId).toBe(expenseRecordId);
}, TIMEOUT);

test('报销单走同一条流程；没批不能转、重复转被拒、非 finance 转 403', async ({ testApp, connection }) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const staff = await makeUser(admin, testApp, ['staff']);
  const approver = await makeUser(admin, testApp, ['finance']);
  await isolateFinance(testApp, approver.id);
  await createEmployee(connection, staff.id);

  const draft = await expectStatus(
    await staff.session.fetch(PATH, write({ docType: 'expense_claim', amount: 60, reason: '市内交通' })),
    201,
  );
  expect(String(draft.docNo)).toMatch(/^BX-\d{8}-\d{4,}$/u);

  const notApproved = await expectStatus(
    await approver.session.fetch(`${PATH}/${String(draft.id)}/create-expense`, write()), 422,
  );
  expect(notApproved.error?.reason).toBe('FINANCE_REQUEST_NOT_APPROVED');
  expect((await staff.session.fetch(`${PATH}/${String(draft.id)}/create-expense`, write())).status).toBe(403);

  const submitted = await expectStatus(
    await staff.session.fetch(`${PATH}/${String(draft.id)}/submit`, write()), 200,
  );
  expect((await expectStatus(
    await approver.session.fetch(`${PATH}/${String(draft.id)}/create-expense`, write()), 422,
  )).error?.reason).toBe('FINANCE_REQUEST_NOT_APPROVED');
  await approveAll({ id: approver.id, session: approver.session }, testApp, String(submitted.approvalId ?? ''), connection);
  await expectStatus(
    await approver.session.fetch(`${PATH}/${String(draft.id)}/create-expense`, write()), 200,
  );
  const again = await expectStatus(
    await approver.session.fetch(`${PATH}/${String(draft.id)}/create-expense`, write()), 422,
  );
  expect(again.error?.reason).toBe('FINANCE_REQUEST_CONVERTED');
}, TIMEOUT);

test('拒绝与退回各写回一次；重复处理被 409 挡住；驳回后重提开新审批', async ({ testApp, connection }) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const staff = await makeUser(admin, testApp, ['staff']);
  const approver = await makeUser(admin, testApp, ['finance']);
  await isolateFinance(testApp, approver.id);
  await createEmployee(connection, staff.id);
  const draft = await makeDraft(staff.session);

  const first = await expectStatus(await staff.session.fetch(`${PATH}/${String(draft.id)}/submit`, write()), 200);
  const firstApprovalId = String(first.approvalId ?? '');
  const rejectTask = await pendingTask(approver.session, firstApprovalId);
  await expectStatus(
    await approver.session.fetch(`/approvals/tasks/${String(rejectTask.id)}/reject`, write({ comment: '不合格' })),
    200,
  );
  expect((await expectStatus(await staff.session.fetch(`${PATH}/${String(draft.id)}`, get()), 200)).status).toBe('rejected');
  expect((await approver.session.fetch(`/approvals/tasks/${String(rejectTask.id)}/reject`, write())).status).toBe(409);
  expect((await expectStatus(await staff.session.fetch(`${PATH}/${String(draft.id)}`, get()), 200)).status).toBe('rejected');

  const resubmit = await expectStatus(await staff.session.fetch(`${PATH}/${String(draft.id)}/submit`, write()), 200);
  expect(resubmit.status).toBe('approving');
  expect(String(resubmit.approvalId ?? '')).not.toBe('');
  expect(resubmit.approvalId).not.toBe(firstApprovalId);
  expect((await expectStatus(
    await approver.session.fetch(`${PATH}/${String(draft.id)}/create-expense`, write()), 422,
  )).error?.reason).toBe('FINANCE_REQUEST_NOT_APPROVED');

  const returnTask = await pendingTask(approver.session, String(resubmit.approvalId ?? ''));
  await expectStatus(
    await approver.session.fetch(`/approvals/tasks/${String(returnTask.id)}/return`, write({ comment: '补材料' })),
    200,
  );
  expect((await expectStatus(await staff.session.fetch(`${PATH}/${String(draft.id)}`, get()), 200)).status).toBe('rejected');
}, TIMEOUT);

test('拒绝：金额为 0、经办人离职、字典码停用、非草稿改、没有 DELETE', async ({ testApp, connection }) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const staff = await makeUser(admin, testApp, ['staff']);
  const approver = await makeUser(admin, testApp, ['finance']);
  await isolateFinance(testApp, approver.id);
  await createEmployee(connection, staff.id);
  const left = await makeUser(admin, testApp, ['staff']);
  await createEmployee(connection, left.id, 'left');
  const inactive = `ET-${marker()}`;
  await createDictEntry(connection, 'expense_type', inactive, 'inactive');

  const zero = await expectStatus(
    await staff.session.fetch(PATH, write({ docType: 'payment_request', amount: 0 })), 422,
  );
  expect(zero.error?.reason).toBe('FINANCE_REQUEST_AMOUNT_INVALID');
  const decimals = await expectStatus(
    await staff.session.fetch(PATH, write({ docType: 'payment_request', amount: 1.234 })), 422,
  );
  expect(decimals.error?.reason).toBe('FINANCE_REQUEST_AMOUNT_INVALID');
  const person = await expectStatus(
    await staff.session.fetch(PATH, write({ docType: 'payment_request', amount: 10, handlerUserId: left.id })), 422,
  );
  expect(person.error?.reason).toBe('FINANCE_REQUEST_PERSON_INVALID');
  const dict = await expectStatus(
    await staff.session.fetch(PATH, write({ docType: 'payment_request', amount: 10, expenseTypeCode: inactive })), 422,
  );
  expect(dict.error?.reason).toBe('FINANCE_REQUEST_DICT_CODE_INVALID');

  const draft = await makeDraft(staff.session);
  await expectStatus(await staff.session.fetch(`${PATH}/${String(draft.id)}/submit`, write()), 200);
  const edit = await expectStatus(
    await staff.session.fetch(`${PATH}/${String(draft.id)}`, write({ reason: '改过的说明' }, 'PATCH')), 422,
  );
  expect(edit.error?.reason).toBe('FINANCE_REQUEST_NOT_EDITABLE');
  const removed = await admin.fetch(`${PATH}/${String(draft.id)}`, {
    method: 'DELETE', headers: { origin: 'http://localhost' },
  });
  expect([404, 405]).toContain(removed.status);
  void approver;
}, TIMEOUT);

test('并发：同一张单同时转出，只有一个成功；草稿与回链都不重复（两个真事务，不用睡眠）', async ({
  app, testApp, database, connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const staff = await makeUser(admin, testApp, ['staff']);
  const approver = await makeUser(admin, testApp, ['finance']);
  await isolateFinance(testApp, approver.id);
  await createEmployee(connection, staff.id);
  const reason = `并发-${marker()}`;
  const draft = await makeDraft(staff.session, { reason });
  const id = String(draft.id ?? '');
  const submitted = await expectStatus(
    await staff.session.fetch(`${PATH}/${id}/submit`, write()), 200,
  );
  await approveAll({ id: approver.id, session: approver.session }, testApp, String(submitted.approvalId ?? ''), connection);

  const service = app.container.resolve(financeRequestsServiceToken);
  // 直接测服务层：端点已授权，这里只核对两个真事务的回写与草稿不重复。
  const policy = undefined;

  const entered = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
  const bothEntered = Promise.withResolvers<void>();
  const results: string[] = [];
  const attempt = (index: number) => database.transaction(async (tx) => {
    entered[index]!.resolve();
    await bothEntered.promise;
    try {
      await service.convert(id, { id: staff.id }, policy, tx);
      results.push('ok');
    } catch (error) {
      results.push(error instanceof Error ? error.message : String(error));
    }
  });

  // 两个真事务先各自进入回调再一起放行；测试本身不持行锁，
  // 唯一能挡住第二笔的只有服务里的 SELECT … FOR UPDATE。
  const first = attempt(0);
  const second = attempt(1);
  try {
    await Promise.all(entered.map((gate) => gate.promise));
  } finally {
    bothEntered.resolve();
  }
  await Promise.all([first, second]);

  expect(results.filter((entry) => entry === 'ok')).toHaveLength(1);
  const stored = await connection.repository<Row>('financeRequestDocs').findOne({ filter: { id } });
  expect(stored?.status).toBe('converted');
  const expenseRecordId = String(stored?.expenseRecordId ?? '');
  expect(expenseRecordId).not.toBe('');
  const drafts = await connection.query
    .selectFrom('expenseRecords')
    .select(['id']).where('remark', '=', reason).execute();
  expect(drafts).toHaveLength(1);
  expect(drafts[0]?.id).toBe(expenseRecordId);
}, TIMEOUT);
