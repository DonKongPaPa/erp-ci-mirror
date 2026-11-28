// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  DEFAULT_ADMIN_CREDENTIALS,
  signIn,
} from '@nocobase/app-plugin-authentication/testing';
import { afterAll, describe, expect } from 'vitest';

import { FIXTURE_REGISTRY, FIXTURE_TEXT } from '../fixtures/feedback.js';
import { createStandaloneServer } from '../../server/standalone.js';
import { createAppTest } from '../helpers/test-app.js';

/**
 * 验收第 2、4、5 条：三种定位各一条；非管理员 403 且响应没有反馈文本；非开发环境 404；
 * 附件校验类型与大小；提交后临时仓库根的 git status 不变 —— 反馈不弄脏工作区。
 */

const repo = mkdtempSync(path.join(tmpdir(), 'hs-r087-endpoint-'));
writeFileSync(path.join(repo, '.gitignore'), `.local/\n`);

const registryDir = path.join(repo, 'HANDOFF', 'tasks');
execFileSync('mkdir', ['-p', registryDir]);
writeFileSync(
  path.join(registryDir, 'feature-registry.json'),
  `${JSON.stringify(FIXTURE_REGISTRY, null, 2)}\n`,
);
execFileSync('git', ['init', '-q', repo]);
execFileSync('git', ['-C', repo, 'add', '.']);
execFileSync('git', [
  '-C',
  repo,
  '-c',
  'user.name=test',
  '-c',
  'user.email=test@agents.invalid',
  'commit',
  '-qm',
  'init',
]);
process.env.FEEDBACK_REPO_ROOT = repo;

afterAll(() => {
  delete process.env.FEEDBACK_REPO_ROOT;
  rmSync(repo, { recursive: true, force: true });
});

const config = {
  app: { publicOrigin: 'http://localhost' },
  auth: { secret: 'test-auth-secret-at-least-32-characters' },
};

const json = (body: unknown) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', origin: 'http://localhost' },
  body: JSON.stringify(body),
});

const stateFile = path.join(repo, '.local', 'feedback', 'state.json');
const readState = () =>
  JSON.parse(readFileSync(stateFile, 'utf8')) as {
    items: readonly { id: string; text: string; notes: readonly unknown[] }[];
    seen: Readonly<Record<string, string>>;
  };
const readSeen = (): Readonly<Record<string, string>> => {
  try {
    return readState().seen ?? {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
};
const gitStatus = () =>
  execFileSync('git', ['-C', repo, 'status', '--porcelain'], {
    encoding: 'utf8',
  });

// 1x1 PNG。
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lXcAAAAASUVORK5CYII=',
  'base64',
);
const binary = (bytes: Buffer, contentType: string) => ({
  method: 'POST',
  headers: { 'content-type': contentType, origin: 'http://localhost' },
  body: bytes,
});

describe('测试反馈端点（开发环境，开关打开）', () => {
  const test = createAppTest({
    createServer: createStandaloneServer,
    scope: 'test',
    server: { env: { NODE_ENV: 'development' } },
    config: { ...config, devTools: { accountSwitcher: { enabled: true } } },
  });

  test('三种定位方式都能提交，少于四个字被拒', async ({ testApp }) => {
    const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
    expect(
      (
        await admin.fetch(
          '/dev/feedback',
          json({ route: '/items', target: { kind: 'page', route: '/items' }, text: '太短' }),
        )
      ).status,
    ).toBe(400);

    const targets = [
      { kind: 'page', route: '/items' },
      { kind: 'element', text: '新建物料', locator: '[data-testid="item-new"]' },
      { kind: 'registry', registryId: 'items' },
    ];
    const ids: string[] = [];
    for (const target of targets) {
      const response = await admin.fetch(
        '/dev/feedback',
        json({ route: '/items', target, text: '物料列表打开很慢', kinds: ['flow'] }),
      );
      expect(response.status).toBe(201);
      const body = (await response.json()) as { data: { id: string } };
      ids.push(body.data.id);
    }
    expect(ids).toEqual(['FB-001', 'FB-002', 'FB-003']);
    expect(readState().items).toHaveLength(3);
  }, 90_000);

  test('截图上传与读取，非法类型与超大被拒', async ({ testApp }) => {
    const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
    const uploaded = await admin.fetch(
      '/dev/feedback/attachments',
      binary(PNG, 'image/png'),
    );
    expect(uploaded.status).toBe(201);
    const { data } = (await uploaded.json()) as {
      data: { attachmentId: string };
    };
    expect(data.attachmentId).toMatch(/^[0-9a-f-]{36}$/u);
    const content = await admin.fetch(
      `/dev/feedback/attachments/${data.attachmentId}`,
    );
    expect(content.status).toBe(200);
    expect(content.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await content.arrayBuffer())).toEqual(PNG);

    expect(
      (
        await admin.fetch(
          '/dev/feedback/attachments',
          binary(Buffer.from('not an image'), 'text/plain'),
        )
      ).status,
    ).toBe(415);
    expect(
      (
        await admin.fetch(
          '/dev/feedback/attachments',
          binary(Buffer.alloc(2 * 1024 * 1024 + 1, 1), 'image/png'),
        )
      ).status,
    ).toBe(413);
  }, 90_000);

  test('追加说明不改原文，git status 不变', async ({ testApp }) => {
    const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
    const before = readState().items[0]!;
    const response = await admin.fetch(
      `/dev/feedback/${before.id}/notes`,
      json({ text: '又补充一句' }),
    );
    expect(response.status).toBe(201);
    const after = readState().items[0]!;
    expect(after.text).toBe(before.text);
    expect(after.notes).toHaveLength(1);
    expect(gitStatus()).toBe('');
  }, 90_000);

  test('看过没意见写进状态文件，重复点只更新时刻不重复计数', async ({ testApp }) => {
    const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
    const first = await admin.fetch(
      '/dev/feedback/seen',
      json({ registryId: 'items' }),
    );
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as {
      data: { registryId: string; at: string };
    };
    expect(firstBody.data.registryId).toBe('items');
    expect(readSeen().items).toBe(firstBody.data.at);

    const second = await admin.fetch(
      '/dev/feedback/seen',
      json({ registryId: 'items' }),
    );
    expect(second.status).toBe(201);
    // seen 是按登记编号索引的映射：重复点只覆盖时刻，没有第二条。
    expect(Object.keys(readSeen()).filter((id) => id === 'items')).toHaveLength(1);
    expect(readSeen().items).toBeTypeOf('string');

    const unknown = await admin.fetch(
      '/dev/feedback/seen',
      json({ registryId: 'not-in-registry' }),
    );
    expect(unknown.status).toBe(400);
  }, 90_000);

  test('看过没意见：非管理员 403 且响应体不带内容', async ({ testApp }) => {
    const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
    const listed = await admin.fetch('/dev-tools/accounts');
    const accounts = ((await listed.json()) as {
      data: readonly { id: string; username: string }[];
    }).data;
    const staff = accounts.find((account) => account.username === 'demo.staff');
    const switched = await admin.fetch(
      '/dev-tools/switch-account',
      json({ userId: staff!.id }),
    );
    const cookie = switched.headers
      .getSetCookie()
      .map((header) => header.split(';')[0])
      .join('; ');

    const response = await testApp.request('/dev/feedback/seen', {
      ...json({ registryId: 'items' }),
      headers: {
        'content-type': 'application/json',
        origin: 'http://localhost',
        cookie,
      },
    });
    expect(response.status).toBe(403);
    const text = await response.text();
    const body = JSON.parse(text) as {
      error?: { reason?: string };
      data?: unknown;
    };
    expect(body.error?.reason).toBe('DEV_TOOLS_ADMIN_ONLY');
    expect(body).not.toHaveProperty('data');
    expect(text).not.toContain('items');
  }, 90_000);

  test('非管理员 403，响应体没有任何反馈文本', async ({ testApp }) => {
    const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
    const listed = await admin.fetch('/dev-tools/accounts');
    expect(listed.status).toBe(200);
    const accounts = ((await listed.json()) as {
      data: readonly { id: string; username: string }[];
    }).data;
    const staff = accounts.find((account) => account.username === 'demo.staff');
    expect(staff).toBeDefined();

    const switched = await admin.fetch(
      '/dev-tools/switch-account',
      json({ userId: staff!.id }),
    );
    expect(switched.status).toBe(200);
    const cookie = switched.headers
      .getSetCookie()
      .map((header) => header.split(';')[0])
      .join('; ');

    const response = await testApp.request('/dev/feedback', {
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
    expect(text).not.toContain(FIXTURE_TEXT);
    expect(text).not.toContain('FB-001');
  }, 90_000);
});

describe('测试反馈端点（开发工具关着）', () => {
  const test = createAppTest({
    createServer: createStandaloneServer,
    scope: 'test',
    config,
  });

  test('非开发环境端点不存在', async ({ testApp }) => {
    const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
    expect((await admin.fetch('/dev/feedback')).status).toBe(404);
    expect(
      (
        await admin.fetch(
          '/dev/feedback',
          json({
            route: '/items',
            target: { kind: 'page', route: '/items' },
            text: '物料列表打开很慢',
          }),
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await admin.fetch(
          '/dev/feedback/attachments',
          binary(PNG, 'image/png'),
        )
      ).status,
    ).toBe(404);
  }, 90_000);

  test('看过没意见：非开发环境端点 404', async ({ testApp }) => {
    const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
    const response = await admin.fetch(
      '/dev/feedback/seen',
      json({ registryId: 'items' }),
    );
    expect(response.status).toBe(404);
    const text = await response.text();
    expect(text).not.toContain('registryId');
  }, 90_000);
});
