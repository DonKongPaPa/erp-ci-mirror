// @vitest-environment node
import { randomUUID } from 'node:crypto';

import {
  DEFAULT_ADMIN_CREDENTIALS,
  signIn,
  type TestSession,
} from '@nocobase/app-plugin-authentication/testing';
import { expect } from 'vitest';

import { createAppTest } from '../helpers/test-app.js';
import { createItem } from '../helpers/inventory.js';
import {
  createDictEntry,
  createEmployee,
  get,
  unique,
  write,
  type Row,
} from '../helpers/orders.js';
import { createStandaloneServer } from '../../server/standalone.js';

/**
 * R-021 波 1 加片端到端：建草稿 → 提行 → 提交 → 审批 → 转采购订单，
 * 以及反向断言（没批不能转、重复转不能、预计价不进订单）。真 Postgres。
 * 测试数据一律编造；邮箱只是「不能外泄」的诱饵。
 */
const test = createAppTest({
  createServer: createStandaloneServer,
  config: {
    app: { publicOrigin: 'http://localhost' },
    auth: { secret: 'test-auth-secret-at-least-32-characters' },
  },
});

const PATH = '/purchase-requests';
const TIMEOUT = 30_000;
const marker = () => randomUUID().replaceAll('-', '').slice(0, 10);

interface Body extends Row {
  id?: string;
  status?: string;
  docNo?: string;
  approvalId?: string | null;
  convertedOrderId?: string | null;
  totalQty?: number;
  estimatedTotal?: number;
  department?: Row;
  requester?: Row;
  lines?: Row[];
  files?: Row[];
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
  prefix: string,
  roles: readonly string[],
): Promise<{ id: string; email: string; session: TestSession }> {
  const username = `r021${marker()}`;
  const email = `${username}@example.test`;
  void prefix;
  const created = await expectStatus(
    await admin.fetch('/users', write({
      name: username,
      username,
      email,
      password: 'R021-request-test-123!',
      roleScopes: { app: [...roles] },
    })),
    201,
  );
  const id = String((created.data as Body | undefined)?.id ?? created.id ?? '');
  expect(id).not.toBe('');
  return { id, email, session: await signIn(testApp, { username, password: 'R021-request-test-123!' }) };
}

async function makeDepartment(
  admin: TestSession,
  connection: Parameters<typeof createItem>[0],
  managerId: string,
): Promise<{ id: string; code: string }> {
  const tag = unique('DEPT');
  const created = await expectStatus(
    await admin.fetch('/departments', write({ title: `请购部${tag}`, code: tag, kind: 'department' })),
    201,
  );
  const data = (created.data ?? {}) as Body;
  const id = String(data.id ?? '');
  expect(id).not.toBe('');
  await connection.query.updateTable('departments')
    .set({ managerId, active: true }).where('id', '=', id).execute();
  return { id, code: tag };
}

async function createDraft(
  session: TestSession,
  departmentId: string,
  extra: Record<string, unknown> = {},
): Promise<Body> {
  const body = await expectStatus(
    await session.fetch(PATH, write({ departmentId, ...extra })),
    201,
  );
  expect(body.status).toBe('draft');
  return body;
}

async function pendingTask(session: TestSession): Promise<Row> {
  const body = await expectStatus(
    await session.fetch('/approvals/tasks?scope=pending', get()),
    200,
  );
  const rows = (body.data ?? []) as Row[];
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

test('正向：建草稿、提两行、提交、审批通过、转采购订单；预计价不写进订单', async ({
  testApp, connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const planner = await makeUser(admin, testApp, 'r021pr-planner', ['planning']);
  const approver = await makeUser(admin, testApp, 'r021pr-approver', ['staff']);
  const buyer = await makeUser(admin, testApp, 'r021pr-buyer', ['purchase']);
  await createEmployee(connection, planner.id);
  const department = await makeDepartment(admin, connection, approver.id);
  const itemA = await createItem(connection);
  const itemB = await createItem(connection);

  // 附件先上传（ownerId 为空），建单时整组绑定。
  const form = new FormData();
  form.append('file', new File(['附件内容'], '需求说明.pdf', { type: 'application/pdf' }));
  const file = await expectStatus(
    await planner.session.fetch('/doc-files', {
      method: 'POST',
      headers: { origin: 'http://localhost' },
      body: form,
    }),
    201,
  );

  const draft = await createDraft(planner.session, department.id, {
    description: '旺季备货', customText1: '自定义一', fileIds: [String(file.id)],
  });
  expect(String(draft.docNo)).toMatch(/^QG-\d{8}-\d{4,}$/u);
  expect(draft).toMatchObject({ status: 'draft', description: '旺季备货', approvalId: null });
  expect(Object.keys(draft)).not.toContain('createdById');

  const lined = await expectStatus(
    await planner.session.fetch(`${PATH}/${String(draft.id)}/lines`, write({
      lines: [
        { itemId: itemA, qty: 10, expectedPrice: 5 },
        { itemId: itemB, qty: 10, expectedPrice: 5 },
      ],
    })),
    200,
  );
  expect(lined.totalQty).toBe(20);
  expect(lined.estimatedTotal).toBe(100);
  expect(lined.lines).toHaveLength(2);
  expect(lined.lines?.[0]?.expectedAmount).toBe(50);
  expect(Object.keys(lined.lines?.[0]?.item ?? {})).not.toContain('purchasePrice');
  expect(Object.keys(lined.lines?.[0]?.item ?? {})).not.toContain('salesPrice');
  expect(Object.keys(lined.files?.[0] ?? {})).not.toContain('storageKey');
  expect(Object.keys(lined.files?.[0] ?? {})).not.toContain('createdById');

  const submitted = await expectStatus(
    await planner.session.fetch(`${PATH}/${String(draft.id)}/submit`, write()),
    200,
  );
  expect(submitted.status).toBe('approving');
  expect(String(submitted.approvalId ?? '')).not.toBe('');

  const task = await pendingTask(approver.session);
  const before = await expectStatus(
    await planner.session.fetch(`${PATH}/${String(draft.id)}`, get()), 200,
  );
  expect(before.status, '审批通过之前单据状态不变').toBe('approving');
  const approved = await expectStatus(
    await approver.session.fetch(`/approvals/tasks/${String(task.id)}/approve`, write({ comment: '同意' })),
    200,
  );
  expect((approved.data as Body | undefined)?.status).toBe('approved');
  const after = await expectStatus(
    await planner.session.fetch(`${PATH}/${String(draft.id)}`, get()), 200,
  );
  expect(after.status).toBe('approved');
  expect(after.requester).toEqual({ userId: planner.id, name: expect.any(String) });
  expect(after.department).toEqual({ id: department.id, name: expect.any(String) });
  expect(JSON.stringify(after)).not.toContain(planner.email);
  expect(JSON.stringify(after)).not.toContain('storageKey');
  expect(JSON.stringify(after)).not.toContain('createdById');

  const converted = await expectStatus(
    await buyer.session.fetch(`${PATH}/${String(draft.id)}/create-order`, write()),
    200,
  );
  const orderId = String(converted.purchaseOrderId ?? '');
  expect(orderId).not.toBe('');
  expect(converted.request?.status).toBe('converted');
  expect(converted.request?.convertedOrderId).toBe(orderId);

  const order = await expectStatus(
    await admin.fetch(`/purchase-orders/${orderId}`, get()), 200,
  );
  expect(order.status).toBe('draft');
  expect(order.purchaseRequestId).toBe(String(draft.id));
  expect(order.lines).toHaveLength(2);
  for (const line of order.lines ?? []) {
    expect(line.price, '预计单价不能写进订单价格').toBeNull();
    expect(line.taxRate).toBeNull();
    expect(line.taxExcludedPrice).toBeNull();
    expect(line.taxExcludedAmount).toBeNull();
    expect(line.taxAmount).toBeNull();
    expect(line.taxIncludedAmount).toBeNull();
  }
  const stored = await connection.repository<Row>('purchaseOrders').findOne({ filter: { id: orderId } });
  expect(stored?.purchaseRequestId).toBe(String(draft.id));
  expect(stored?.status).toBe('draft');
}, TIMEOUT);

test('批准之前转单被拒；重复转单被拒；非 purchase 角色转单 403', async ({
  testApp, connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const planner = await makeUser(admin, testApp, 'r021pr-gate-planner', ['planning']);
  const approver = await makeUser(admin, testApp, 'r021pr-gate-approver', ['staff']);
  const buyer = await makeUser(admin, testApp, 'r021pr-gate-buyer', ['purchase']);
  await createEmployee(connection, planner.id);
  const department = await makeDepartment(admin, connection, approver.id);
  const item = await createItem(connection);

  const draft = await createDraft(planner.session, department.id);
  await expectStatus(
    await planner.session.fetch(`${PATH}/${String(draft.id)}/lines`, write({
      lines: [{ itemId: item, qty: 2, expectedPrice: 5 }],
    })),
    200,
  );
  const notApproved = await expectStatus(
    await buyer.session.fetch(`${PATH}/${String(draft.id)}/create-order`, write()), 422,
  );
  expect(notApproved.error?.reason).toBe('PURCHASE_REQUEST_NOT_APPROVED');
  expect((await planner.session.fetch(`${PATH}/${String(draft.id)}/create-order`, write())).status).toBe(403);

  await expectStatus(
    await planner.session.fetch(`${PATH}/${String(draft.id)}/submit`, write()), 200,
  );
  const approving = await expectStatus(
    await buyer.session.fetch(`${PATH}/${String(draft.id)}/create-order`, write()), 422,
  );
  expect(approving.error?.reason).toBe('PURCHASE_REQUEST_NOT_APPROVED');

  const task = await pendingTask(approver.session);
  await expectStatus(
    await approver.session.fetch(`/approvals/tasks/${String(task.id)}/approve`, write()), 200,
  );
  await expectStatus(
    await buyer.session.fetch(`${PATH}/${String(draft.id)}/create-order`, write()), 200,
  );
  const again = await expectStatus(
    await buyer.session.fetch(`${PATH}/${String(draft.id)}/create-order`, write()), 422,
  );
  expect(again.error?.reason).toBe('PURCHASE_REQUEST_CONVERTED');
}, TIMEOUT);

test('审批拒绝与退回各写回一次；驳回后可改重提开新轮次', async ({
  testApp, connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const planner = await makeUser(admin, testApp, 'r021pr-rj-planner', ['planning']);
  const approver = await makeUser(admin, testApp, 'r021pr-rj-approver', ['staff']);
  await createEmployee(connection, planner.id);
  const department = await makeDepartment(admin, connection, approver.id);
  const item = await createItem(connection);

  const draft = await createDraft(planner.session, department.id);
  await expectStatus(
    await planner.session.fetch(`${PATH}/${String(draft.id)}/lines`, write({
      lines: [{ itemId: item, qty: 3 }],
    })),
    200,
  );
  const firstSubmit = await expectStatus(
    await planner.session.fetch(`${PATH}/${String(draft.id)}/submit`, write()), 200,
  );
  const firstApprovalId = String(firstSubmit.approvalId ?? '');
  expect(firstApprovalId).not.toBe('');
  const rejectTask = await pendingTask(approver.session);
  await expectStatus(
    await approver.session.fetch(`/approvals/tasks/${String(rejectTask.id)}/reject`, write({ comment: '不合格' })),
    200,
  );
  expect((await expectStatus(await planner.session.fetch(`${PATH}/${String(draft.id)}`, get()), 200)).status).toBe('rejected');
  // 重复处理同一任务不会写第二次状态：任务是 409，业务状态不变。
  const repeated = await approver.session.fetch(`/approvals/tasks/${String(rejectTask.id)}/reject`, write());
  expect(repeated.status).toBe(409);
  expect((await expectStatus(await planner.session.fetch(`${PATH}/${String(draft.id)}`, get()), 200)).status).toBe('rejected');

  const resubmit = await expectStatus(
    await planner.session.fetch(`${PATH}/${String(draft.id)}/submit`, write()), 200,
  );
  expect(resubmit.status).toBe('approving');
  expect(String(resubmit.approvalId ?? '')).not.toBe('');
  expect(String(resubmit.approvalId ?? '')).not.toBe(firstApprovalId);
  const oldApproval = await expectStatus(
    await planner.session.fetch(`/approvals/${firstApprovalId}`, get()), 200,
  );
  expect((oldApproval.data as Body | undefined)?.status).toBe('rejected');

  const returnTask = await pendingTask(approver.session);
  await expectStatus(
    await approver.session.fetch(`/approvals/tasks/${String(returnTask.id)}/return`, write({ comment: '补材料' })),
    200,
  );
  expect((await expectStatus(await planner.session.fetch(`${PATH}/${String(draft.id)}`, get()), 200)).status).toBe('rejected');
}, TIMEOUT);

test('规则码：部门必填、部门停用、请购人离职、项目码停用、提交无明细', async ({
  testApp, connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const planner = await makeUser(admin, testApp, 'r021pr-rule-planner', ['planning']);
  const approver = await makeUser(admin, testApp, 'r021pr-rule-approver', ['staff']);
  await createEmployee(connection, planner.id);
  const department = await makeDepartment(admin, connection, approver.id);
  const inactive = await makeDepartment(admin, connection, approver.id);
  await connection.query.updateTable('departments').set({ active: false })
    .where('id', '=', inactive.id).execute();
  const inactiveProject = `P-${marker()}`;
  await createDictEntry(connection, 'project', inactiveProject, 'inactive');
  const left = await makeUser(admin, testApp, 'r021pr-left', ['planning']);
  await createEmployee(connection, left.id, 'left');

  expect((await planner.session.fetch(PATH, write({ description: '没部门' }))).status).toBe(400);

  const missing = await expectStatus(
    await planner.session.fetch(PATH, write({ departmentId: `NO-${marker()}` })), 404,
  );
  expect(missing.error?.reason).toBe('DEPARTMENT_NOT_FOUND');
  const inactiveDept = await expectStatus(
    await planner.session.fetch(PATH, write({ departmentId: inactive.id })), 422,
  );
  expect(inactiveDept.error?.reason).toBe('DEPARTMENT_INACTIVE');
  const leftPerson = await expectStatus(
    await planner.session.fetch(PATH, write({ departmentId: department.id, requesterUserId: left.id })), 422,
  );
  expect(leftPerson.error?.reason).toBe('PURCHASE_REQUEST_PERSON_INVALID');
  const dict = await expectStatus(
    await planner.session.fetch(PATH, write({ departmentId: department.id, projectCode: inactiveProject })), 422,
  );
  expect(dict.error?.reason).toBe('PURCHASE_REQUEST_DICT_CODE_INVALID');

  const empty = await createDraft(planner.session, department.id);
  const noLines = await expectStatus(
    await planner.session.fetch(`${PATH}/${String(empty.id)}/submit`, write()), 422,
  );
  expect(noLines.error?.reason).toBe('PURCHASE_REQUEST_NO_LINES');
  const edit = await expectStatus(
    await planner.session.fetch(`${PATH}/${String(empty.id)}`, write({ description: '改过的说明' }, 'PATCH')),
    200,
  );
  expect(edit.status).toBe('draft');
  expect(edit.description).toBe('改过的说明');
}, TIMEOUT);
