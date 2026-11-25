// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_ADMIN_CREDENTIALS,
  signIn,
} from '@nocobase/app-plugin-authentication/testing';
import { expect } from 'vitest';

import { createAppTest } from '../helpers/test-app.js';
import { createStandaloneServer } from '../../server/standalone.js';

/**
 * R-034 第 4 条补强：客户端那条只钉住页面壳，接口拒绝此前只靠插件，没有应用侧测试。
 * 这里打真实挂载路径：登录用户没有 `page:notification.logs/access` 时两个只读接口都
 * 返回 403 `NOTIFICATION_LOGS_FORBIDDEN`，root 照旧可读，匿名仍是 401（不被改成 403）。
 *
 * 造一个没有任何权限集的合成用户；权限集名字带随机后缀，不碰 seed。
 */

const test = createAppTest({
  createServer: createStandaloneServer,
  scope: 'test' as const,
  config: {
    app: { publicOrigin: 'http://localhost' },
    spa: {
      indexPath: fileURLToPath(new URL('../../index.html', import.meta.url)),
    },
    auth: {
      secret: 'notification-logs-access-test-secret-at-least-32-characters',
    },
  },
});

interface ApiErrorBody {
  error: { status: string; reason: string; domain: string };
}

test('R-034 4: a signed-in user without the logs page grant gets 403 on the real API', async ({
  testApp,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  expect(
    (await admin.fetch('/notifications/logs')).status,
    'root 照旧能读通知日志',
  ).toBe(200);

  const tag = randomUUID().slice(0, 8);
  const member = {
    username: `r034logs_${tag}`,
    email: `r034logs_${tag}@example.invalid`,
    password: 'Synthetic-notification-logs-941!',
  };
  const created = await admin.fetch('/users', {
    method: 'POST',
    headers: {
      origin: 'http://localhost',
      'content-type': 'application/json',
      'Idempotency-Key': `${Date.now()}.${randomUUID()}`,
    },
    body: JSON.stringify({
      ...member,
      name: 'Synthetic restricted logs viewer',
      roleScopes: { app: [] },
    }),
  });
  expect(created.status, `${await created.text()}`).toBe(201);
  const restricted = await signIn(testApp, member);

  // 列表与详情两条真实路径：原因码要钉死，不能只判「不是 200」。
  for (const path of [
    '/notifications/logs',
    '/notifications/logs/00000000-0000-4000-8000-000000000000',
  ]) {
    const response = await restricted.fetch(path);
    const text = await response.text();
    expect(response.status, `${path}: ${text}`).toBe(403);
    const error = (JSON.parse(text) as ApiErrorBody).error;
    expect(error.status, `${path} 的状态`).toBe('PERMISSION_DENIED');
    expect(error.reason, `${path} 的原因码`).toBe(
      'NOTIFICATION_LOGS_FORBIDDEN',
    );
    expect(error.domain, `${path} 的 domain`).toBe('notifications');
  }

  // 匿名仍是 401：授权层没把「没登录」改成「没授权」。
  const anonymous = await testApp.request('/notifications/logs');
  const anonymousText = await anonymous.text();
  expect(anonymous.status, `${anonymousText}`).toBe(401);
  expect((JSON.parse(anonymousText) as ApiErrorBody).error.reason).toBe(
    'AUTHENTICATION_REQUIRED',
  );
});
