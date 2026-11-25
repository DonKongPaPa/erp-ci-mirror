import { randomUUID } from 'node:crypto';

import {
  DEFAULT_ADMIN_CREDENTIALS,
  signIn,
  type SignInTarget,
  type TestSession,
} from '@nocobase/app-plugin-authentication/testing';
import { scopedApiKeysToken } from '@nocobase/app-plugin-api-keys/server';
import { createAppTest } from '../helpers/test-app.js';
import { expect } from 'vitest';

import { createStandaloneServer } from '../../server/standalone.js';

/**
 * R-032 验收第 3 条的「创建收紧到 root」。
 *
 * 个人密钥的列出、创建、轮换、吊销用插件现成的 `/apiKeys` 接口；应用通过
 * `ScopedApiKeys.setOwnKeyPolicy` 把创建与轮换收紧到 root，列出与吊销仍然人人可用。
 * `/apiKeys/scopeOptions` 的 `mayCreate` 是页面用来显示或禁用「创建」的依据。
 *
 * 这组断言同时检查本应用没有登记任何权限范围组：`groups` 是空的，页面不该虚构选项。
 */

const test = createAppTest({
  createServer: createStandaloneServer,
  config: {
    app: { publicOrigin: 'http://localhost' },
    auth: { secret: 'test-auth-secret-at-least-32-characters' },
  },
});

const PASSWORD = 'R032-own-keys-123!';

interface ApiErrorBody {
  error: { status: string; reason: string; domain: string; message: string };
}

interface KeyView {
  id: string;
  name: string | null;
  expiresAt: string | null;
}

interface CreatedKey {
  key: KeyView;
  secret: string;
}

const operationKey = () => `${Date.now()}.${randomUUID()}`;

const json = (body: unknown, method = 'POST', key = operationKey()) => ({
  method,
  headers: {
    'content-type': 'application/json',
    origin: 'http://localhost',
    'Idempotency-Key': key,
  },
  body: JSON.stringify(body),
});

const expectJson = async (
  response: Response,
  status: number,
): Promise<unknown> => {
  const text = await response.text();
  expect(response.status, `${text}`).toBe(status);
  return JSON.parse(text) as unknown;
};

const expectError = async (
  response: Response,
  status: number,
): Promise<ApiErrorBody['error']> =>
  ((await expectJson(response, status)) as ApiErrorBody).error;

const createUser = async (
  admin: TestSession,
  name: string,
): Promise<{ id: string }> => {
  const response = await admin.fetch(
    '/users',
    json({
      name,
      username: name,
      email: `${name}@example.test`,
      password: PASSWORD,
      roleScopes: { app: [] },
    }),
  );
  const text = await response.text();
  expect(response.status, `${text}`).toBe(201);
  return (JSON.parse(text) as { data: { id: string } }).data;
};

const signInAs = (app: SignInTarget, username: string) =>
  signIn(app, { username, password: PASSWORD });

const listOwnKeys = async (session: TestSession): Promise<KeyView[]> =>
  (
    (await expectJson(await session.fetch('/apiKeys'), 200)) as {
      data: KeyView[];
    }
  ).data;

const scopeOptions = async (
  session: TestSession,
): Promise<{ groups: unknown[]; mayCreate: boolean }> =>
  (
    (await expectJson(await session.fetch('/apiKeys/scopeOptions'), 200)) as {
      data: { groups: unknown[]; mayCreate: boolean };
    }
  ).data;

test('R-032 3: root may list, create, rotate and revoke its own keys, and the list never carries the secret', async ({
  testApp,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  expect(await listOwnKeys(admin)).toEqual([]);
  const options = await scopeOptions(admin);
  expect(options.mayCreate, 'root 应当可以创建自己的密钥').toBe(true);
  expect(options.groups, '应用没有登记任何权限范围组').toEqual([]);

  const created = (await expectJson(
    await admin.fetch(
      '/apiKeys',
      json({ name: 'R032 root own key', expiresInDays: 30, scope: null }),
    ),
    201,
  )) as { data: CreatedKey };
  expect(created.data.secret).toBeTruthy();

  const listText = await (await admin.fetch('/apiKeys')).text();
  expect(listText).not.toContain(created.data.secret);
  expect(listText).not.toContain('secret');

  const rotated = (await expectJson(
    await admin.fetch(`/apiKeys/${created.data.key.id}/rotate`, json({})),
    200,
  )) as { data: CreatedKey };
  expect(rotated.data.key.id).toBe(created.data.key.id);
  expect(rotated.data.secret).not.toBe(created.data.secret);

  const revoked = await admin.fetch(`/apiKeys/${created.data.key.id}`, {
    method: 'DELETE',
    headers: {
      origin: 'http://localhost',
      'Idempotency-Key': operationKey(),
    },
  });
  expect(revoked.status, `${await revoked.text()}`).toBe(204);
  expect(await listOwnKeys(admin)).toEqual([]);
});

test('R-032 3: a non-root user may list and revoke, but creating and rotating are refused', async ({
  testApp,
  app,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const member = await createUser(admin, 'r032ownmember');
  const session = await signInAs(testApp, 'r032ownmember');

  expect(await listOwnKeys(session)).toEqual([]);
  const options = await scopeOptions(session);
  expect(options.mayCreate, '非 root 的页面应当拿不到可用的「创建」').toBe(
    false,
  );

  const refused = await session.fetch(
    '/apiKeys',
    json({ name: '不该建出来', expiresInDays: 30, scope: null }),
  );
  const error = await expectError(refused, 403);
  expect(error.reason).toBe('API_KEY_CREATION_FORBIDDEN');

  // 已有的密钥是 root 之前给它建的；列出与吊销不受收紧影响。
  const keys = app.container.resolve(scopedApiKeysToken);
  const existing = await keys.create(
    member.id,
    { name: '原本就有的密钥' },
    await keys.identityOf(member.id),
  );
  const listed = await listOwnKeys(session);
  expect(listed.map((row) => row.id)).toEqual([existing.key.id]);

  const rotate = await session.fetch(
    `/apiKeys/${existing.key.id}/rotate`,
    json({}),
  );
  expect((await expectError(rotate, 403)).reason).toBe(
    'API_KEY_CREATION_FORBIDDEN',
  );

  const revoked = await session.fetch(`/apiKeys/${existing.key.id}`, {
    method: 'DELETE',
    headers: {
      origin: 'http://localhost',
      'Idempotency-Key': operationKey(),
    },
  });
  expect(revoked.status, `${await revoked.text()}`).toBe(204);
  expect(await listOwnKeys(session)).toEqual([]);
});

test('R-032 3: no API key may manage API keys, and a business role is still not root', async ({
  testApp,
  app,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const keys = app.container.resolve(scopedApiKeysToken);
  const rootKey = await keys.create(
    admin.user.id,
    { name: 'R032 root management key' },
    await keys.identityOf(admin.user.id),
  );

  const byKey = await testApp.request('/apiKeys', {
    headers: {
      origin: 'http://localhost',
      'x-api-key': rootKey.secret,
      'Idempotency-Key': operationKey(),
    },
  });
  expect((await expectError(byKey, 403)).reason).toBe(
    'API_KEY_SESSION_FORBIDDEN',
  );

  // 业务角色不是 root：质量主管也不能建自己的密钥。
  const response = await admin.fetch(
    '/users',
    json({
      name: 'r032ownmanager',
      username: 'r032ownmanager',
      email: 'r032ownmanager@example.test',
      password: PASSWORD,
      roleScopes: { app: ['quality_manager'] },
    }),
  );
  expect(response.status, `${await response.text()}`).toBe(201);
  const manager = await signInAs(testApp, 'r032ownmanager');
  expect((await scopeOptions(manager)).mayCreate).toBe(false);
  const forbidden = await manager.fetch(
    '/apiKeys',
    json({ name: '质量主管的密钥', expiresInDays: 30, scope: null }),
  );
  expect((await expectError(forbidden, 403)).reason).toBe(
    'API_KEY_CREATION_FORBIDDEN',
  );
});
