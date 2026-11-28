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
import { createEmployee, get, jsonOf, write, type Row } from '../helpers/orders.js';
import { createStandaloneServer } from '../../server/standalone.js';

/**
 * R-066 授权：先授权后读内容，staff 按建单人收窄（别人的单与不存在同形），
 * 转支出只给 finance 与 root，没有删除路由。
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
const PASSWORD = 'R066-authz-test-123!';
const marker = () => randomUUID().replaceAll('-', '').slice(0, 10);

async function makeUser(
  admin: TestSession,
  testApp: Parameters<typeof signIn>[0],
  roles: readonly string[],
  keepStaff = true,
): Promise<{ id: string; session: TestSession }> {
  const username = `r066${marker()}`;
  const created = await admin.fetch('/users', write({
    name: username, username,
    email: `${username}@example.test`,
    password: PASSWORD,
    roleScopes: { app: [...roles] },
  }));
  expect(created.status, `建用户失败：${await created.clone().text()}`).toBe(201);
  const data = (await jsonOf(created)) as { data?: { id?: string }; id?: string };
  const id = String(data.data?.id ?? data.id ?? '');
  expect(id).not.toBe('');
  if (!keepStaff || !roles.includes('staff')) {
    const app = (testApp as unknown as { application: Application }).application;
    await app.container.resolve(authorizationToken).permissionSets.revoke(`user:${id}:staff`);
  }
  return { id, session: await signIn(testApp, { username, password: PASSWORD }) };
}

async function makeDraft(session: TestSession): Promise<string> {
  const response = await session.fetch(PATH, write({
    docType: 'payment_request', amount: 88, reason: '本人建的',
  }));
  expect(response.status).toBe(201);
  const data = await jsonOf(response);
  return String(data.id ?? '');
}

test('purchase / warehouse / sales 八个端点全 403；非法内容也先 403', async ({ testApp }) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const blocked = await Promise.all(
    (['purchase', 'warehouse', 'sales'] as const).map((role) => makeUser(admin, testApp, [role], false)),
  );
  const nonexistent = `NO-${marker()}`;
  const paths: readonly [string, RequestInit][] = [
    [PATH, get()],
    [`${PATH}/${nonexistent}`, get()],
    [PATH, write({ docType: 'payment_request', amount: -1 })],
    [`${PATH}/${nonexistent}`, write({ reason: 'bad' }, 'PATCH')],
    [`${PATH}/${nonexistent}/submit`, write()],
    [`${PATH}/${nonexistent}/void`, write()],
    [`${PATH}/${nonexistent}/create-expense`, write()],
  ];
  for (const { session } of blocked) {
    for (const [path, options] of paths) {
      const response = await session.fetch(path, options);
      expect(response.status, `${path} 应当先被授权拒绝`).toBe(403);
    }
  }
}, TIMEOUT);

test('staff 只能看本人建的单：别人的单 404 且与不存在的编号逐字节同形', async ({ testApp, connection }) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const owner = await makeUser(admin, testApp, ['staff']);
  const other = await makeUser(admin, testApp, ['staff']);
  await createEmployee(connection, owner.id);
  await createEmployee(connection, other.id);
  const id = await makeDraft(owner.session);

  const mine = await other.session.fetch(`${PATH}/${id}`, get());
  expect(mine.status).toBe(404);
  const missing = await other.session.fetch(`${PATH}/NO-${marker()}`, get());
  expect(missing.status).toBe(404);
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
  expect((await other.session.fetch(`${PATH}/${id}`, write({ reason: '越权改' }, 'PATCH'))).status).toBe(404);
  expect((await other.session.fetch(`${PATH}/${id}/void`, write())).status).toBe(404);
}, TIMEOUT);

test('finance 读全部与转出；staff 不能转出、不能建单 by finance；没有 DELETE', async ({ testApp, connection }) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const staff = await makeUser(admin, testApp, ['staff']);
  const approver = await makeUser(admin, testApp, ['finance']);
  await createEmployee(connection, staff.id);
  const id = await makeDraft(staff.session);

  // finance 能读全部（含别人的草稿），但没有被授予建/改/提交/作废。
  expect((await approver.session.fetch(`${PATH}/${id}`, get())).status).toBe(200);
  const financeList = await jsonOf(await approver.session.fetch(PATH, get()));
  expect((financeList.items as Row[]).map((row) => row.id)).toContain(id);
  expect((await approver.session.fetch(PATH, write({
    docType: 'payment_request', amount: 10,
  }))).status).toBe(403);
  expect((await approver.session.fetch(`${PATH}/${id}`, write({ reason: '改' }, 'PATCH'))).status).toBe(403);
  expect((await approver.session.fetch(`${PATH}/${id}/submit`, write())).status).toBe(403);
  expect((await approver.session.fetch(`${PATH}/${id}/void`, write())).status).toBe(403);

  // staff 有 view/create/update/submit/void，但没有 convert。
  expect((await staff.session.fetch(`${PATH}/${id}/create-expense`, write())).status).toBe(403);

  const removed = await admin.fetch(`${PATH}/${id}`, {
    method: 'DELETE', headers: { origin: 'http://localhost' },
  });
  expect([404, 405]).toContain(removed.status);
  expect((await approver.session.fetch(`${PATH}/${id}`, get())).status).toBe(200);
}, TIMEOUT);
