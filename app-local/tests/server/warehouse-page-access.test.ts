// @vitest-environment node
import { randomUUID } from 'node:crypto';

import {
  DEFAULT_ADMIN_CREDENTIALS,
  signIn,
  type TestSession,
} from '@nocobase/app-plugin-authentication/testing';
import { authorizationToken } from '@nocobase/app-plugin-authorization';
import type { AuthorizationSnapshot } from '@nocobase/app-plugin-authorization/client';
import { expect } from 'vitest';

import { createAppTest } from '../helpers/test-app.js';
import { createStandaloneServer } from '../../server/standalone.js';

/**
 * 界面点验第六轮缺陷 2 的根因核查（真 Postgres）：
 * 一个只持 warehouse + 基线 staff 的用户，在全部种子执行之后，能否拿到
 * 盘点单 / 调拨单两个页面路由的 page access 与两个业务资源的 view。
 * 数据一律编造；这里只做只读的权限快照与授权判定，不改任何角色授权。
 */
const test = createAppTest({
  createServer: createStandaloneServer,
  config: {
    app: { publicOrigin: 'http://localhost' },
    auth: { secret: 'test-auth-secret-at-least-32-characters' },
  },
});

async function createUser(
  admin: TestSession,
  testApp: Parameters<typeof signIn>[0],
  roles: readonly string[],
): Promise<{ id: string; session: TestSession }> {
  const username = `r6wh${randomUUID().replaceAll('-', '').slice(0, 10)}`;
  const response = await admin.fetch('/users', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: 'http://localhost',
      'Idempotency-Key': `${Date.now()}.${randomUUID()}`,
    },
    body: JSON.stringify({
      name: username,
      username,
      email: `${username}@example.test`,
      password: 'R6-warehouse-test-123!',
      roleScopes: { app: [...roles] },
    }),
  });
  const text = await response.text();
  expect(response.status, `建用户失败：${text}`).toBe(201);
  const data = (JSON.parse(text) as { data: { id: string } }).data;
  return {
    id: data.id,
    session: await signIn(testApp, { username, password: 'R6-warehouse-test-123!' }),
  };
}

test('warehouse + staff 用户拿得到两个页面的 access 与两个资源的 view', async ({ app, testApp }) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const user = await createUser(admin, testApp, ['warehouse', 'staff']);

  const response = await user.session.fetch('/authorization/permissions');
  expect(response.status).toBe(200);
  const snapshot = (await response.json()).data as AuthorizationSnapshot;
  const can = (type: string, id: string, action: string): boolean =>
    snapshot.permissions.some(
      (permission) =>
        permission.resource.type === type &&
        (permission.resource.id === '*' || permission.resource.id === id) &&
        permission.actions.includes(action),
    );

  // 页面路由的 authz：authz.resource = { type: 'page', id: ... } / action 'access'。
  expect(can('page', 'stocktakings', 'access'), '盘点单页面 access').toBe(true);
  expect(can('page', 'transfers', 'access'), '调拨单页面 access').toBe(true);
  // 页面里的 useCan：composite 资源 view。
  expect(can('composite', 'stocktakings', 'view'), '盘点单资源 view').toBe(true);
  expect(can('composite', 'transfers', 'view'), '调拨单资源 view').toBe(true);

  // 再用授权引擎直接判一次：服务端也没有另一套拒绝理由。
  const authz = app.container.resolve(authorizationToken);
  for (const [type, id, action] of [
    ['page', 'stocktakings', 'access'],
    ['page', 'transfers', 'access'],
    ['composite', 'stocktakings', 'view'],
    ['composite', 'transfers', 'view'],
  ] as const) {
    const decision = await authz.for({ principal: { type: 'user', id: user.id } }).authorize({
      resource: { type, id },
      action,
    });
    // permit 或 conditional（带记录范围）都算有权限；deny 才是无权。
    expect(['permit', 'conditional'], `${type}/${id}/${action}`).toContain(decision.effect);
  }
});
