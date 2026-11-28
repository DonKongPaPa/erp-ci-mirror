// @vitest-environment node
import {
  DEFAULT_ADMIN_CREDENTIALS,
  signIn,
} from '@nocobase/app-plugin-authentication/testing';
import { describe, expect, vi } from 'vitest';

import {
  FOLLOW_UPS_FIXTURE,
  FIXTURE_POOL_ROWS,
  POOL_FIXTURE,
} from '../fixtures/requirements-board.js';
import { createAppTest } from '../helpers/test-app.js';
import { createStandaloneServer } from '../../server/standalone.js';

/**
 * 验收第 3 条：开发工具关着时端点不存在；开着时非管理员 403 且响应体没有任何需求编号；
 * 管理员拿到的 totals.pool 等于夹具主表的行数。
 *
 * 读文件的那一层替换成夹具（vi.mock 在模块加载前生效），测试不读真文件；端点本身、守卫、
 * 授权判定、路由注册全部走真实应用。
 */

vi.mock(
  '../../server/dev-tools/requirements-board-files.js',
  async (importOriginal) => {
    const actual = await importOriginal<
      typeof import('../../server/dev-tools/requirements-board-files.js')
    >();
    return {
      ...actual,
      readRequirementsSources: async () => ({
        pool: POOL_FIXTURE,
        followUps: FOLLOW_UPS_FIXTURE,
      }),
    };
  },
);

const config = {
  app: { publicOrigin: 'http://localhost' },
  auth: { secret: 'test-auth-secret-at-least-32-characters' },
};

const json = (body: unknown) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', origin: 'http://localhost' },
  body: JSON.stringify(body),
});

describe('requirements board endpoint enabled in development', () => {
  const test = createAppTest({
    createServer: createStandaloneServer,
    scope: 'test',
    server: { env: { NODE_ENV: 'development' } },
    config: { ...config, devTools: { accountSwitcher: { enabled: true } } },
  });

  test('an administrator gets the fixture totals and no skipped data is invented', async ({
    testApp,
  }) => {
    const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
    const response = await admin.fetch('/dev/requirements-board');
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: {
        generatedAt: string;
        totals: { pool: number; parsed: number; skipped: number };
        requirements: readonly { id: string; blocking: string }[];
      };
    };
    expect(body.data.totals.pool).toBe(FIXTURE_POOL_ROWS);
    expect(body.data.totals.parsed).toBe(FIXTURE_POOL_ROWS - 1);
    expect(body.data.totals.skipped).toBe(1);
    expect(body.data.requirements.map((item) => item.id)).toContain('R-001');
    expect(body.data.requirements.filter((item) => item.name === '缺列的行')).toEqual([]);
    expect(body.data.generatedAt).toBeTruthy();
  });

  test('a non-administrator gets 403 with no requirement data in the body', async ({
    testApp,
  }) => {
    const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
    const listed = await admin.fetch('/dev-tools/accounts');
    expect(listed.status).toBe(200);
    const accounts = ((await listed.json()) as {
      data: readonly { id: string; username: string }[];
    }).data;
    const staff = accounts.find((account) => account.username === 'demo.staff');
    expect(staff).toBeDefined();

    // 用开发工具自带的演示身份当非管理员，会话来自真实的切换端点。
    const switched = await admin.fetch(
      '/dev-tools/switch-account',
      json({ userId: staff!.id }),
    );
    expect(switched.status).toBe(200);
    const cookie = switched.headers
      .getSetCookie()
      .map((header) => header.split(';')[0])
      .join('; ');

    const response = await testApp.request('/dev/requirements-board', {
      headers: { cookie },
    });
    expect(response.status).toBe(403);
    const text = await response.text();
    const body = JSON.parse(text) as {
      error?: { reason?: string };
      data?: unknown;
    };
    expect(body.error?.reason).toBe('DEV_TOOLS_ADMIN_ONLY');
    expect(body).not.toHaveProperty('data');
    expect(text).not.toMatch(/R-\d+/u);
    expect(text).not.toContain('微信客户消息接入');
    expect(text).not.toContain('知识库累积与 AI 代填');
  });
});

describe('requirements board endpoint off by default', () => {
  const test = createAppTest({
    createServer: createStandaloneServer,
    scope: 'test',
    config,
  });

  test('the endpoint does not exist when dev tools are off', async ({
    testApp,
  }) => {
    const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
    const response = await admin.fetch('/dev/requirements-board');
    expect(response.status).toBe(404);
  });
});
