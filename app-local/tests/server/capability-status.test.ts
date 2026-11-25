import {
  DEFAULT_ADMIN_CREDENTIALS,
  signIn,
} from '@nocobase/app-plugin-authentication/testing';
import { createAppTest } from '../helpers/test-app.js';
import { expect } from 'vitest';

import {
  capabilityExpectations,
  type CapabilityStatus,
} from '../helpers/capability-expectations.js';
import { createStandaloneServer } from '../../server/standalone.js';

/**
 * R-031：「功能与扩展」页上要服务端发布的东西才能判的五项，状态与规划里的处置一致。
 *
 * 密码登录、自助注册、找回密码、消息与通知语言、数据库连接。客户端那一半在
 * `tests/client/capability-status.test.ts`。找回密码会在这里先变：配好发信邮箱（X-06）
 * 之后 `passwordResetAvailable` 变成 true，这一条红的时候，把期望表里它改成「已提供」。
 */

const test = createAppTest({
  createServer: createStandaloneServer,
  config: {
    app: { publicOrigin: 'http://localhost' },
    auth: { secret: 'test-auth-secret-at-least-32-characters' },
  },
});

const expectedFor = (title: string): CapabilityStatus => {
  const item = capabilityExpectations.find((entry) => entry.title === title);
  if (!item) throw new Error(`期望表里没有「${title}」`);
  return item.expected;
};

test('R-031: signs in by password and leaves sign-up open', async ({ app }) => {
  // 两项都要密码登录是开着的；框架没发布的字段按「允许注册」算。
  const passwordEnabled = app.config.get<boolean>(
    'auth.emailAndPassword.enabled',
  );
  const disableSignUp = app.config.get<boolean>(
    'auth.emailAndPassword.disableSignUp',
  );
  const password: CapabilityStatus = passwordEnabled ? '已提供' : '未配置';
  const signUp: CapabilityStatus =
    passwordEnabled !== false && disableSignUp !== true ? '已提供' : '未配置';
  expect({ password, signUp }).toEqual({
    password: expectedFor('密码登录'),
    signUp: expectedFor('自助注册'),
  });
});

test('R-031: publishes no password reset until outgoing mail is configured', async ({
  request,
}) => {
  // 匿名请求，路径按应用的 API 根解析。
  const response = await request('/authentication/capabilities');
  expect(response.status).toBe(200);
  const { data } = (await response.json()) as {
    data: { passwordResetAvailable: boolean };
  };
  const reset: CapabilityStatus = data.passwordResetAvailable
    ? '已提供'
    : '未配置';
  expect(reset, '找回密码的状态变了。').toBe(expectedFor('找回密码'));
});

test('R-031: serves a language list and at least one database connection', async ({
  testApp,
  request,
}) => {
  const locales = await request('/i18n/locales');
  expect(locales.status).toBe(200);
  const { data } = (await locales.json()) as {
    data: { locales: unknown[] };
  };
  const messageLanguages: CapabilityStatus = data.locales.length
    ? '已提供'
    : '未配置';
  expect(messageLanguages).toBe(expectedFor('消息与通知语言'));

  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const connections = await admin.fetch('/databaseExplorer/connections');
  expect(connections.status).toBe(200);
  // 接口直接回连接的数组，每一条在能力页上渲染成一项「已提供」。
  const { data: items } = (await connections.json()) as { data: unknown[] };
  const database: CapabilityStatus = items.length ? '已提供' : '未配置';
  expect(database).toBe(expectedFor('数据库连接'));
});
