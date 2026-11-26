// @vitest-environment node
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { DEFAULT_ADMIN_CREDENTIALS, signIn, type TestSession } from '@nocobase/app-plugin-authentication/testing';
import { authorizationToken } from '@nocobase/app-plugin-authorization';
import { defineFileRepositoryApiRoutes } from '@nocobase/app-plugin-file/server';
import type { Application } from '@nocobase/app-server/application';
import { driveManagerToken } from '@nocobase/app-server/drive';
import {
  createStandaloneServer as createCoreStandaloneServer,
  type StandaloneServerOptions,
} from '@nocobase/app-server/node';
import {
  resolveAppRuntime,
  startApplicationInScope,
  type AppScope,
} from '@nocobase/app-server/runtime';
import type { DatabaseConnection } from '@nocobase/db';
import type { TestApp } from '@nocobase/app-testing/server';
import { expect, vi } from 'vitest';

import { createAppTest, createTestApp } from '../helpers/test-app.js';
import { createApp } from '../../server/app.js';
import appRuntime from '../../server/runtime.js';
import { createStandaloneServer } from '../../server/standalone.js';

/**
 * R-026 第四片：附件的上传、取内容与「没有公开内容路由」的反向断言。
 *
 * 只在真 Postgres 上跑（用户裁决：SQLite 线丢弃）。断言照验收 27–31 写：
 * 每条都经真实 HTTP 端点；公开路由那条带对照 —— 先证明探针探得出公开路由，
 * 再断言反馈附件没有公开地址。
 */
const PASSWORD = 'R026-files-test-123!';
const BASE_CONFIG = {
  app: { publicOrigin: 'http://localhost' },
  auth: { secret: 'test-auth-secret-at-least-32-characters' },
};
const APP_ROOT = path.resolve(import.meta.dirname, '../..');
const LIMIT = 10 * 1024 * 1024;

const test = createAppTest({ createServer: createStandaloneServer, config: BASE_CONFIG });

// 对照用的临时应用：只有这一个应用登记了插件自己的公开内容路由。探针用的是
// knowledge 插件的 kbFiles 表（九列齐全），不碰反馈附件表。
const publicProbeRoutes = defineFileRepositoryApiRoutes({
  repositories: [
    {
      name: 'attachments',
      collection: 'kbFiles',
      connection: 'main',
      disk: 'local',
      accessPath: '/uploads/attachments',
      storagePrefix: 'objects',
      policy: {
        read: false,
        create: {
          scope: true,
          defaults: { uploaderKind: 'user', uploaderId: 'r026s4-probe' },
        },
        update: false,
        delete: false,
      },
      actions: { uploadOne: {} },
    },
  ],
});
const probeRuntime = {
  ...appRuntime,
  routes: [...appRuntime.routes, ...publicProbeRoutes],
};
const createProbeServer = (options: StandaloneServerOptions) =>
  createCoreStandaloneServer({
    configPath: options.configPath,
    rootDir: APP_ROOT,
    appRuntime: probeRuntime,
    createServer: async (scope: AppScope) => {
      const runtime = await resolveAppRuntime(probeRuntime, scope);
      const app = createApp(runtime);
      return startApplicationInScope(scope, app);
    },
    ...options,
  });
interface ApiErrorBody {
  error: { status: string; reason: string; domain: string; message: string };
}

const jsonHeaders = () => ({
  'content-type': 'application/json',
  origin: 'http://localhost',
});
const operationKey = () => `${Date.now()}.${randomUUID()}`;

const expectJson = async (response: Response, status: number): Promise<unknown> => {
  const text = await response.text();
  expect(response.status, `响应：${text}`).toBe(status);
  return JSON.parse(text) as unknown;
};

const expectError = async (
  response: Response,
  status: number,
  reason: string,
): Promise<void> => {
  const body = (await expectJson(response, status)) as ApiErrorBody;
  expect(body.error.reason, `原因码应为 ${reason}`).toBe(reason);
};

const createUser = async (
  admin: TestSession,
  name: string,
  roleScopes: Record<string, string[]>,
): Promise<{ id: string }> => {
  const response = await admin.fetch('/users', {
    method: 'POST',
    headers: { ...jsonHeaders(), 'Idempotency-Key': operationKey() },
    body: JSON.stringify({
      name,
      username: name.replace(/-/gu, ''),
      email: `${name.replace(/-/gu, '')}@example.test`,
      password: PASSWORD,
      roleScopes,
    }),
  });
  const text = await response.text();
  expect(response.status, `建用户失败：${text}`).toBe(201);
  return (JSON.parse(text) as { data: { id: string } }).data;
};

const signInAs = (app: TestApp, name: string) =>
  signIn(app, { username: name.replace(/-/gu, ''), password: PASSWORD });

/** 建人初始化器会给每个「人」补 staff；这里显式收回，造一个没有 submit 的账号。 */
const revokeStaff = async (app: Application, userId: string): Promise<void> => {
  const authz = app.container.resolve(authorizationToken);
  const assignments = await authz.permissionSets.listAssignments('staff');
  const mine = assignments.find(
    (item) => item.subject.type === 'user' && item.subject.id === userId,
  );
  expect(mine, 'staff 基线指派应当存在').toBeDefined();
  await authz.permissionSets.revoke(String(mine!.id));
};

const postFeedback = (
  session: TestSession,
  body: Record<string, unknown>,
) =>
  session.fetch('/quality/feedbacks', {
    method: 'POST',
    headers: { ...jsonHeaders(), 'Idempotency-Key': operationKey() },
    body: JSON.stringify(body),
  });

/** 一次上传：恰好一个 multipart 字段 `file`；不声明 content-type，让 fetch 带 boundary。 */
const upload = (
  session: TestSession,
  bytes: Uint8Array,
  filename: string,
  type: string,
  extra: Record<string, string> = {},
) => {
  const form = new FormData();
  form.append('file', new File([bytes], filename, { type }));
  for (const [key, value] of Object.entries(extra)) {
    form.append(key, value);
  }
  return session.fetch('/quality/feedback-files', {
    method: 'POST',
    headers: { origin: 'http://localhost' },
    body: form,
  });
};

/**
 * 小文件 + 一大段无关字段：文件本身合法，只有整包大小超限。
 * 这样去掉解析期硬闸就会 201（解析后按 file.size 的判据拦不住），变异才真红。
 */
const paddedForm = () => {
  const form = new FormData();
  form.append('file', new File([pngBytes], 'small.png', { type: 'image/png' }));
  form.append('padding', new Blob([new Uint8Array(LIMIT + 2 * 1024 * 1024)]), 'pad.bin');
  return form;
};

/** 流式请求体：undici 不会替它计算 Content-Length。 */
const streamedPaddedBody = () => {
  const boundary = '----r026s4nolength';
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="small.png"\r\nContent-Type: image/png\r\n\r\n`,
  );
  const paddingHead = Buffer.from(
    `\r\n--${boundary}\r\nContent-Disposition: form-data; name="padding"; filename="pad.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  const bytes = Buffer.concat([
    head,
    Buffer.from(pngBytes),
    paddingHead,
    Buffer.from(new Uint8Array(LIMIT + 2 * 1024 * 1024)),
    tail,
  ]);
  return {
    boundary,
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
  };
};

const content = (session: TestSession, url: string) =>
  session.fetch(url, { headers: jsonHeaders() });

const fileOf = async (connection: DatabaseConnection, id: string) =>
  connection.repository('fqcFeedbackFiles').findOne({ filter: { id } }) as Promise<
    Record<string, unknown> | undefined
  >;

const pngBytes = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0x03, 0xff,
]);

const rootUrl = (app: TestApp, p: string) => {
  const base = app.publicBasePath.replace(/\/$/u, '');
  return `http://localhost${base}${p}`;
};

test('R-026 27: 上传 PNG 落库、九列齐、ownerId 为上传者、前缀私有且不回地址', async ({
  app,
  testApp,
  connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const user = await createUser(admin, 'r026s4-upload-ok', { app: ['staff'] });
  const session = await signInAs(testApp, 'r026s4-upload-ok');
  expect(app.container.resolve(authorizationToken)).toBeDefined();

  const response = await upload(session, pngBytes, '尺寸.png', 'image/png');
  const body = (await expectJson(response, 201)) as {
    data: { id: string; filename: string; mimeType: string; size: number };
  };
  expect(body.data.id).toEqual(expect.any(String));
  expect(body.data.filename).toBe('尺寸.png');
  expect(body.data.mimeType).toBe('image/png');
  expect(body.data.size).toBe(pngBytes.byteLength);
  // 上传只回标识、文件名、类型、大小；不回地址（反向断言）。
  expect(body.data).not.toHaveProperty('url');
  expect(body.data).not.toHaveProperty('contentUrl');
  expect(body.data).not.toHaveProperty('key');

  const row = await fileOf(connection, body.data.id);
  expect(row).toMatchObject({
    ownerId: user.id,
    feedbackId: null,
    disk: 'local',
    ext: 'png',
    mimeType: 'image/png',
    filename: '尺寸.png',
    size: pngBytes.byteLength,
  });
  expect(String(row?.key)).toMatch(/^fqc-feedback\/[0-9a-f-]+\.png$/u);
  for (const column of ['id', 'disk', 'key', 'filename', 'ext', 'mimeType', 'size', 'createdAt', 'updatedAt']) {
    expect(row, `九列里的 ${column}`).toHaveProperty(column);
  }
});

test('R-026 未绑定：没有任何取内容的端点，连上传者本人也取不到', async ({
  testApp,
  connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const owner = await createUser(admin, 'r026s4-unbound-owner', { app: ['staff'] });
  expect(owner.id).toEqual(expect.any(String));
  const qa = await createUser(admin, 'r026s4-unbound-qa', {
    app: ['quality_inspector'],
  });
  expect(qa.id).toEqual(expect.any(String));
  const stranger = await createUser(admin, 'r026s4-unbound-stranger', {
    app: ['staff'],
  });
  expect(stranger.id).toEqual(expect.any(String));
  const ownerSession = await signInAs(testApp, 'r026s4-unbound-owner');
  const qaSession = await signInAs(testApp, 'r026s4-unbound-qa');
  const strangerSession = await signInAs(testApp, 'r026s4-unbound-stranger');

  const uploaded = (await expectJson(
    await upload(ownerSession, pngBytes, 'unbound.png', 'image/png'),
    201,
  )) as { data: { id: string } };
  const feedback = (await expectJson(
    await postFeedback(ownerSession, { content: '还没挂附件' }),
    201,
  )) as { data: { id: string } };
  expect((await fileOf(connection, uploaded.data.id))?.feedbackId).toBeNull();

  const mineUrl = `/quality/feedbacks/mine/${feedback.data.id}/attachments/${uploaded.data.id}`;
  const maintainUrl = `/quality/feedbacks/${feedback.data.id}/attachments/${uploaded.data.id}`;
  // 上传者本人：文件没挂在这张单上，404。
  await expectError(await content(ownerSession, mineUrl), 404, 'ATTACHMENT_NOT_FOUND');
  // 持 maintain 的质量角色也取不到。
  await expectError(await content(qaSession, maintainUrl), 404, 'ATTACHMENT_NOT_FOUND');
  // 无关的人经两个端点都取不到（mine 是本人范围外，maintain 是 403）。
  await expectError(await content(strangerSession, mineUrl), 404, 'ATTACHMENT_NOT_FOUND');
  expect((await content(strangerSession, maintainUrl)).status).toBe(403);
  // 随便编一个单号也一样是 404，不给未绑定文件留探测口。
  await expectError(
    await content(
      ownerSession,
      `/quality/feedbacks/mine/${randomUUID()}/attachments/${uploaded.data.id}`,
    ),
    404,
    'ATTACHMENT_NOT_FOUND',
  );
  // 取不到不等于被偷偷挂上：文件行仍然没挂任何单。
  expect((await fileOf(connection, uploaded.data.id))?.feedbackId).toBeNull();
});

test('R-026 28a: 没有 submit 的人上传 403；坏掉的请求体也先 403 再 400', async ({
  app,
  testApp,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const user = await createUser(admin, 'r026s4-no-submit', { app: [] });
  await revokeStaff(app, user.id);
  const session = await signInAs(testApp, 'r026s4-no-submit');

  const response = await upload(session, pngBytes, 'x.png', 'image/png');
  await expectError(response, 403, 'AUTHORIZATION_DENIED');

  const broken = await session.fetch('/quality/feedback-files', {
    method: 'POST',
    headers: { ...jsonHeaders(), 'content-type': 'application/json' },
    body: '{not json',
  });
  await expectError(broken, 403, 'AUTHORIZATION_DENIED');
});

test('R-026 28b: 类型清单按声明与扩展名判；声明与扩展名不符也 415', async ({
  testApp,
  connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const user = await createUser(admin, 'r026s4-types', { app: ['staff'] });
  expect(user.id).toEqual(expect.any(String));
  const session = await signInAs(testApp, 'r026s4-types');
  const before = await connection.repository('fqcFeedbackFiles').count();

  for (const [filename, type] of [
    ['icon.svg', 'image/svg+xml'],
    ['run.exe', 'application/octet-stream'],
    ['photo.heic', 'image/heic'],
    ['evil.png', 'image/jpeg'],
    ['photo.png', 'text/plain'],
  ]) {
    await expectError(
      await upload(session, pngBytes, filename, type),
      415,
      'FILE_TYPE_NOT_ALLOWED',
    );
  }
  // 请求体里另塞一个「声明类型」也不能改判：类型只认上传文件的声明与扩展名。
  await expectError(
    await upload(session, pngBytes, 'run.exe', 'application/octet-stream', {
      mimeType: 'image/png',
      type: 'image/png',
    }),
    415,
    'FILE_TYPE_NOT_ALLOWED',
  );
  expect(await connection.repository('fqcFeedbackFiles').count()).toBe(before);
});

test('R-026 28c: 超过 10 MiB 413，不写盘不写库', async ({ testApp, connection }) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const user = await createUser(admin, 'r026s4-size', { app: ['staff'] });
  expect(user.id).toEqual(expect.any(String));
  const session = await signInAs(testApp, 'r026s4-size');
  const before = await connection.repository('fqcFeedbackFiles').count();

  const oversized = new Uint8Array(LIMIT + 1);
  await expectError(
    await upload(session, oversized, 'big.png', 'image/png'),
    413,
    'FILE_TOO_LARGE',
  );
  expect(await connection.repository('fqcFeedbackFiles').count()).toBe(before);
});

test('R-026 28c+: 谎报 Content-Length 也在解析期被 bodyLimit 拦下，不写盘不写库', async ({
  app,
  testApp,
  connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const user = await createUser(admin, 'r026s4-lying-length', { app: ['staff'] });
  expect(user.id).toEqual(expect.any(String));
  const session = await signInAs(testApp, 'r026s4-lying-length');
  const before = await connection.repository('fqcFeedbackFiles').count();
  const disk = app.container.resolve(driveManagerToken).use('local');
  const putStream = vi.spyOn(disk, 'putStream');
  try {
    const response = await session.fetch('/quality/feedback-files', {
      method: 'POST',
      // 谎报成 100 字节，实际请求体超过 10 MiB。
      headers: { origin: 'http://localhost', 'content-length': '100' },
      body: paddedForm(),
    });
    await expectError(response, 413, 'FILE_TOO_LARGE');
    expect(await connection.repository('fqcFeedbackFiles').count()).toBe(before);
    expect(putStream).not.toHaveBeenCalled();
  } finally {
    putStream.mockRestore();
  }
});

test('R-026 28c+: 没有 Content-Length（流式）也在解析期被 bodyLimit 拦下，不写盘不写库', async ({
  app,
  testApp,
  connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const user = await createUser(admin, 'r026s4-no-length', { app: ['staff'] });
  expect(user.id).toEqual(expect.any(String));
  const session = await signInAs(testApp, 'r026s4-no-length');
  const before = await connection.repository('fqcFeedbackFiles').count();
  const disk = app.container.resolve(driveManagerToken).use('local');
  const putStream = vi.spyOn(disk, 'putStream');
  try {
    const { boundary, body } = streamedPaddedBody();
    const response = await session.fetch('/quality/feedback-files', {
      method: 'POST',
      headers: {
        origin: 'http://localhost',
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      body,
      duplex: 'half',
    } as RequestInit);
    await expectError(response, 413, 'FILE_TOO_LARGE');
    expect(await connection.repository('fqcFeedbackFiles').count()).toBe(before);
    expect(putStream).not.toHaveBeenCalled();
  } finally {
    putStream.mockRestore();
  }
});

test('R-026 28 错误码：FILE_REQUIRED / UNSUPPORTED_MEDIA_TYPE / INVALID_MULTIPART', async ({
  testApp,
  connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const user = await createUser(admin, 'r026s4-error-codes', { app: ['staff'] });
  expect(user.id).toEqual(expect.any(String));
  const session = await signInAs(testApp, 'r026s4-error-codes');
  const before = await connection.repository('fqcFeedbackFiles').count();

  const noFile = new FormData();
  noFile.append('note', 'x');
  await expectError(
    await session.fetch('/quality/feedback-files', {
      method: 'POST',
      headers: { origin: 'http://localhost' },
      body: noFile,
    }),
    400,
    'FILE_REQUIRED',
  );
  const twoFiles = new FormData();
  twoFiles.append('file', new File([pngBytes], 'a.png', { type: 'image/png' }));
  twoFiles.append('file', new File([pngBytes], 'b.png', { type: 'image/png' }));
  await expectError(
    await session.fetch('/quality/feedback-files', {
      method: 'POST',
      headers: { origin: 'http://localhost' },
      body: twoFiles,
    }),
    400,
    'FILE_REQUIRED',
  );
  await expectError(
    await session.fetch('/quality/feedback-files', {
      method: 'POST',
      headers: jsonHeaders(),
      body: '{}',
    }),
    415,
    'UNSUPPORTED_MEDIA_TYPE',
  );
  await expectError(
    await session.fetch('/quality/feedback-files', {
      method: 'POST',
      headers: {
        origin: 'http://localhost',
        'content-type': 'multipart/form-data; boundary=broken',
      },
      body: '--broken\r\nContent-Disposition: form-data; name="file"; filename="x.png"\r\nContent-Type: image/png\r\n\r\nnot-closed',
    }),
    400,
    'INVALID_MULTIPART',
  );
  expect(await connection.repository('fqcFeedbackFiles').count()).toBe(before);
});

test('R-026 29: 绑定后本人与质量角色可取，响应头安全且字节逐字节一致', async ({
  testApp,
  connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const submitter = await createUser(admin, 'r026s4-bound-owner', { app: ['staff'] });
  expect(submitter.id).toEqual(expect.any(String));
  const inspector = await createUser(admin, 'r026s4-bound-qa', {
    app: ['quality_inspector'],
  });
  expect(inspector.id).toEqual(expect.any(String));
  const stranger = await createUser(admin, 'r026s4-bound-stranger', { app: ['staff'] });
  expect(stranger.id).toEqual(expect.any(String));
  const owner = await signInAs(testApp, 'r026s4-bound-owner');
  const qa = await signInAs(testApp, 'r026s4-bound-qa');
  const other = await signInAs(testApp, 'r026s4-bound-stranger');

  // 文件名带中文、引号、括号与星号：存储层先清洗，响应头再做安全编码。
  const name = '样本(尺寸)*\'x.png';
  const uploaded = (await expectJson(
    await upload(owner, pngBytes, name, 'image/png'),
    201,
  )) as { data: { id: string } };
  const submitted = (await expectJson(
    await postFeedback(owner, {
      content: '带附件的单',
      attachmentIds: [uploaded.data.id],
    }),
    201,
  )) as { data: { id: string } };
  expect((await fileOf(connection, uploaded.data.id))?.feedbackId).toBe(submitted.data.id);

  const mineUrl = `/quality/feedbacks/mine/${submitted.data.id}/attachments/${uploaded.data.id}`;
  const maintainUrl = `/quality/feedbacks/${submitted.data.id}/attachments/${uploaded.data.id}`;

  const mine = await content(owner, mineUrl);
  expect(mine.status).toBe(200);
  expect(mine.headers.get('content-type')).toBe('image/png');
  expect(mine.headers.get('x-content-type-options')).toBe('nosniff');
  expect(mine.headers.get('content-security-policy')).toBe("sandbox; default-src 'none'");
  expect(mine.headers.get('cache-control')).toBe('private, no-store');
  expect(mine.headers.get('content-length')).toBe(String(pngBytes.byteLength));
  expect(new Uint8Array(await mine.arrayBuffer())).toEqual(pngBytes);
  const disposition = mine.headers.get('content-disposition') ?? '';
  expect(disposition).toMatch(/^attachment; filename\*=UTF-8''[A-Za-z0-9%._~-]+$/u);
  expect(decodeURIComponent(disposition.slice("attachment; filename*=UTF-8''".length))).toContain('样本');
  expect(decodeURIComponent(disposition.slice("attachment; filename*=UTF-8''".length))).not.toMatch(/[\r\n/\\]/u);

  const maintained = await content(qa, maintainUrl);
  expect(maintained.status).toBe(200);
  expect(new Uint8Array(await maintained.arrayBuffer())).toEqual(pngBytes);

  // 没登录 401。
  const anonymous = await testApp.request(mineUrl, { headers: jsonHeaders() });
  expect(anonymous.status).toBe(401);
  // 别人（只持 submit）与自己无关的单：本人范围里查不到，与不存在同形。
  expect((await content(other, mineUrl)).status).toBe(404);
  // 只持 submit 的人不能走维护端点。
  expect((await content(other, maintainUrl)).status).toBe(403);

  // 文件不在这张单上：404。先用同一个人的另一张单做对照。
  const second = (await expectJson(
    await postFeedback(owner, { content: '第二张单' }),
    201,
  )) as { data: { id: string } };
  expect(
    (
      await content(
        owner,
        `/quality/feedbacks/mine/${second.data.id}/attachments/${uploaded.data.id}`,
      )
    ).status,
  ).toBe(404);
  expect(
    (
      await content(
        qa,
        `/quality/feedbacks/${second.data.id}/attachments/${uploaded.data.id}`,
      )
    ).status,
  ).toBe(404);

  // 路径分隔符与控制字符不会出现在响应头的文件名里：存储层先按最后一段取名，
  // 取内容时再用 RFC 5987 编码，解码后也不带分隔符或换行。
  const traversal = (await expectJson(
    await upload(owner, pngBytes, '..\\..\\坏\r\n样本.png', 'image/png'),
    201,
  )) as { data: { id: string; filename: string } };
  expect(traversal.data.filename).not.toMatch(/[\r\n/\\]/u);
  const traversalSheet = (await expectJson(
    await postFeedback(owner, {
      content: '路径分隔符文件名',
      attachmentIds: [traversal.data.id],
    }),
    201,
  )) as { data: { id: string } };
  const traversalRead = await content(
    owner,
    `/quality/feedbacks/mine/${traversalSheet.data.id}/attachments/${traversal.data.id}`,
  );
  expect(traversalRead.status).toBe(200);
  const safeName = decodeURIComponent(
    (traversalRead.headers.get('content-disposition') ?? '').slice(
      "attachment; filename*=UTF-8''".length,
    ),
  );
  expect(safeName).not.toMatch(/[\r\n/\\]|\.\./u);
});

test('R-026 30: 反向断言带对照——探针探得出公开路由，反馈附件按公开地址形态取不到', async () => {
  // 只有这一条测试自己起一个带插件公开路由的应用；对照与断言在同一个测试里。
  const testApp = await createTestApp({
    createServer: createProbeServer,
    config: BASE_CONFIG,
  });
  try {
  // 前半句：插件自己登记的公开内容路由确实能被不登录的探针读到。
  const probe = await testApp.request('/attachments/uploadOne', {
    method: 'POST',
    body: (() => {
      const form = new FormData();
      form.append('file', new File([pngBytes], 'probe.png', { type: 'image/png' }));
      return form;
    })(),
  });
  const probeBody = (await expectJson(probe, 201)) as {
    data: { record: { id: string; ext: string } };
  };
  const probeUrl = rootUrl(
    testApp,
    `/uploads/attachments/${probeBody.data.record.id}.${probeBody.data.record.ext}`,
  );
  const probeRead = await testApp.fetch(new Request(probeUrl));
  expect(probeRead.status, '对照必须真的探得出公开路由').toBe(200);
  expect(new Uint8Array(await probeRead.arrayBuffer())).toEqual(pngBytes);

  // 后半句：反馈附件不登记任何公开路由。上传走本片端点，按插件默认的地址形态
  // 以及本应用的私有前缀形态不登录去取，都是 404。
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const user = await createUser(admin, 'r026s4-no-public', { app: ['staff'] });
  expect(user.id).toEqual(expect.any(String));
  const session = await signInAs(testApp, 'r026s4-no-public');
  const uploaded = (await expectJson(
    await upload(session, pngBytes, 'private.png', 'image/png'),
    201,
  )) as { data: { id: string } };

  const pluginPath = `/uploads/attachments/${uploaded.data.id}.png`;
  expect(
    (
      await testApp.fetch(new Request(rootUrl(testApp, pluginPath)))
    ).status,
    '插件默认的公开地址形态必须正好是 404',
  ).toBe(404);
  const denied = await testApp.fetch(
    new Request(rootUrl(testApp, `/api/quality/feedback-files/${uploaded.data.id}`)),
  );
  expect([401, 403, 404]).toContain(denied.status);
  expect(new Uint8Array(await denied.arrayBuffer())).not.toEqual(pngBytes);
  // 私有前缀形态落到 SPA 兜底（测试副本没有构建产物时是 500）：关键是取不到文件字节。
  const privatePrefix = await testApp.fetch(
    new Request(rootUrl(testApp, `/uploads/fqc-feedback/${uploaded.data.id}.png`)),
  );
  expect(privatePrefix.status).toBeGreaterThanOrEqual(400);
  expect(new Uint8Array(await privatePrefix.arrayBuffer())).not.toEqual(pngBytes);
  // 端点之外也没有「凭 id 就能取」的路径：这条路由不存在，落到反馈附件的鉴权中间件，
  // 不登录至少被拒（401/403/404），且取不到文件字节。
  const guessed = await testApp.request(
    `/quality/feedback-files/${uploaded.data.id}/content`,
    { headers: jsonHeaders() },
  );
  expect([401, 403, 404]).toContain(guessed.status);
  expect(new Uint8Array(await guessed.arrayBuffer())).not.toEqual(pngBytes);
  } finally {
    await testApp.close();
  }
});

test('R-026 422 对接：上传得到的标识可绑定，重复占用仍回 422', async ({
  testApp,
  connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const owner = await createUser(admin, 'r026s4-bind-owner', { app: ['staff'] });
  expect(owner.id).toEqual(expect.any(String));
  const other = await createUser(admin, 'r026s4-bind-other', { app: ['staff'] });
  expect(other.id).toEqual(expect.any(String));
  const ownerSession = await signInAs(testApp, 'r026s4-bind-owner');
  const otherSession = await signInAs(testApp, 'r026s4-bind-other');
  const mine = (await expectJson(
    await upload(ownerSession, pngBytes, 'bind.png', 'image/png'),
    201,
  )) as { data: { id: string } };
  const foreign = (await expectJson(
    await upload(otherSession, pngBytes, 'foreign.png', 'image/png'),
    201,
  )) as { data: { id: string } };

  await expectError(
    await postFeedback(ownerSession, {
      content: '别人的附件',
      attachmentIds: [foreign.data.id],
    }),
    422,
    'ATTACHMENT_NOT_AVAILABLE',
  );
  const ok = (await expectJson(
    await postFeedback(ownerSession, {
      content: '自己的附件',
      attachmentIds: [mine.data.id],
    }),
    201,
  )) as { data: { id: string; attachmentIds: string[] } };
  expect(ok.data.attachmentIds).toEqual([mine.data.id]);
  expect((await fileOf(connection, mine.data.id))?.feedbackId).toBe(ok.data.id);
  await expectError(
    await postFeedback(ownerSession, {
      content: '再用一次',
      attachmentIds: [mine.data.id],
    }),
    422,
    'ATTACHMENT_NOT_AVAILABLE',
  );
});
