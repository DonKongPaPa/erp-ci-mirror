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

import {
  FIXTURE_QUESTIONS,
  FIXTURE_QUESTION_TEXT,
} from '../fixtures/confirmations.js';
import { createAppTest } from '../helpers/test-app.js';
import { createStandaloneServer } from '../../server/standalone.js';

/**
 * 验收第 2、4、7 条：非管理员 403 且响应没有题目文本；单选传清单外的值 400；
 * 提交后状态文件多一条，而临时仓库根的 `git status` 不变 —— 答复不弄脏工作区。
 * 临时目录当仓库根，通过环境变量指过去，不碰主检出的 `.local/`。
 */

const repo = mkdtempSync(path.join(tmpdir(), 'hs-r083-endpoint-'));
writeFileSync(path.join(repo, '.gitignore'), `.local/\n`);

const questionsDir = path.join(repo, 'HANDOFF', 'tasks');
execFileSync('mkdir', ['-p', questionsDir]);
writeFileSync(
  path.join(questionsDir, 'confirmations.json'),
  `${JSON.stringify(FIXTURE_QUESTIONS, null, 2)}\n`,
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
process.env.CONFIRMATIONS_REPO_ROOT = repo;

afterAll(() => {
  delete process.env.CONFIRMATIONS_REPO_ROOT;
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

const stateFile = path.join(repo, '.local', 'confirmations', 'state.json');
const readState = () => JSON.parse(readFileSync(stateFile, 'utf8')) as {
  answers: readonly { id: string; answer: string }[];
};
const gitStatus = () =>
  execFileSync('git', ['-C', repo, 'status', '--porcelain'], {
    encoding: 'utf8',
  });

describe('待确认事项端点（开发环境，开关打开）', () => {
  const test = createAppTest({
    createServer: createStandaloneServer,
    scope: 'test',
    server: { env: { NODE_ENV: 'development' } },
    config: { ...config, devTools: { accountSwitcher: { enabled: true } } },
  });

  test('单选传清单外的值 400，填空超长也 400', async ({ testApp }) => {
    const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
    const invalid = await admin.fetch(
      '/dev/confirmations/QA-01/answers',
      json({ answer: '清单外的值' }),
    );
    expect(invalid.status).toBe(400);
    const body = (await invalid.json()) as {
      error?: { reason?: string };
    };
    expect(body.error?.reason).toBe('NOT_IN_OPTIONS');

    const tooLong = await admin.fetch(
      '/dev/confirmations/QA-02/answers',
      json({ answer: '好'.repeat(2001) }),
    );
    expect(tooLong.status).toBe(400);
  }, 60_000);

  test('提交后状态文件多一条，临时仓库根 git status 不变', async ({
    testApp,
  }) => {
    let before = 0;
    try {
      before = readState().answers.length;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
    const response = await admin.fetch(
      '/dev/confirmations/QA-01/answers',
      json({ answer: '对象存储', note: '改主意' }),
    );
    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      data: {
        counts: { pending: number; answered: number };
        questions: readonly { id: string; group: string; latestAnswer: { answer: string } | null }[];
      };
    };
    expect(body.data.counts.answered).toBeGreaterThan(0);
    expect(
      body.data.questions.find((item) => item.id === 'QA-01')?.latestAnswer?.answer,
    ).toBe('对象存储');
    expect(readState().answers).toHaveLength(before + 1);
    expect(gitStatus()).toBe('');
  }, 60_000);

  // 放在管理员用例之后：切换身份会签退当前会话，别让它影响上面的管理员请求。
  test('非管理员 403，响应体没有任何问题文本', async ({ testApp }) => {
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

    const response = await testApp.request('/dev/confirmations', {
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
    expect(text).not.toContain(FIXTURE_QUESTION_TEXT);
    expect(text).not.toContain('本地盘');
    expect(text).not.toContain('对象存储');
  }, 60_000);
});

describe('待确认事项端点（开发工具关着）', () => {
  const test = createAppTest({
    createServer: createStandaloneServer,
    scope: 'test',
    config,
  });

  test('非开发环境端点不存在', async ({ testApp }) => {
    const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
    expect((await admin.fetch('/dev/confirmations')).status).toBe(404);
    expect(
      (
        await admin.fetch('/dev/confirmations/QA-01/answers', json({ answer: '本地盘' }))
      ).status,
    ).toBe(404);
  }, 60_000);
});
