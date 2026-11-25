import { randomUUID } from 'node:crypto';

import { authorizationToken } from '@nocobase/app-plugin-authorization/server';
import {
  DEFAULT_ADMIN_CREDENTIALS,
  signIn,
  type SignInTarget,
  type TestSession,
} from '@nocobase/app-plugin-authentication/testing';
import type { AuthConfig } from '@nocobase/app-plugin-authentication/server';
import { scopedApiKeysToken } from '@nocobase/app-plugin-api-keys/server';
import type { TestApp } from '@nocobase/app-testing/server';
import { expect, vi } from 'vitest';

import { createAppTest, createTestApp } from '../helpers/test-app.js';
import { ownKeyPolicyToken } from '../../server/own-key-endpoint-guard.js';
import { createStandaloneServer } from '../../server/standalone.js';

/**
 * R-032 验收第 3 条的「创建收紧到 root」，在同一个插件的 Better Auth 端点上。
 *
 * 插件自己的 `/api/apiKeys` 由 `tests/server/api-keys-own-policy.test.ts` 守着；这里守的是
 * `POST /api/auth/api-key/create` 与 `/api-key/update`——同一个插件挂在 Better Auth 下的端点。
 * 框架把「谁可以建自己的密钥」挂在一个不可枚举的 symbol 上，配置管道按 `Object.entries`
 * 克隆时把它丢了，于是框架自己的钩子读不到策略、直接放行；应用这道钩子补上同一个判定。
 *
 * 会话形态要逐种打：浏览器 cookie、`Authorization: Bearer <会话令牌>`（登录响应与设备授权
 * 都发这种）、密钥、匿名。Bearer 是复查抓到的绕过：它要靠 bearer 插件自己的钩子才变成会话，
 * 而应用的钩子排在插件钩子前面。
 *
 * 列出、读取、吊销不受影响：丢了权限的人仍然能清理自己已有的密钥。root 不受限制。
 */

const test = createAppTest({
  createServer: createStandaloneServer,
  config: {
    app: { publicOrigin: 'http://localhost' },
    auth: {
      secret: 'test-auth-secret-at-least-32-characters',
      // 注销后的旧 cookie 仍会被 cookie 缓存读成会话：注销与垃圾 Bearer 那两条打的就是它。
      session: { cookieCache: { enabled: true } },
    },
  },
});

const PASSWORD = 'R032-own-endpoints-123!';
const SECRET = 'test-auth-secret-at-least-32-characters';

/** Better Auth 自己的错误体：`{ code, message }`，没有应用路由那层 `error` 信封。 */
interface BetterAuthErrorBody {
  code: string;
  message: string;
}

interface KeyView {
  id: string;
  name: string | null;
  expiresAt: string | null;
}

interface BetterAuthKeyView {
  id: string;
  name: string | null;
  enabled: boolean;
  expiresAt: string | null;
}

const jsonBody = (body: unknown, method = 'POST') => ({
  method,
  headers: { 'content-type': 'application/json', origin: 'http://localhost' },
  body: JSON.stringify(body),
});

/** 应用自己的路由还要求幂等键；Better Auth 的端点不认它，也就不必带。 */
const appJson = (body: unknown) => ({
  ...jsonBody(body),
  headers: {
    ...jsonBody(body).headers,
    'Idempotency-Key': `${Date.now()}.${randomUUID()}`,
  },
});

const postWithBearer = (
  app: TestApp,
  path: string,
  token: string,
  body: unknown,
) =>
  app.request(path, {
    ...jsonBody(body),
    headers: {
      ...jsonBody(body).headers,
      authorization: `Bearer ${token}`,
    },
  });

const expectStatus = async (
  response: Response,
  status: number,
): Promise<unknown> => {
  const text = await response.text();
  expect(response.status, `${text}`).toBe(status);
  return JSON.parse(text) as unknown;
};

const expectRefusal = async (
  response: Response,
  status: number,
): Promise<BetterAuthErrorBody> =>
  (await expectStatus(response, status)) as BetterAuthErrorBody;

const createUser = async (
  admin: TestSession,
  name: string,
): Promise<{ id: string }> => {
  const response = await admin.fetch(
    '/users',
    appJson({
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

/**
 * 登录响应里的会话令牌（`Set-Auth-Token`）：bearer 插件认它，设备授权发的也是同一种值。
 * 单独登录一次，免得从 cookie 里拆签名值。
 */
const bearerTokenOf = async (
  app: TestApp,
  credentials: { username: string; password: string },
): Promise<string> => {
  const response = await app.request(
    '/auth/sign-in/username',
    jsonBody(credentials),
  );
  const text = await response.text();
  expect(response.status, `${text}`).toBe(200);
  const token = response.headers.get('set-auth-token');
  expect(token).toBeTruthy();
  return token as string;
};

/** 本人看到的密钥清单，走应用自己的 `/api/apiKeys`：调用前后应当一字不差。 */
const listOwnKeys = async (session: TestSession): Promise<KeyView[]> =>
  (
    (await expectStatus(await session.fetch('/apiKeys'), 200)) as {
      data: KeyView[];
    }
  ).data;

/** Better Auth 自己的清单：`GET /api/auth/api-key/list`。 */
const listBetterAuthKeys = async (
  session: TestSession,
): Promise<BetterAuthKeyView[]> =>
  (
    (await expectStatus(await session.fetch('/auth/api-key/list'), 200)) as {
      apiKeys: BetterAuthKeyView[];
    }
  ).apiKeys;

const createThroughBetterAuth = (session: TestSession, name: string) =>
  session.fetch('/auth/api-key/create', jsonBody({ name }));

const updateThroughBetterAuth = (
  session: TestSession,
  body: Record<string, unknown>,
) => session.fetch('/auth/api-key/update', jsonBody(body));

const deleteThroughBetterAuth = (session: TestSession, keyId: string) =>
  session.fetch('/auth/api-key/delete', jsonBody({ keyId }));

test('R-032: a non-root user may not create a key through the plugin’s Better Auth endpoint, and no key is created', async ({
  testApp,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  await createUser(admin, 'r032endpointmember');
  const session = await signInAs(testApp, 'r032endpointmember');

  const before = await listOwnKeys(session);
  expect(before, '新账户一开始没有密钥').toEqual([]);

  const refused = await createThroughBetterAuth(session, '不该建出来的密钥');
  const error = await expectRefusal(refused, 403);
  expect(error.code).toBe('API_KEY_CREATION_FORBIDDEN');

  expect(await listOwnKeys(session), '被拒之后没有多出密钥').toEqual(before);
  expect(await listBetterAuthKeys(session), '插件自己的清单也是空的').toEqual(
    [],
  );

  // 加一个没用的密钥头不能把守卫绕过去：带 cookie 的仍然是同一个人，仍然不是 root。
  // 这次先撞上的是密钥插件对密钥本身的校验（INVALID_API_KEY），同样是拒绝、同样没建出密钥。
  const withJunkKey = await session.fetch('/auth/api-key/create', {
    ...jsonBody({ name: '带个垃圾密钥头试试' }),
    headers: {
      ...jsonBody({}).headers,
      'x-api-key': 'not-a-real-key',
    },
  });
  expect((await expectRefusal(withJunkKey, 403)).code).toBe('INVALID_API_KEY');
  expect(await listOwnKeys(session), '带垃圾密钥头也没有建出密钥').toEqual(
    before,
  );
});

test('R-032: a non-root user may not update a key through Better Auth, while listing and deleting it still work', async ({
  testApp,
  app,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const member = await createUser(admin, 'r032endpointupdater');
  const session = await signInAs(testApp, 'r032endpointupdater');

  // 密钥是 root 之前替它建的：丢了创建权限的人仍然要有东西可以清理。
  const keys = app.container.resolve(scopedApiKeysToken);
  const existing = await keys.create(
    member.id,
    { name: '原本就有的密钥' },
    await keys.identityOf(member.id),
  );

  const refusedExpiry = await updateThroughBetterAuth(session, {
    keyId: existing.key.id,
    expiresIn: 31_536_000,
  });
  expect((await expectRefusal(refusedExpiry, 403)).code).toBe(
    'API_KEY_UPDATE_FORBIDDEN',
  );

  const refusedReenable = await updateThroughBetterAuth(session, {
    keyId: existing.key.id,
    enabled: true,
  });
  expect((await expectRefusal(refusedReenable, 403)).code).toBe(
    'API_KEY_UPDATE_FORBIDDEN',
  );

  const listed = await listBetterAuthKeys(session);
  expect(listed.map((row) => row.id)).toEqual([existing.key.id]);
  expect(listed[0]?.expiresAt, '过期时间没有被改').toBeNull();
  expect(listed[0]?.enabled, '密钥仍然是启用的').toBe(true);
  expect(await listOwnKeys(session), '应用自己的清单也没变').toHaveLength(1);

  const read = await session.fetch(
    `/auth/api-key/get?id=${encodeURIComponent(existing.key.id)}`,
  );
  expect(
    ((await expectStatus(read, 200)) as { id: string }).id,
    '读取自己的密钥不受影响',
  ).toBe(existing.key.id);

  const revoked = await deleteThroughBetterAuth(session, existing.key.id);
  expect(await expectStatus(revoked, 200)).toBeTruthy();
  expect(await listOwnKeys(session), '吊销之后清单空了').toEqual([]);
});

test('R-032: root creates and updates its own keys through Better Auth, and the creation returns the secret', async ({
  testApp,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);

  const created = (await expectStatus(
    await createThroughBetterAuth(admin, 'root 通过 Better Auth 建的密钥'),
    200,
  )) as { id: string; key: string };
  expect(created.key, '创建返回明文').toBeTruthy();

  const updated = (await expectStatus(
    await updateThroughBetterAuth(admin, {
      keyId: created.id,
      expiresIn: 86_400,
    }),
    200,
  )) as { expiresAt: string | null };
  expect(updated.expiresAt, 'root 可以改有效期').not.toBeNull();

  const revoked = await deleteThroughBetterAuth(admin, created.id);
  expect(await expectStatus(revoked, 200)).toBeTruthy();
});

test('R-032: a session made from a key still may not create or update keys, whatever its owner’s role', async ({
  testApp,
  app,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const member = await createUser(admin, 'r032endpointkeysession');
  const keys = app.container.resolve(scopedApiKeysToken);
  const existing = await keys.create(
    member.id,
    { name: '用来认证的密钥' },
    await keys.identityOf(member.id),
  );
  const keyHeaders = {
    'content-type': 'application/json',
    origin: 'http://localhost',
    'x-api-key': existing.secret,
  };

  const response = await testApp.request('/auth/api-key/create', {
    method: 'POST',
    headers: keyHeaders,
    body: JSON.stringify({ name: '密钥不能再建密钥' }),
  });
  expect((await expectRefusal(response, 403)).code).toBe(
    'API_KEY_SESSION_FORBIDDEN',
  );

  const update = await testApp.request('/auth/api-key/update', {
    method: 'POST',
    headers: keyHeaders,
    body: JSON.stringify({ keyId: existing.key.id, expiresIn: 86_400 }),
  });
  expect((await expectRefusal(update, 403)).code).toBe(
    'API_KEY_SESSION_FORBIDDEN',
  );

  const session = await signInAs(testApp, 'r032endpointkeysession');
  expect(await listOwnKeys(session), '密钥没有被改动过的地方').toHaveLength(1);
});

test('R-032: a non-root user may not create or update a key with an Authorization: Bearer session token', async ({
  testApp,
  app,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const member = await createUser(admin, 'r032endpointbearer');
  const token = await bearerTokenOf(testApp, {
    username: 'r032endpointbearer',
    password: PASSWORD,
  });
  const session = await signInAs(testApp, 'r032endpointbearer');

  const created = await postWithBearer(testApp, '/auth/api-key/create', token, {
    name: '用 Bearer 建的密钥',
  });
  expect((await expectRefusal(created, 403)).code).toBe(
    'API_KEY_CREATION_FORBIDDEN',
  );
  expect(await listOwnKeys(session), 'Bearer 也没有建出密钥').toEqual([]);

  // 有效期同样不能借 Bearer 延长。
  const keys = app.container.resolve(scopedApiKeysToken);
  const existing = await keys.create(
    member.id,
    { name: 'Bearer 想延长的那把' },
    await keys.identityOf(member.id),
  );
  const updated = await postWithBearer(testApp, '/auth/api-key/update', token, {
    keyId: existing.key.id,
    expiresIn: 31_536_000,
  });
  expect((await expectRefusal(updated, 403)).code).toBe(
    'API_KEY_UPDATE_FORBIDDEN',
  );
  const listed = await listBetterAuthKeys(session);
  expect(
    listed.map((row) => row.expiresAt ?? null),
    '过期时间没有被改',
  ).toEqual([null]);
});

test('R-032: root may create a key with an Authorization: Bearer session token', async ({
  testApp,
}) => {
  const token = await bearerTokenOf(testApp, DEFAULT_ADMIN_CREDENTIALS);

  const created = (await expectStatus(
    await postWithBearer(testApp, '/auth/api-key/create', token, {
      name: 'root 用 Bearer 建的密钥',
    }),
    200,
  )) as { id: string; key: string };
  expect(created.key, '创建返回明文').toBeTruthy();

  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const revoked = await deleteThroughBetterAuth(admin, created.id);
  expect(await expectStatus(revoked, 200)).toBeTruthy();
});

test('R-032: an unknown Bearer token is refused without creating anything', async ({
  testApp,
}) => {
  const response = await postWithBearer(
    testApp,
    '/auth/api-key/create',
    'not-a-session-token',
    { name: '垃圾令牌建的密钥' },
  );
  expect(await expectRefusal(response, 401)).toMatchObject({
    code: 'API_KEY_SESSION_UNVERIFIED',
  });
});

test('R-032: a stale cookie whose session was signed out is refused even while the session cookie cache still answers', async ({
  testApp,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const before = await listOwnKeys(admin);
  expect(
    await expectStatus(await admin.fetch('/auth/sign-out', jsonBody({})), 200),
  ).toBeTruthy();

  // 前提：缓存开着，所以同一个 cookie 还能被 /get-session 读成有效会话——这正是要害。
  const cached = (await expectStatus(
    await admin.fetch('/auth/get-session'),
    200,
  )) as { user?: { id: string } } | null;
  expect(cached?.user?.id, 'cookie 缓存还在把注销的会话读成有效').toBe(
    admin.user.id,
  );

  const refused = await createThroughBetterAuth(
    admin,
    '注销后不该建出来的密钥',
  );
  expect((await expectRefusal(refused, 401)).code).toBe(
    'API_KEY_SESSION_UNVERIFIED',
  );

  const fresh = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  expect(await listOwnKeys(fresh), '没有多出密钥').toEqual(before);
});

test('R-032: a root cookie carrying a junk Bearer token is refused', async ({
  testApp,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const before = await listOwnKeys(admin);

  // 不带点的垃圾令牌：bearer 插件认不出它，请求里仍然有一个有效的 root cookie。
  const refused = await admin.fetch('/auth/api-key/create', {
    ...jsonBody({ name: '带垃圾 Bearer 的 cookie 请求' }),
    headers: {
      ...jsonBody({}).headers,
      authorization: 'Bearer not-a-session-token',
    },
  });
  expect((await expectRefusal(refused, 401)).code).toBe(
    'API_KEY_SESSION_UNVERIFIED',
  );
  expect(await listOwnKeys(admin), '没有多出密钥').toEqual(before);
});

test('R-032: a token obtained through the device authorization is refused too', async ({
  testApp,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  await createUser(admin, 'r032endpointdevice');
  const session = await signInAs(testApp, 'r032endpointdevice');

  // RFC 8628：设备拿码 → 登录的人认领并批准 → 设备用码换会话令牌（CLI 就是这么登录的）。
  const code = (await expectStatus(
    await testApp.request(
      '/auth/device/code',
      jsonBody({ client_id: 'nocobase-cli' }),
    ),
    200,
  )) as { device_code: string; user_code: string };
  await expectStatus(
    await session.fetch(
      `/auth/device?user_code=${encodeURIComponent(code.user_code)}`,
    ),
    200,
  );
  await expectStatus(
    await session.fetch(
      '/auth/device/approve',
      jsonBody({ userCode: code.user_code }),
    ),
    200,
  );
  const { access_token: token } = (await expectStatus(
    await testApp.request(
      '/auth/device/token',
      jsonBody({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: code.device_code,
        client_id: 'nocobase-cli',
      }),
    ),
    200,
  )) as { access_token: string };

  const created = await postWithBearer(testApp, '/auth/api-key/create', token, {
    name: '设备令牌建的密钥',
  });
  expect((await expectRefusal(created, 403)).code).toBe(
    'API_KEY_CREATION_FORBIDDEN',
  );
  expect(await listOwnKeys(session), '设备令牌也没有建出密钥').toEqual([]);
});

test('R-032: when the policy itself is missing, a user session is refused', async ({
  testApp,
  app,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  await createUser(admin, 'r032endpointnopolicy');
  const session = await signInAs(testApp, 'r032endpointnopolicy');

  // 模拟「策略或密钥服务拿不到」：这个应用里两个插件始终在，守卫也不能把它当放行。
  const container = app.container;
  const has = container.has.bind(container);
  const hidden = vi
    .spyOn(container, 'has')
    .mockImplementation((token) =>
      token === ownKeyPolicyToken ? false : has(token),
    );
  try {
    const refused = await createThroughBetterAuth(session, '不该建出来的密钥');
    expect(await expectRefusal(refused, 500)).toMatchObject({
      code: 'API_KEY_POLICY_UNAVAILABLE',
    });
  } finally {
    hidden.mockRestore();
  }
  expect(await listOwnKeys(session), '策略不在时也没有建出密钥').toEqual([]);
});

test('R-032: when deciding whether the caller is root fails, the request fails too', async ({
  testApp,
  app,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const member = await createUser(admin, 'r032endpointpolicyerror');
  const session = await signInAs(testApp, 'r032endpointpolicyerror');
  const keys = app.container.resolve(scopedApiKeysToken);
  const existing = await keys.create(
    member.id,
    { name: '判定出错前的密钥' },
    await keys.identityOf(member.id),
  );

  const authz = app.container.resolve(authorizationToken);
  const check = vi
    .spyOn(authz.permissionSets, 'getEffective')
    .mockRejectedValue(new Error('授权服务暂时不可用'));
  try {
    const created = await createThroughBetterAuth(session, '不该建出来的密钥');
    expect((await expectRefusal(created, 500)).code).toBe(
      'API_KEY_POLICY_UNAVAILABLE',
    );
    const updated = await updateThroughBetterAuth(session, {
      keyId: existing.key.id,
      expiresIn: 86_400,
    });
    expect((await expectRefusal(updated, 500)).code).toBe(
      'API_KEY_POLICY_UNAVAILABLE',
    );
  } finally {
    check.mockRestore();
  }

  expect(await listOwnKeys(session), '出错时也没有建出密钥').toHaveLength(1);
  const listed = await listBetterAuthKeys(session);
  expect(listed.map((row) => row.expiresAt ?? null)).toEqual([null]);
});

test('R-032: a configuration file may not carry auth.hooks, while the application default keeps the guard', async ({
  testApp,
}) => {
  const configured = testApp.application.config.get<AuthConfig>('auth');
  expect(
    typeof configured?.hooks?.before,
    '不写 auth.hooks 时，应用自己的守卫在',
  ).toBe('function');

  for (const hooks of [null, {}, { before: null }]) {
    await expect(
      createTestApp({
        createServer: createStandaloneServer,
        config: {
          app: { publicOrigin: 'http://localhost' },
          auth: { secret: SECRET, hooks },
        },
      }),
    ).rejects.toThrow(
      /auth\.hooks carries the application's own-key guard; it cannot be set from a configuration file\./,
    );
  }
});
