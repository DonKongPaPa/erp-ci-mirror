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
  createEmployee,
  unique,
  write,
  type Row,
} from '../helpers/orders.js';
import { createStandaloneServer } from '../../server/standalone.js';

/**
 * 缺陷 1 的根因核查（真 Postgres）：R-021 写明「部门没配主管时回落到 root」。
 * 有主管时派给主管，没有主管（含逐级上报也无人）时派给 root；提交不该因部门编码失败。
 * 数据一律编造。
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

async function makeUser(
  admin: TestSession,
  testApp: Parameters<typeof signIn>[0],
  roles: readonly string[],
): Promise<{ id: string; session: TestSession }> {
  const username = `r6fb${marker()}`;
  const response = await admin.fetch('/users', write({
    name: username,
    username,
    email: `${username}@example.test`,
    password: 'R6-fallback-test-123!',
    roleScopes: { app: [...roles] },
  }));
  expect(response.status).toBe(201);
  const data = ((await response.json()) as { data: { id: string } }).data;
  return {
    id: data.id,
    session: await signIn(testApp, { username, password: 'R6-fallback-test-123!' }),
  };
}

/** managerId 为 undefined 时建一个没有主管的顶层部门。 */
async function makeDepartment(
  admin: TestSession,
  connection: Parameters<typeof createItem>[0],
  managerId?: string,
): Promise<{ id: string; code: string }> {
  const code = unique('DEPT');
  const response = await admin.fetch('/departments', write({ title: `请购部${code}`, code, kind: 'department' }));
  expect(response.status).toBe(201);
  const data = ((await response.json()) as { data: { id: string } }).data;
  if (managerId !== undefined) {
    await connection.query.updateTable('departments')
      .set({ managerId, active: true }).where('id', '=', data.id).execute();
  }
  return { id: data.id, code };
}

async function assigneesOf(
  connection: Parameters<typeof createItem>[0],
  approvalId: string,
): Promise<readonly string[]> {
  const rows = await connection.query
    .selectFrom('approvalRecords')
    .innerJoin('approvalRounds', 'approvalRecords.roundId', 'approvalRounds.id')
    .select('approvalRecords.assigneeId as assigneeId')
    .where('approvalRounds.approvalId', '=', approvalId)
    .execute();
  return rows.map((row) => String(row.assigneeId));
}

test('部门有主管时审批任务派给主管', async ({ testApp, connection }) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const planner = await makeUser(admin, testApp, ['planning']);
  const manager = await makeUser(admin, testApp, ['staff']);
  await createEmployee(connection, planner.id);
  const department = await makeDepartment(admin, connection, manager.id);
  const item = await createItem(connection);
  const draft = await makeDraft(planner.session, department.id, item);
  const submitted = await submit(planner.session, draft.id);
  expect(await assigneesOf(connection, submitted.approvalId)).toEqual([manager.id]);
}, TIMEOUT);

test('部门没主管时审批任务回落到 root，提交不再因部门编码失败', async ({ testApp, connection }) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const root = await connection.query
    .selectFrom('user').select('id').where('username', '=', 'nocobase').executeTakeFirst();
  const rootId = String(root?.id ?? '');
  expect(rootId, '默认管理员应存在').not.toBe('');
  const planner = await makeUser(admin, testApp, ['planning']);
  await createEmployee(connection, planner.id);
  const department = await makeDepartment(admin, connection);
  const item = await createItem(connection);
  const draft = await makeDraft(planner.session, department.id, item);
  const submitted = await submit(planner.session, draft.id);
  expect(await assigneesOf(connection, submitted.approvalId)).toEqual([rootId]);
}, TIMEOUT);

async function makeDraft(
  session: TestSession,
  departmentId: string,
  itemId: string,
): Promise<Row> {
  const created = await session.fetch(PATH, write({ departmentId }));
  const createdText = await created.text();
  if (created.status !== 201) throw new Error(`建草稿失败 ${created.status}: ${createdText}`);
  expect(created.status).toBe(201);
  const draft = JSON.parse(createdText) as Row;
  const lined = await session.fetch(`${PATH}/${String(draft.id)}/lines`, write({
    lines: [{ itemId, qty: 2, expectedPrice: 3 }],
  }));
  if (lined.status !== 200) throw new Error(`提行失败 ${lined.status}: ${await lined.text()}`);
  expect(lined.status).toBe(200);
  return draft;
}

async function submit(session: TestSession, id: string): Promise<Row> {
  const response = await session.fetch(`${PATH}/${encodeURIComponent(id)}/submit`, write());
  const text = await response.text();
  if (response.status !== 200) throw new Error(`提交应成功，实际 ${response.status}：${text}`);
  expect(response.status).toBe(200);
  const body = JSON.parse(text) as Row;
  expect(String(body.approvalId ?? '')).not.toBe('');
  return body;
}
