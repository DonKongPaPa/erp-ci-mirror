// @vitest-environment node
import {
  DEFAULT_ADMIN_CREDENTIALS,
  signIn,
} from '@nocobase/app-plugin-authentication/testing';
import { authenticationToken } from '@nocobase/app-plugin-authentication/server';
import { authorizationToken } from '@nocobase/app-plugin-authorization';
import { loggingToken } from '@nocobase/app-server/logging';
import type { Application } from '@nocobase/app-server/application';
import { i18nToken } from '@nocobase/app-server/i18n';
import type { DatabaseConnection } from '@nocobase/db';
import type { TestApp } from '@nocobase/app-testing/server';
import { describe, expect, test, vi } from 'vitest';

import { createAppTest, createTestApp } from '../helpers/test-app.js';
import { isDevelopmentNodeEnv } from '../../server/dev-tools/settings.js';
import DevAccountSwitcherProvider from '../../server/providers/dev-account-switcher.js';
import DevToolsGuardProvider from '../../server/providers/dev-tools-guard.js';
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
  { username: 'demo.warehouse', name: '演示 · 仓管', role: 'warehouse' },
  { username: 'demo.purchase', name: '演示 · 采购', role: 'purchase' },
  { username: 'demo.sales', name: '演示 · 销售', role: 'sales' },
  { username: 'demo.finance', name: '演示 · 财务', role: 'finance' },
  { username: 'demo.planning', name: '演示 · 计划', role: 'planning' },
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
    expect(new Set(accounts.map((account) => account.id)).size).toBe(
      expectedAccounts.length,
    );
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

  test('publishes the switch to the client where the tools are registered', async ({
    app,
  }) => {
    expect(app.config.get('devTools.accountSwitcher.enabled')).toBe(true);
    expect(app.config.publicValues?.()).toMatchObject({
      devTools: { accountSwitcher: { enabled: true } },
    });
  });

  test('R-026: every demo person account carries the staff baseline, exactly once', async ({
    connection,
    testApp,
  }) => {
    const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
    const accounts = await readAccounts(admin);
    const assignments = await connection.query
      .selectFrom('authorizationPermissionSetAssignments')
      .select(['subjectId', 'permissionSetKey'])
      .where('subjectType', '=', 'user')
      .where(
        'subjectId',
        'in',
        accounts.map((account) => account.id),
      )
      .execute();
    for (const account of accounts) {
      const sets = assignments
        .filter((row) => String(row.subjectId) === account.id)
        .map((row) => String(row.permissionSetKey))
        .sort();
      // 业务角色加上基线 staff；staff 恰好一条（重跑不重复指派）。
      expect(sets, `${account.username} 的权限集`).toEqual(
        [...new Set([account.role, 'staff'])].sort(),
      );
    }
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

  test('switching to a demo account resets a stale interface language to the application default', async ({
    connection,
    testApp,
    app,
  }) => {
    const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
    const accounts = await readAccounts(admin);
    const manager = accounts.find(
      (account) => account.username === 'demo.quality_manager',
    );
    expect(manager).toBeDefined();
    const now = new Date();
    await connection.query
      .insertInto('userPreferences')
      .values({
        id: 'r4-stale-locale',
        userId: manager!.id,
        key: 'i18n.locale',
        value: JSON.stringify('en-US'),
        createdAt: now,
        updatedAt: now,
      })
      .execute();
    const before = await connection.query
      .selectFrom('userPreferences')
      .select('value')
      .where('userId', '=', manager!.id)
      .where('key', '=', 'i18n.locale')
      .executeTakeFirst();
    expect(JSON.parse(String(before!.value))).toBe('en-US');

    const switched = await admin.fetch(
      '/dev-tools/switch-account',
      json({ userId: manager!.id }),
    );
    expect(switched.status).toBe(200);
    const after = await connection.query
      .selectFrom('userPreferences')
      .select('value')
      .where('userId', '=', manager!.id)
      .where('key', '=', 'i18n.locale')
      .executeTakeFirst();
    expect(JSON.parse(String(after!.value))).toBe(
      app.container.resolve(i18nToken).getDefaultLocale(),
    );
  });

  // 注销失败就不签发：切换失败并说得出原因、留一条不带令牌的警告，旧会话不被换成新会话。
  test('a failed sign-out refuses the switch before a new session is signed', async ({
    testApp,
    app,
  }) => {
    const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
    const accounts = await readAccounts(admin);
    const staff = accounts.find((account) => account.username === 'demo.staff');
    expect(staff).toBeDefined();

    const auth = app.container.resolve(authenticationToken);
    const realHandler = auth.handler.bind(auth);
    const failedSignOut = vi
      .spyOn(auth, 'handler')
      .mockImplementation((request, options) =>
        new URL(request.url).pathname.endsWith('/auth/sign-out')
          ? Promise.resolve(new Response('sign-out is down', { status: 503 }))
          : realHandler(request, options),
      );
    const warning = vi.spyOn(
      app.container.resolve(loggingToken).getLogger('app'),
      'warn',
    );
    try {
      const response = await admin.fetch(
        '/dev-tools/switch-account',
        json({ userId: staff!.id }),
      );
      expect(response.status).toBe(503);
      const body = (await response.json()) as ApiErrorBody;
      expect(body.error.reason).toBe('DEMO_ACCOUNT_SIGN_OUT_FAILED');
      expect(response.headers.getSetCookie()).toEqual([]);
      // 没有签发目标账户的会话：管理员自己的会话仍然可用。
      expect((await admin.fetch('/users/me/preferences')).status).toBe(200);

      const call = warning.mock.calls.find(
        ([bindings]) =>
          (bindings as { reason?: unknown } | undefined)?.reason ===
          'DEMO_ACCOUNT_SIGN_OUT_FAILED',
      );
      expect(call, '注销失败要留一条警告日志').toBeDefined();
      const bindings = call![0] as Record<string, unknown>;
      expect(bindings.callerId).toBe(admin.user.id);
      expect(bindings.targetUsername).toBe('demo.staff');
      expect(bindings.signOutFailure).toBe('http-503');
      const logged = JSON.stringify(warning.mock.calls);
      expect(logged, '日志不带会话 cookie').not.toContain(admin.cookie);
      expect(logged, '日志不带邮箱').not.toContain(admin.user.email);
    } finally {
      failedSignOut.mockRestore();
      warning.mockRestore();
    }
  });

  // 个人密钥不算「已登录」：两个切换接口只认用户会话，持密钥的请求被拒且不发新会话。
  test('a personal API key is refused by both switcher endpoints', async ({
    testApp,
  }) => {
    const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
    const accounts = await readAccounts(admin);
    const staff = accounts.find((account) => account.username === 'demo.staff');
    expect(staff).toBeDefined();

    const created = await admin.fetch(
      '/auth/api-key/create',
      json({ name: '切换测试用密钥' }),
    );
    expect(created.status).toBe(200);
    const secret = ((await created.json()) as { key: string }).key;
    expect(secret).toBeTruthy();
    const keyHeaders = {
      'content-type': 'application/json',
      origin: 'http://localhost',
      'x-api-key': secret,
    };

    const listed = await testApp.request('/dev-tools/accounts', {
      headers: keyHeaders,
    });
    expect(listed.status).toBe(403);
    expect(((await listed.json()) as ApiErrorBody).error.reason).toBe(
      'API_KEY_SESSION_FORBIDDEN',
    );

    const switched = await testApp.request('/dev-tools/switch-account', {
      method: 'POST',
      headers: keyHeaders,
      body: JSON.stringify({ userId: staff!.id }),
    });
    expect(switched.status).toBe(403);
    expect(((await switched.json()) as ApiErrorBody).error.reason).toBe(
      'API_KEY_SESSION_FORBIDDEN',
    );
    expect(switched.headers.getSetCookie()).toEqual([]);
  });

  // 「停用」的过滤：停用的演示账户不列出，也不能切过去。
  test('a disabled demo account is neither listed nor switchable', async ({
    testApp,
    connection,
  }) => {
    const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
    const accounts = await readAccounts(admin);
    const staff = accounts.find((account) => account.username === 'demo.staff');
    expect(staff).toBeDefined();
    await markAccount(connection, staff!.id, { disabledAt: new Date() });

    expect((await readAccounts(admin)).map((a) => a.username)).not.toContain(
      'demo.staff',
    );
    const switched = await admin.fetch(
      '/dev-tools/switch-account',
      json({ userId: staff!.id }),
    );
    expect(switched.status).toBe(422);
    expect(((await switched.json()) as ApiErrorBody).error.reason).toBe(
      'DEMO_ACCOUNT_NOT_FOUND',
    );
    expect((await admin.fetch('/users/me/preferences')).status).toBe(200);
  });

  // 「删除」的过滤：删除的演示账户不列出，也不能切过去。
  test('a deleted demo account is neither listed nor switchable', async ({
    testApp,
    connection,
  }) => {
    const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
    const accounts = await readAccounts(admin);
    const staff = accounts.find((account) => account.username === 'demo.staff');
    expect(staff).toBeDefined();
    await markAccount(connection, staff!.id, { deletedAt: new Date() });

    expect((await readAccounts(admin)).map((a) => a.username)).not.toContain(
      'demo.staff',
    );
    const switched = await admin.fetch(
      '/dev-tools/switch-account',
      json({ userId: staff!.id }),
    );
    expect(switched.status).toBe(422);
    expect(((await switched.json()) as ApiErrorBody).error.reason).toBe(
      'DEMO_ACCOUNT_NOT_FOUND',
    );
    expect((await admin.fetch('/users/me/preferences')).status).toBe(200);
  });

  // 不自动恢复：停用或删除过的演示账户重跑初始化后仍是停用/删除，也不会另建同名用户。
  test('startup leaves disabled or deleted demo accounts untouched', async ({
    testApp,
    app,
    connection,
  }) => {
    const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
    const accounts = await readAccounts(admin);
    const staff = accounts.find((account) => account.username === 'demo.staff');
    const manager = accounts.find(
      (account) => account.username === 'demo.dept_manager',
    );
    expect(staff).toBeDefined();
    expect(manager).toBeDefined();
    await markAccount(connection, staff!.id, { deletedAt: new Date() });
    await markAccount(connection, manager!.id, { disabledAt: new Date() });

    // 再跑一次启动初始化，等价于重启时那一段；管理员的删除与停用要算数。
    await new DevAccountSwitcherProvider(app).boot();
    const rows = await connection.query
      .selectFrom('user')
      .select(['id', 'username', 'disabledAt', 'deletedAt'])
      .where('username', 'in', ['demo.staff', 'demo.dept_manager'])
      .execute();
    expect(rows, '没有另建同名用户').toHaveLength(2);
    const byUsername = new Map(rows.map((row) => [String(row.username), row]));
    expect(
      byUsername.get('demo.staff')?.deletedAt,
      '删除标记仍在',
    ).not.toBeNull();
    expect(
      byUsername.get('demo.dept_manager')?.disabledAt,
      '停用标记仍在',
    ).not.toBeNull();

    // 两个账户都不在可切换清单里。
    const listed = (await readAccounts(admin)).map((a) => a.username);
    expect(listed).not.toContain('demo.staff');
    expect(listed).not.toContain('demo.dept_manager');
  });
});

/**
 * R-075：老环境里 seed 执行过之后又追加了角色，开发库缺 warehouse。启动初始化要
 * 跳过挂不上的那一个账号，继续建其余账号，也不能留下没挂上角色的孤儿用户。
 */
describe('a missing application role is not fatal', () => {
  const test = createAppTest({
    createServer: createStandaloneServer,
    scope: 'test',
    server: { env: { NODE_ENV: 'development' } },
    config: { ...config, devTools: { accountSwitcher: { enabled: true } } },
  });

  test('skips only the account whose role is missing and warns how to fix it', async ({
    app,
    testApp,
    connection,
  }) => {
    const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
    // 先等启动初始化真的把演示账号建出来，再拆掉它们与一个后来加的角色。
    expect(await readAccounts(admin)).toHaveLength(expectedAccounts.length);
    await connection.query
      .deleteFrom('user')
      .where('username', 'like', 'demo.%')
      .execute();
    await app.container
      .resolve(authorizationToken)
      .permissionSets.delete('warehouse');

    const warning = vi.spyOn(
      app.container.resolve(loggingToken).getLogger('app'),
      'warn',
    );
    try {
      await expect(
        new DevAccountSwitcherProvider(app).boot(),
      ).resolves.toBeUndefined();

      const accounts = await readAccounts(admin);
      expect(accounts.map((account) => account.username).sort()).toEqual(
        expectedAccounts
          .filter((account) => account.username !== 'demo.warehouse')
          .map((account) => account.username)
          .sort(),
      );
      expect(
        await connection.query
          .selectFrom('user')
          .select('id')
          .where('username', '=', 'demo.warehouse')
          .execute(),
        '挂不上角色的账号不能留下用户行',
      ).toEqual([]);

      const call = warning.mock.calls.find(([bindings]) =>
        JSON.stringify(bindings).includes('demo.warehouse'),
      );
      expect(call, '缺角色要留一条警告日志').toBeDefined();
      const logged = JSON.stringify(warning.mock.calls);
      expect(logged).toContain('warehouse');
      expect(logged, '日志要写明补齐角色的命令').toContain(
        'pnpm nocobase db apply',
      );
    } finally {
      warning.mockRestore();
    }
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
    // R-073：非开发环境不登记开发工具的配置节 —— 开关读不到，也不发布到公开配置。
    // 「默认关着、开了就起不来」由生产常驻的启动守卫守（下面两条用例）。
    expect(app.config.get('devTools.accountSwitcher.enabled')).toBeUndefined();
    expect(app.config.publicValues?.() ?? {}).not.toHaveProperty('devTools');
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

// 启动门的行为（不是查源码文字）：生产配置写着开关时，守卫的 boot 真的拒绝启动；环境标记缺失按生产对待。
test('the guard refuses to boot outside development when the switch is configured on', async () => {
  for (const nodeEnv of ['production', 'test', undefined]) {
    const app = {
      nodeEnv,
      config: { get: () => ({ accountSwitcher: { enabled: true } }) },
    } as unknown as Application;
    await expect(new DevToolsGuardProvider(app).boot()).rejects.toThrow(
      '开发工具不能在生产环境开启',
    );
  }
});

test('the guard lets development, an off switch and a missing section boot', async () => {
  for (const [nodeEnv, section] of [
    ['development', { accountSwitcher: { enabled: true } }],
    ['production', { accountSwitcher: { enabled: false } }],
    ['production', {}],
    [undefined, undefined],
  ] as const) {
    const app = {
      nodeEnv,
      config: { get: () => section },
    } as unknown as Application;
    await expect(
      new DevToolsGuardProvider(app).boot(),
    ).resolves.toBeUndefined();
  }
});

/** 直接改库模拟停用与删除：这两条用户管理路径不属于本端点的验收范围。 */
async function markAccount(
  connection: DatabaseConnection,
  userId: string,
  values: { disabledAt?: Date; deletedAt?: Date },
): Promise<void> {
  await connection
    .repository<{ id: string }>('user')
    .updateMany({ filter: { id: userId }, values });
}
