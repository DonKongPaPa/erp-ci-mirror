// @vitest-environment node
import {
  DEFAULT_ADMIN_CREDENTIALS,
  signIn,
} from '@nocobase/app-plugin-authentication/testing';
import type { TestApp } from '@nocobase/app-testing/server';
import { describe, expect, test } from 'vitest';

import { createAppTest, createTestApp } from '../helpers/test-app.js';
import { isDevelopmentNodeEnv } from '../../server/dev-tools/settings.js';
import { createStandaloneServer } from '../../server/standalone.js';

/**
 * R-037 开发环境专用的多用户快捷切换，服务端部分。
 *
 * 验收标准第 1–5 条。两个应用各自独立：开启的那个跑在开发环境（`NODE_ENV=development`），
 * 演示账户由 provider 在启动时建出来；关着的那个用默认配置，证明默认是关的、库里没有演示账户。
 * 「生产环境开不了」直接起一个生产环境的应用，断言启动失败并带上那句错。
 */

interface ApiErrorBody {
  error: {
    code: number;
    status: string;
    reason: string;
    domain: string;
    message: string;
  };
  data?: unknown;
}

interface Account {
  id: string;
  name: string;
  username: string;
  role: string;
}

const config = {
  app: { publicOrigin: 'http://localhost' },
  auth: { secret: 'test-auth-secret-at-least-32-characters' },
};

const json = (body: unknown, method = 'POST', origin = 'http://localhost') => ({
  method,
  headers: { 'content-type': 'application/json', origin },
  body: JSON.stringify(body),
});

const cookieOf = (response: Response): string =>
  response.headers
    .getSetCookie()
    .map((header) => header.split(';')[0])
    .join('; ');

const expectedAccounts = [
  {
    username: 'demo.quality_manager',
    name: '演示 · 质量主管',
    role: 'quality_manager',
  },
  {
    username: 'demo.quality_inspector',
    name: '演示 · 质量员',
    role: 'quality_inspector',
  },
  {
    username: 'demo.dept_manager',
    name: '演示 · 部门主管',
    role: 'dept_manager',
  },
  { username: 'demo.staff', name: '演示 · 普通员工', role: 'staff' },
] as const;

interface AccountReader {
  fetch(path: string, init?: RequestInit): Promise<Response>;
}

const readAccounts = async (
  session: AccountReader,
): Promise<readonly Account[]> => {
  const response = await session.fetch('/dev-tools/accounts');
  expect(response.status).toBe(200);
  const body = (await response.json()) as { data: readonly Account[] };
  return body.data;
};

describe('enabled in development', () => {
  // 一个 describe 里一个应用；两个应用在同一个文件里，所以用 test scope，测试之间互不影响。
  const test = createAppTest({
    createServer: createStandaloneServer,
    scope: 'test',
    server: { env: { NODE_ENV: 'development' } },
    config: { ...config, devTools: { accountSwitcher: { enabled: true } } },
  });

  test('lists one demo account per business role with only four fields', async ({
    testApp,
  }) => {
    const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
    const accounts = await readAccounts(admin);

    expect(
      accounts.map(({ username, name, role }) => ({ username, name, role })),
    ).toEqual(expectedAccounts);
    expect(new Set(accounts.map((account) => account.id)).size).toBe(4);
    for (const account of accounts) {
      expect(Object.keys(account).sort()).toEqual([
        'id',
        'name',
        'role',
        'username',
      ]);
    }
    // 姓名、标识之外不放任何人员信息：R-028 的选择性暴露。
    expect(JSON.stringify(accounts)).not.toContain('@');
  });

  test('switching ends the current session and signs in as the target', async ({
    testApp,
  }) => {
    const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
    expect((await admin.fetch('/users')).status).toBe(200);
    const accounts = await readAccounts(admin);
    const staff = accounts.find((account) => account.username === 'demo.staff');
    const manager = accounts.find(
      (account) => account.username === 'demo.quality_manager',
    );
    expect(staff).toBeDefined();
    expect(manager).toBeDefined();

    const switched = await admin.fetch(
      '/dev-tools/switch-account',
      json({ userId: staff!.id }),
    );
    expect(switched.status).toBe(200);
    const cookies = switched.headers.getSetCookie();
    expect(cookies.length).toBeGreaterThan(0);
    const body = (await switched.json()) as { data: Account };
    expect(body.data).toEqual(staff);
    expect(JSON.stringify(body)).not.toContain('@');

    // 旧凭据是真的失效了：认证端点与业务端点都回到 401，而不是还挂在原来的会话上。
    expect((await admin.fetch('/users/me/preferences')).status).toBe(401);
    expect((await admin.fetch('/quality/tickets')).status).toBe(401);

    // 新会话就是目标账户本人：身份是 staff，用户管理没有权限。
    const staffCookie = cookieOf(switched);
    expect(staffCookie).not.toBe('');
    const session = await testApp.request('/auth/get-session', {
      headers: { cookie: staffCookie },
    });
    const sessionBody = (await session.json()) as {
      user: { id: string; username: string };
    };
    expect(sessionBody.user.id).toBe(staff!.id);
    expect(sessionBody.user.username).toBe('demo.staff');
    expect(
      (
        await testApp.request('/users/me/preferences', {
          headers: { cookie: staffCookie },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await testApp.request('/users', {
          headers: { cookie: staffCookie },
        })
      ).status,
    ).toBe(403);

    // 演示账户之间可以直接再换；换到质量主管后，质量工单按那个角色的授权通过。
    expect(
      (
        await testApp.request('/quality/tickets', {
          headers: { cookie: staffCookie },
        })
      ).status,
    ).toBe(403);
    const toManager = await testApp.request('/dev-tools/switch-account', {
      method: 'POST',
      headers: {
        cookie: staffCookie,
        'content-type': 'application/json',
        origin: 'http://localhost',
      },
      body: JSON.stringify({ userId: manager!.id }),
    });
    expect(toManager.status).toBe(200);
    const managerCookie = cookieOf(toManager);
    expect(
      (
        await testApp.request('/quality/tickets', {
          headers: { cookie: managerCookie },
        })
      ).status,
    ).toBe(200);
  });

  test('refuses anonymous callers, a missing origin and a foreign target', async ({
    testApp,
  }) => {
    expect((await testApp.request('/dev-tools/accounts')).status).toBe(401);
    expect(
      (
        await testApp.request(
          '/dev-tools/switch-account',
          json({ userId: 'not-signed-in' }),
        )
      ).status,
    ).toBe(401);

    const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
    const accounts = await readAccounts(admin);

    // 写操作缺 Origin：框架的来源校验在业务判断之前拒绝。
    const noOrigin = await admin.fetch('/dev-tools/switch-account', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId: accounts[0]!.id }),
    });
    expect(noOrigin.status).toBe(403);
    expect(((await noOrigin.json()) as ApiErrorBody).error.reason).toBe(
      'INVALID_CSRF_ORIGIN',
    );

    const foreign = await admin.fetch(
      '/dev-tools/switch-account',
      json({ userId: accounts[0]!.id }, 'POST', 'https://untrusted.example'),
    );
    expect(foreign.status).toBe(403);

    // 清单之外的人（这里是管理员自己）切不过去，响应里不带任何账户字段。
    const outside = await admin.fetch(
      '/dev-tools/switch-account',
      json({ userId: admin.user.id }),
    );
    expect(outside.status).toBe(422);
    const errorBody = (await outside.json()) as ApiErrorBody;
    expect(errorBody.error.reason).toBe('DEMO_ACCOUNT_NOT_FOUND');
    expect(errorBody.data).toBeUndefined();
    expect(Object.keys(errorBody)).toEqual(['error']);
    expect(JSON.stringify(errorBody)).not.toContain(admin.user.email);

    // 被拒的切换不注销当前会话。
    expect((await admin.fetch('/users/me/preferences')).status).toBe(200);
  });
});

describe('off by default', () => {
  const test = createAppTest({
    createServer: createStandaloneServer,
    scope: 'test',
    config,
  });

  test('keeps both endpoints and every demo account out', async ({
    testApp,
    app,
    connection,
  }) => {
    expect(app.config.get('devTools.accountSwitcher.enabled')).toBe(false);
    const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
    expect((await admin.fetch('/dev-tools/accounts')).status).toBe(404);
    expect(
      (
        await admin.fetch(
          '/dev-tools/switch-account',
          json({ userId: admin.user.id }),
        )
      ).status,
    ).toBe(404);
    expect(
      await connection.query
        .selectFrom('user')
        .select('id')
        .where('username', 'like', 'demo.%')
        .execute(),
    ).toEqual([]);
  });
});

test('treats a missing environment as production', () => {
  expect(isDevelopmentNodeEnv(undefined)).toBe(false);
  expect(isDevelopmentNodeEnv('production')).toBe(false);
  expect(isDevelopmentNodeEnv('test')).toBe(false);
  expect(isDevelopmentNodeEnv('develop')).toBe(true);
  expect(isDevelopmentNodeEnv('development')).toBe(true);
});

test('refuses to start when the switch is on outside development', async () => {
  let opened: TestApp | undefined;
  try {
    await expect(async () => {
      opened = await createTestApp({
        createServer: createStandaloneServer,
        server: { env: { NODE_ENV: 'production' } },
        config: {
          ...config,
          devTools: { accountSwitcher: { enabled: true } },
        },
      });
    }).rejects.toThrow('开发工具不能在生产环境开启');
  } finally {
    await opened?.close();
  }
});
