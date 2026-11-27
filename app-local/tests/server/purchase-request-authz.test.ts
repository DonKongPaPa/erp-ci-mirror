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
import { createItem } from '../helpers/inventory.js';
import { createEmployee, get, jsonOf, unique, write, type Row } from '../helpers/orders.js';
import { createStandaloneServer } from '../../server/standalone.js';

/**
 * R-021 波 1 加片授权：先授权后读内容，staff 按建单人收窄（别人的单与不存在同形），
 * 转订单只给 purchase 与 root，没有删除路由。
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
const PASSWORD = 'R021-authz-test-123!';
const marker = () => randomUUID().replaceAll('-', '').slice(0, 10);

async function makeUser(
  admin: TestSession,
  testApp: Parameters<typeof signIn>[0],
  prefix: string,
  roles: readonly string[],
): Promise<{ id: string; session: TestSession }> {
  const username = `r021${marker()}`;
  void prefix;
  const created = await admin.fetch('/users', write({
    name: username, username,
    email: `${username.toLowerCase()}@example.test`,
    password: PASSWORD,
    roleScopes: { app: [...roles] },
  }));
  expect(created.status, `建用户失败：${await created.clone().text()}`).toBe(201);
  const data = (await jsonOf(created)) as { data?: { id?: string }; id?: string };
  const id = String(data.data?.id ?? data.id ?? '');
  expect(id).not.toBe('');
  if (!roles.includes('staff')) {
    const app = (testApp as unknown as { application: Application }).application;
    await app.container.resolve(authorizationToken).permissionSets.revoke(`user:${id}:staff`);
  }
  return { id, session: await signIn(testApp, { username, password: PASSWORD }) };
}

async function makeDepartment(admin: TestSession): Promise<{ id: string }> {
  const tag = unique('DEPT');
  const response = await admin.fetch('/departments', write({ title: `授权部${tag}`, code: tag, kind: 'department' }));
  expect(response.status).toBe(201);
  const data = (await jsonOf(response)).data as Row;
  return { id: String(data.id ?? '') };
}

async function makeDraft(
  session: TestSession,
  departmentId: string,
): Promise<string> {
  const response = await session.fetch(PATH, write({ departmentId, description: '本人建的' }));
  expect(response.status).toBe(201);
  const data = await jsonOf(response);
  return String(data.id ?? '');
}

test('warehouse / sales / finance 八个端点全 403；非法内容也先 403', async ({
  testApp, connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const item = await createItem(connection);
  const blocked = await Promise.all(
    (['warehouse', 'sales', 'finance'] as const).map((role) =>
      makeUser(admin, testApp, `r021pr-authz-${role}`, [role]),
    ),
  );
  const nonexistent = `NO-${marker()}`;
  const paths: readonly [string, RequestInit][] = [
    [PATH, get()],
    [`${PATH}/${nonexistent}`, get()],
    [PATH, write({ departmentId: 'bad' })],
    [`${PATH}/${nonexistent}`, write({ description: 'bad' }, 'PATCH')],
    [`${PATH}/${nonexistent}/lines`, write({ lines: [{ itemId: item, qty: 1 }] })],
    [`${PATH}/${nonexistent}/submit`, write()],
    [`${PATH}/${nonexistent}/void`, write()],
    [`${PATH}/${nonexistent}/create-order`, write()],
  ];
  for (const { session } of blocked) {
    for (const [path, options] of paths) {
      const response = await session.fetch(path, options);
      expect(response.status, `${path} 应当先被授权拒绝`).toBe(403);
    }
  }
}, TIMEOUT);

test('staff 只能看本人建的单：别人的单 404 且与不存在的编号逐字节同形', async ({
  testApp, connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const owner = await makeUser(admin, testApp, 'r021pr-owner', ['staff']);
  const other = await makeUser(admin, testApp, 'r021pr-other', ['staff']);
  await createEmployee(connection, owner.id);
  await createEmployee(connection, other.id);
  const department = await makeDepartment(admin);
  const id = await makeDraft(owner.session, department.id);

  const mine = await other.session.fetch(`${PATH}/${id}`, get());
  expect(mine.status).toBe(404);
  const missing = await other.session.fetch(`${PATH}/NO-${marker()}`, get());
  expect(missing.status).toBe(404);
  // requestId 每次请求都不同；除它之外的错误体必须逐字一致，不能泄露编号是否存在。
  const withoutRequestId = (body: Row): Row => {
    const error = { ...((body.error ?? {}) as Row) };
    delete error.requestId;
    return { error };
  };
  expect(withoutRequestId(await jsonOf(mine)), '404 响应体必须同形').toEqual(
    withoutRequestId(await jsonOf(missing)),
  );
  expect((await owner.session.fetch(`${PATH}/${id}`, get())).status).toBe(200);

  const list = await jsonOf(await other.session.fetch(PATH, get()));
  expect((list.items as Row[]).map((row) => row.id)).not.toContain(id);
  const ownList = await jsonOf(await owner.session.fetch(PATH, get()));
  expect((ownList.items as Row[]).map((row) => row.id)).toContain(id);
  expect(
    (await other.session.fetch(`${PATH}/${id}`, write({ description: '越权改' }, 'PATCH'))).status,
  ).toBe(404);
}, TIMEOUT);

test('planning 建改提交，purchase 只读与转单；purchase 不能建、staff 不能转，没有删除', async ({
  testApp, connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const planner = await makeUser(admin, testApp, 'r021pr-plan', ['planning']);
  const approver = await makeUser(admin, testApp, 'r021pr-appr', ['staff']);
  const buyer = await makeUser(admin, testApp, 'r021pr-buy', ['purchase']);
  await createEmployee(connection, planner.id);
  const tag = unique('DEPT');
  const created = await admin.fetch('/departments', write({ title: `角色部${tag}`, code: tag, kind: 'department' }));
  const departmentId = String(((await jsonOf(created)).data as Row).id ?? '');
  await connection.query.updateTable('departments').set({ managerId: approver.id })
    .where('id', '=', departmentId).execute();
  const item = await createItem(connection);
  const id = await makeDraft(planner.session, departmentId);

  expect((await buyer.session.fetch(PATH, write({ departmentId }))).status).toBe(403);
  expect((await buyer.session.fetch(`${PATH}/${id}`, get())).status).toBe(200);
  expect((await planner.session.fetch(`${PATH}/${id}/create-order`, write())).status).toBe(403);

  await expect((await planner.session.fetch(`${PATH}/${id}/lines`, write({
    lines: [{ itemId: item, qty: 1 }],
  }))).status).toBe(200);
  expect((await planner.session.fetch(`${PATH}/${id}/submit`, write())).status).toBe(200);
  expect((await buyer.session.fetch(`${PATH}/${id}/void`, write())).status).toBe(403);

  const removed = await admin.fetch(`${PATH}/${id}`, {
    method: 'DELETE', headers: { origin: 'http://localhost' },
  });
  expect([404, 405]).toContain(removed.status);
  expect((await buyer.session.fetch(`${PATH}/${id}`, get())).status).toBe(200);
}, TIMEOUT);
