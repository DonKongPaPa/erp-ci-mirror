// @vitest-environment node
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { userAdministrationServiceToken } from '@nocobase/app-plugin-authentication';
import {
  DEFAULT_ADMIN_CREDENTIALS,
  signIn,
  type SignInTarget,
  type TestSession,
} from '@nocobase/app-plugin-authentication/testing';
import { authorizationToken } from '@nocobase/app-plugin-authorization';
import { scopedApiKeysToken } from '@nocobase/app-plugin-api-keys/server';
import type { Application } from '@nocobase/app-server/application';
import {
  createStandaloneServer as createCoreStandaloneServer,
  type StandaloneServerOptions,
} from '@nocobase/app-server/node';
import {
  resolveAppRuntime,
  startApplicationInScope,
  type AppScope,
} from '@nocobase/app-server/runtime';
import type { TestApp } from '@nocobase/app-testing/server';
import type { DatabaseConnection } from '@nocobase/db';
import { expect } from 'vitest';

import { createAppTest } from '../helpers/test-app.js';
import { createApp } from '../../server/app.js';
import {
  qualityModelGatewayToken,
  type QualityModelGateway,
  type QualityModelGatewayRequest,
  type QualityModelGatewayResult,
} from '../../server/providers/quality-model-gateway.js';
import appRuntime from '../../server/runtime.js';
import { createStandaloneServer } from '../../server/standalone.js';
import {
  feedbackExternalId,
  feedbackUniqueError,
  ingestFeedback,
} from '../../server/routes/quality.js';
import {
  qualityDraftingToken,
  upgradeScreeningDraft,
} from '../../server/providers/quality-drafting.js';
import { IngestResultSchema } from '../../server/routes/schemas.js';

/**
 * R-026 第三片：录入端点、共用录入函数与按列授权在端点上的真实行为。
 *
 * 断言照验收 1–11、13–16、19–22 写。每条都经真实的 HTTP 端点与真实数据库；
 * 仓储层的声明在 feedback-authorization.test.ts 里另有钉住。
 */
const PASSWORD = 'R026-form-test-123!';
const BASE_CONFIG = {
  app: { publicOrigin: 'http://localhost' },
  auth: { secret: 'test-auth-secret-at-least-32-characters' },
};

interface FakeGateway extends QualityModelGateway {
  readonly calls: QualityModelGatewayRequest[];
  answer: (
    request: QualityModelGatewayRequest,
  ) => Promise<QualityModelGatewayResult>;
}

const fakeGateway: FakeGateway = {
  calls: [],
  answer: async () => ({
    text: JSON.stringify({
      category: 'dimension',
      severity: 'major',
      summary: '模型判定：尺寸超差',
      confidence: 0.86,
      evidence: ['尺寸'],
    }),
    model: 'fake-service/fake-model',
  }),
  async generate(request) {
    this.calls.push(request);
    return this.answer(request);
  },
};

const APP_ROOT = path.resolve(import.meta.dirname, '../..');
const createServerWithFakeGateway = (options: StandaloneServerOptions) =>
  createCoreStandaloneServer({
    configPath: options.configPath,
    rootDir: APP_ROOT,
    appRuntime,
    createServer: async (scope: AppScope) => {
      const runtime = await resolveAppRuntime(appRuntime, scope);
      const app = createApp(runtime);
      app.container.instance(qualityModelGatewayToken, fakeGateway);
      return startApplicationInScope(scope, app);
    },
    ...options,
  });

const test = createAppTest({ createServer: createStandaloneServer, config: BASE_CONFIG });
const modelTest = createAppTest({
  createServer: createServerWithFakeGateway,
  config: { ...BASE_CONFIG, quality: { drafting: { modelEnabled: true } } },
});

interface ApiErrorBody {
  error: { status: string; reason: string; domain: string; message: string };
}

interface FeedbackRow extends Record<string, unknown> {
  id: string;
  status: string;
  ownerId: string | null;
  channel: string;
  content: string;
}

interface FeedbackBody {
  data: FeedbackRow & {
    attachments?: unknown[];
    submitterName?: string | null;
    canEdit?: boolean;
    canDiscard?: boolean;
    note?: string | null;
    discardedBy?: string | null;
    screening?: Record<string, unknown>;
    ticket?: Record<string, unknown> | null;
  };
}

const operationKey = () => `${Date.now()}.${randomUUID()}`;
const jsonHeaders = (key?: string) => ({
  'content-type': 'application/json',
  origin: 'http://localhost',
  ...(key === undefined ? {} : { 'Idempotency-Key': key }),
});

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
  const response = await admin.fetch(
    '/users',
    {
      method: 'POST',
      headers: jsonHeaders(operationKey()),
      body: JSON.stringify({
        name,
        username: name.replace(/-/gu, ''),
        email: `${name.replace(/-/gu, '')}@example.test`,
        password: PASSWORD,
        roleScopes,
      }),
    },
  );
  const text = await response.text();
  expect(response.status, `建用户失败：${text}`).toBe(201);
  return (JSON.parse(text) as { data: { id: string } }).data;
};

const signInAs = (app: SignInTarget, name: string) =>
  signIn(app, { username: name.replace(/-/gu, ''), password: PASSWORD });

const postFeedback = (
  session: TestSession,
  body: Record<string, unknown>,
  key = operationKey(),
) =>
  session.fetch('/quality/feedbacks', {
    method: 'POST',
    headers: jsonHeaders(key),
    body: JSON.stringify(body),
  });

const getFeedbacks = (session: TestSession, query = '') =>
  session.fetch(`/quality/feedbacks${query}`, { headers: jsonHeaders() });

const getMine = (session: TestSession, query = '') =>
  session.fetch(`/quality/feedbacks/mine${query}`, { headers: jsonHeaders() });

const getOne = (session: TestSession, id: string) =>
  session.fetch(`/quality/feedbacks/${id}`, { headers: jsonHeaders() });

const patchOne = (session: TestSession, id: string, body: Record<string, unknown>) =>
  session.fetch(`/quality/feedbacks/${id}`, {
    method: 'PATCH',
    headers: jsonHeaders(),
    body: JSON.stringify(body),
  });

const discardOne = (session: TestSession, id: string, body: Record<string, unknown>) =>
  session.fetch(`/quality/feedbacks/${id}/discard`, {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify(body),
  });

const messageOf = async (
  connection: DatabaseConnection,
  id: string,
): Promise<Record<string, unknown> | undefined> =>
  connection.repository('fqcMessages').findOne({ filter: { id } }) as Promise<
    Record<string, unknown> | undefined
  >;

const screeningOf = async (
  connection: DatabaseConnection,
  messageId: string,
): Promise<Record<string, unknown> | undefined> =>
  connection.repository('fqcScreenings').findOne({ filter: { messageId } }) as Promise<
    Record<string, unknown> | undefined
  >;

const insertFile = async (
  connection: DatabaseConnection,
  ownerId: string | null,
  extras: Record<string, unknown> = {},
): Promise<string> => {
  const id = randomUUID();
  const now = new Date();
  await connection.repository('fqcFeedbackFiles').createOne({
    values: {
      id,
      disk: 'local',
      key: `fqc-feedback/${id}`,
      filename: 'photo.png',
      ext: 'png',
      mimeType: 'image/png',
      size: 1024,
      ownerId,
      feedbackId: null,
      createdAt: now,
      updatedAt: now,
      ...extras,
    },
  });
  return id;
};

const fileOf = async (connection: DatabaseConnection, id: string) =>
  connection.repository('fqcFeedbackFiles').findOne({ filter: { id } });

const intakeGrant = {
  resource: { type: 'composite', id: 'fqc' },
  actions: [
    {
      action: 'intake',
      policy: {
        type: 'composite',
        scopes: {
          fqcMessages: 'allRecords',
          fqcScreenings: 'allRecords',
          fqcTickets: 'allRecords',
        },
      },
    },
  ],
};

/** 一个持「投递」的服务账号；重放需要读初筛时再单独给「查看」。 */
const createIntakeAccount = async (
  app: Application,
  name: string,
  view = false,
): Promise<{ id: string; secret: string }> => {
  const authz = app.container.resolve(authorizationToken);
  const key = `r026s3-${name}`;
  await authz.permissionSets.create({
    key,
    grants: [
      intakeGrant,
      ...(view
        ? [
            {
              resource: { type: 'composite', id: 'fqc' },
              actions: [
                {
                  action: 'view',
                  policy: {
                    type: 'composite',
                    scopes: {
                      fqcMessages: 'allRecords',
                      fqcScreenings: 'allRecords',
                      fqcTickets: 'allRecords',
                      fqcScreeningReviews: 'allRecords',
                    },
                  },
                },
              ],
            },
          ]
        : []),
    ],
  });
  const users = app.container.resolve(userAdministrationServiceToken);
  const account = await users.createServiceAccount({ name });
  await authz.permissionSets.assign({
    subject: { type: 'user', id: account.id },
    permissionSet: key,
  });
  const keys = app.container.resolve(scopedApiKeysToken);
  const secret = (
    await keys.create(
      account.id,
      { name: `${name} key` },
      await keys.identityOf(account.id),
    )
  ).secret;
  return { id: account.id, secret };
};

const postIntake = (
  app: TestApp,
  secret: string,
  body: Record<string, unknown>,
  key = operationKey(),
) =>
  app.request('/quality/intake', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: 'http://localhost',
      'x-api-key': secret,
      'Idempotency-Key': key,
    },
    body: JSON.stringify(body),
  });

test('R-026 1: 普通员工提交 web 反馈，原文与草稿同事务落库，不建工单', async ({
  app,
  testApp,
  connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const user = await createUser(admin, 'r026s3-one', { app: ['staff'] });
  const session = await signInAs(testApp, 'r026s3-one');
  expect(app.container.resolve(authorizationToken)).toBeDefined();

  const response = await postFeedback(session, {
    channel: 'web',
    content: '尺寸超差：装配不上',
  });
  const body = (await expectJson(response, 201)) as FeedbackBody;
  expect(response.headers.get('Idempotency-Replayed')).toBe('false');
  const message = await messageOf(connection, body.data.id);
  expect(message).toMatchObject({
    ownerId: user.id,
    status: 'open',
    channel: 'web',
    content: '尺寸超差：装配不上',
    senderName: null,
    senderContact: null,
    externalId: null,
    rawContentType: 'text',
  });
  const screening = await screeningOf(connection, body.data.id);
  expect(screening).toMatchObject({
    messageId: body.data.id,
    ownerId: user.id,
    category: 'dimension',
    modelName: 'rule-baseline',
    engine: 'rules',
    degradeReason: 'model-disabled',
    reviewId: null,
  });
  expect(await connection.repository('fqcTickets').count({ filter: { sourceMessageId: body.data.id } })).toBe(0);
  // 201 由写入值拼，不带内部备注与谁丢弃的。
  expect(body.data).not.toHaveProperty('note');
  expect(body.data).not.toHaveProperty('discardedBy');
});

test('R-026 2: proxy 必填客户；web 带了发件人两列也不落库', async ({
  testApp,
  connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  await createUser(admin, 'r026s3-proxy', { app: ['staff'] });
  const session = await signInAs(testApp, 'r026s3-proxy');

  await expectError(
    await postFeedback(session, { channel: 'proxy', content: '电话反馈' }),
    400,
    'CUSTOMER_REQUIRED',
  );
  expect(
    await connection.repository('fqcMessages').count({ filter: { content: '电话反馈' } }),
  ).toBe(0);

  const ok = (await expectJson(
    await postFeedback(session, {
      channel: 'proxy',
      customerName: '客户甲',
      senderName: '张三',
      senderContact: '联系人甲',
      content: '电话反馈',
    }),
    201,
  )) as FeedbackBody;
  expect(
    await messageOf(connection, ok.data.id),
  ).toMatchObject({ customerName: '客户甲', senderName: '张三', senderContact: '联系人甲' });

  const web = (await expectJson(
    await postFeedback(session, {
      channel: 'web',
      senderName: '不该落库',
      senderContact: '不该落库',
      content: '网页反馈',
    }),
    201,
  )) as FeedbackBody;
  expect(await messageOf(connection, web.data.id)).toMatchObject({
    senderName: null,
    senderContact: null,
  });
});

test('R-026 3: 请求体里的 ownerId 等列一律不认，借 ownerId 绕不开仅本人', async ({
  testApp,
  connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const caller = await createUser(admin, 'r026s3-owner', { app: ['staff'] });
  const other = await createUser(admin, 'r026s3-other', { app: ['staff'] });
  const session = await signInAs(testApp, 'r026s3-owner');
  const otherSession = await signInAs(testApp, 'r026s3-other');

  const body = (await expectJson(
    await postFeedback(session, {
      channel: 'web',
      content: '塞了别人的 ownerId',
      ownerId: other.id,
      status: 'discarded',
      discardedBy: other.id,
      externalId: 'body-external',
      note: '不该落库',
    }),
    201,
  )) as FeedbackBody;

  const message = await messageOf(connection, body.data.id);
  expect(message?.ownerId, 'ownerId 必须服务端按会话写').toBe(caller.id);
  expect(message).toMatchObject({
    status: 'open',
    discardedBy: null,
    discardedAt: null,
    discardReason: null,
    externalId: null,
    note: null,
  });
  expect((await screeningOf(connection, body.data.id))?.ownerId).toBe(caller.id);

  const mine = (await expectJson(await getMine(session), 200)) as {
    data: FeedbackRow[];
  };
  expect(mine.data.map((row) => row.id)).toContain(body.data.id);
  const otherMine = (await expectJson(await getMine(otherSession), 200)) as {
    data: FeedbackRow[];
  };
  expect(otherMine.data.map((row) => row.id)).not.toContain(body.data.id);
});

test('R-026 4: 幂等——同键同体重放回同一行，同键异体 409，缺键 400', async ({
  testApp,
  connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  await createUser(admin, 'r026s3-idem', { app: ['staff'] });
  const session = await signInAs(testApp, 'r026s3-idem');
  const key = operationKey();
  const body = { channel: 'web', content: '幂等正文' };

  const firstResponse = await postFeedback(session, body, key);
  expect(firstResponse.headers.get('Idempotency-Replayed')).toBe('false');
  const first = (await expectJson(firstResponse, 201)) as FeedbackBody;
  const replayResponse = await postFeedback(session, body, key);
  expect(replayResponse.headers.get('Idempotency-Replayed')).toBe('true');
  const replay = (await expectJson(replayResponse, 201)) as FeedbackBody;
  expect(replay.data.id).toBe(first.data.id);
  expect(
    await connection.repository('fqcMessages').count({ filter: { content: '幂等正文' } }),
  ).toBe(1);

  await expectError(
    await postFeedback(session, { ...body, content: '同键不同正文' }, key),
    409,
    'OPERATION_CONFLICT',
  );
  await expectError(await postFeedback(session, body, ''), 400, 'OPERATION_KEY_REQUIRED');
});

test('R-026 5: 描述长度与附件个数在 schema 层被拒', async ({ testApp }) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  await createUser(admin, 'r026s3-limit', { app: ['staff'] });
  const session = await signInAs(testApp, 'r026s3-limit');
  await expectError(await postFeedback(session, { content: '' }), 400, 'INVALID_INPUT');
  await expectError(await postFeedback(session, { content: 'x'.repeat(8001) }), 400, 'INVALID_INPUT');
  const result = await postFeedback(session, {
    content: '十个以上附件',
    attachmentIds: Array.from({ length: 11 }, () => randomUUID()),
  });
  const text = await result.text();
  expect(result.status).toBe(400);
  expect(JSON.parse(text)).toMatchObject({
    error: { reason: 'TOO_MANY_ATTACHMENTS' },
  });
});

test('R-026 6: 附件必须本人上传且没被占用；提交时挂到这张单上', async ({
  testApp,
  connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const caller = await createUser(admin, 'r026s3-file', { app: ['staff'] });
  const other = await createUser(admin, 'r026s3-file-other', { app: ['staff'] });
  const session = await signInAs(testApp, 'r026s3-file');
  const foreign = await insertFile(connection, other.id);
  await expectError(
    await postFeedback(session, { content: '别人的附件', attachmentIds: [foreign] }),
    422,
    'ATTACHMENT_NOT_AVAILABLE',
  );
  expect(
    await connection.repository('fqcMessages').count({ filter: { content: '别人的附件' } }),
  ).toBe(0);

  const occupied = await insertFile(connection, caller.id);
  const first = (await expectJson(
    await postFeedback(session, { content: '先占住附件', attachmentIds: [occupied] }),
    201,
  )) as FeedbackBody;
  await expectError(
    await postFeedback(session, { content: '再用一次', attachmentIds: [occupied] }),
    422,
    'ATTACHMENT_NOT_AVAILABLE',
  );
  expect((await fileOf(connection, occupied))?.feedbackId).toBe(first.data.id);

  const mine = await insertFile(connection, caller.id);
  const ok = (await expectJson(
    await postFeedback(session, { content: '自己的附件', attachmentIds: [mine] }),
    201,
  )) as FeedbackBody;
  expect(await messageOf(connection, ok.data.id)).toMatchObject({ attachmentIds: [mine] });
  expect((await fileOf(connection, mine))?.feedbackId).toBe(ok.data.id);
});

test('R-026 7: 唯一冲突回滚附件绑定，只把这一支冲突映射成 FEEDBACK_ALREADY_RECORDED', async ({
  app,
  testApp,
  connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  await createUser(admin, 'r026s3-rollback', { app: ['staff'] });
  const account = await createIntakeAccount(app, 'rollback', false);
  const file = await insertFile(connection, account.id);

  const first = await expectJson(
    await postIntake(testApp, account.secret, {
      channel: 'wechat',
      externalId: 'ext-once',
      content: '先投一次',
    }),
    201,
  );
  const duplicate = await postIntake(testApp, account.secret, {
    channel: 'wechat',
    externalId: 'ext-once',
    content: '再投一次',
    attachmentIds: [file],
  });
  const text = await duplicate.text();
  expect(duplicate.status).toBe(409);
  expect((JSON.parse(text) as ApiErrorBody).error.reason).toBe('FEEDBACK_ALREADY_RECORDED');
  expect(text).not.toContain('data');
  expect((await fileOf(connection, file))?.feedbackId).toBeNull();
  expect(
    await connection.repository('fqcMessages').count({ filter: { externalId: 'ext-once' } }),
  ).toBe(1);
  expect((first as { data: { message: { id: string } } }).data.message.id).toBeDefined();
});

test('R-026 8/9/11: 三个入口同形；投递写 open、提交人为空、空外部标识并存', async ({
  app,
  testApp,
  connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  await createUser(admin, 'r026s3-shape', { app: ['staff'] });
  const webSession = await signInAs(testApp, 'r026s3-shape');
  const account = await createIntakeAccount(app, 'shape', false);
  const content = '尺寸超差：同一段正文';

  const web = (await expectJson(
    await postFeedback(webSession, {
      channel: 'web',
      content,
      customerName: '客户甲',
      productName: '产品甲',
      model: '型号甲',
      batchNo: '批次甲',
    }),
    201,
  )) as FeedbackBody;
  const proxy = (await expectJson(
    await postFeedback(webSession, {
      channel: 'proxy',
      content,
      customerName: '客户甲',
      senderName: '张三',
      productName: '产品甲',
      model: '型号甲',
      batchNo: '批次甲',
    }),
    201,
  )) as FeedbackBody;
  const machine = (await expectJson(
    await postIntake(testApp, account.secret, {
      channel: 'wechat',
      content,
      customerName: '客户甲',
      productName: '产品甲',
      model: '型号甲',
      batchNo: '批次甲',
    }),
    201,
  )) as { data: { message: FeedbackRow } };

  // 验收 9：投递 201 的 message 带新表单列，且过得了声明的 OpenAPI 响应 schema。
  const parsed = IngestResultSchema.safeParse((machine as { data: unknown }).data);
  expect(parsed.success).toBe(true);
  // zod 默认剥掉多余键：只判 success 抓不到 schema 退回十一列，必须比解析后的键集。
  if (parsed.success) {
    expect(Object.keys(parsed.data.message).sort()).toEqual(
      Object.keys(machine.data.message).sort(),
    );
  }
  expect(Object.keys(machine.data.message).sort()).toEqual([
    'attachmentIds', 'batchNo', 'channel', 'content', 'createdAt', 'customerName',
    'externalId', 'id', 'model', 'productName', 'rawContentType', 'receivedAt',
    'senderContact', 'senderName', 'status', 'updatedAt',
  ].sort());
  expect(machine.data.message).toMatchObject({
    customerName: '客户甲', productName: '产品甲', model: '型号甲',
    batchNo: '批次甲', attachmentIds: [], status: 'open',
  });
  expect(machine.data.message).not.toHaveProperty('ownerId');

  const rows = await Promise.all([
    messageOf(connection, web.data.id),
    messageOf(connection, proxy.data.id),
    messageOf(connection, machine.data.message.id),
  ]);
  expect(rows[2]).toMatchObject({
    ownerId: null,
    status: 'open',
    customerName: '客户甲',
    productName: '产品甲',
    model: '型号甲',
    batchNo: '批次甲',
  });
  const comparable = (row: Record<string, unknown>) =>
    Object.fromEntries(
      Object.entries(row).filter(
        ([key]) =>
          !['id', 'channel', 'ownerId', 'externalId', 'senderName', 'senderContact', 'createdAt', 'updatedAt', 'receivedAt'].includes(key),
      ),
    );
  expect(comparable(rows[0]!)).toEqual(comparable(rows[1]!));
  expect(comparable(rows[0]!)).toEqual(comparable(rows[2]!));

  const drafts = await Promise.all(
    rows.map((row) => screeningOf(connection, String(row!.id))),
  );
  const comparableDraft = (row: Record<string, unknown>) =>
    Object.fromEntries(
      Object.entries(row).filter(([key]) => !['id', 'messageId', 'ownerId', 'createdAt', 'updatedAt'].includes(key)),
    );
  expect(comparableDraft(drafts[0]!)).toEqual(comparableDraft(drafts[1]!));
  expect(comparableDraft(drafts[0]!)).toEqual(comparableDraft(drafts[2]!));

  // 空外部标识：schema 直接拒空串；归一成 NULL 后两条可并存。
  await expectError(
    await postIntake(testApp, account.secret, {
      channel: 'wechat',
      externalId: '',
      content: '空串外部标识',
    }),
    400,
    'INVALID_INPUT',
  );
  for (const contentOf of ['没有外部标识一', '没有外部标识二']) {
    await expectJson(
      await postIntake(testApp, account.secret, { channel: 'wechat', content: contentOf }),
      201,
    );
  }
  for (const contentOf of ['没有外部标识一', '没有外部标识二']) {
    expect(
      await connection.repository('fqcMessages').count({ filter: { content: contentOf } }),
    ).toBe(1);
  }
  expect(feedbackExternalId('')).toBeNull();
  expect(feedbackExternalId('ext')).toBe('ext');
});

test('R-026 13: 只持提交反馈的人只看得到自己的单，维护端点一律 403', async ({
  testApp,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  await createUser(admin, 'r026s3-mine-owner', { app: ['staff'] });
  await createUser(admin, 'r026s3-mine-other', { app: ['staff'] });
  const ownerSession = await signInAs(testApp, 'r026s3-mine-owner');
  const otherSession = await signInAs(testApp, 'r026s3-mine-other');
  const mineId = ((await expectJson(
    await postFeedback(ownerSession, { content: '本人可见' }),
    201,
  )) as FeedbackBody).data.id;
  const otherId = ((await expectJson(
    await postFeedback(otherSession, { content: '别人的单' }),
    201,
  )) as FeedbackBody).data.id;

  const mine = (await expectJson(await getMine(ownerSession), 200)) as { data: FeedbackRow[] };
  expect(mine.data.map((row) => row.id)).toEqual([mineId]);
  expect(mine.data[0]).not.toHaveProperty('note');
  expect(mine.data[0]).not.toHaveProperty('discardedBy');
  await expectError(await getFeedbacks(ownerSession), 403, 'AUTHORIZATION_DENIED');
  await expectError(await getOne(ownerSession, mineId), 403, 'AUTHORIZATION_DENIED');
  await expectError(await patchOne(ownerSession, mineId, { note: '改不了' }), 403, 'AUTHORIZATION_DENIED');
  await expectError(
    await discardOne(ownerSession, mineId, { reason: 'other' }),
    403,
    'AUTHORIZATION_DENIED',
  );
  // 拿别人的标识查「我的」也不回那一行（与不存在同形）。
  const mineOfOther = (await expectJson(await getMine(ownerSession, `?status=open&pageSize=100`), 200)) as {
    data: FeedbackRow[];
  };
  expect(mineOfOther.data.map((row) => row.id)).not.toContain(otherId);
});

test('R-026 14: 维护反馈单可以按状态、渠道、时间与正文筛选', async ({
  testApp,
  connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  await createUser(admin, 'r026s3-list', { app: ['quality_manager'] });
  const manager = await signInAs(testApp, 'r026s3-list');
  const staffUser = await createUser(admin, 'r026s3-list-staff', { app: ['staff'] });
  const staff = await signInAs(testApp, 'r026s3-list-staff');

  const open = ((await expectJson(
    await postFeedback(staff, {
      channel: 'web',
      content: '关键词客户甲的尺寸问题',
      customerName: '客户甲',
      productName: '产品甲',
    }),
    201,
  )) as FeedbackBody).data.id;
  const proxy = ((await expectJson(
    await postFeedback(staff, { channel: 'proxy', customerName: '客户乙', content: '另一条' }),
    201,
  )) as FeedbackBody).data.id;
  await connection.repository('fqcMessages').updateMany({
    filter: { id: proxy },
    values: { status: 'discarded', discardedAt: new Date(), discardedBy: staffUser.id, discardReason: 'other' },
  });

  const rowsOf = async (query: string) => {
    const sep = query.includes('?') ? '&' : '?';
    return ((await expectJson(
      await getFeedbacks(manager, `${query}${sep}pageSize=100`),
      200,
    )) as { data: FeedbackRow[] }).data;
  };
  const idsOf = async (query: string) => (await rowsOf(query)).map((row) => row.id);
  // 只看这条用例造出来的四行；共享库里别人的行不参与，但多给一行同样会被抓到。
  const ours = (ids: string[], known: readonly string[]) =>
    ids.filter((id) => known.includes(id)).sort();
  expect(ours(await idsOf(''), [open, proxy])).toEqual([open, proxy].sort());
  expect(ours(await idsOf('?status=open'), [open, proxy])).toEqual([open]);
  expect(ours(await idsOf('?status=discarded'), [open, proxy])).toEqual([proxy]);
  expect(ours(await idsOf('?channel=proxy'), [open, proxy])).toEqual([proxy]);
  expect(ours(await idsOf('?q=%E5%AE%A2%E6%88%B7%E7%94%B2'), [open, proxy])).toEqual([open]);
  // 联系方式不参与搜索：content 与 customerName 都没有这个串。
  expect(ours(await idsOf('?q=%E8%81%94%E7%B3%BB%E4%BA%BA'), [open, proxy])).toEqual([]);

  const old = randomUUID();
  await connection.repository('fqcMessages').createOne({
    values: {
      id: old,
      channel: 'web',
      externalId: null,
      content: '八天前未处理',
      rawContentType: 'text',
      receivedAt: new Date(Date.now() - 8 * 24 * 3600_000),
      status: 'open',
      createdAt: new Date(Date.now() - 8 * 24 * 3600_000),
      updatedAt: new Date(),
    },
  });
  await connection.repository('fqcScreenings').createOne({
    values: {
      id: randomUUID(),
      messageId: old,
      outcome: 'needs-review',
      createdAt: new Date(Date.now() - 8 * 24 * 3600_000),
      updatedAt: new Date(),
    },
  });
  const recent = ((await expectJson(
    await postFeedback(staff, { content: '六天前未处理' }),
    201,
  )) as FeedbackBody).data.id;
  await connection.repository('fqcMessages').updateMany({
    filter: { id: recent },
    values: { createdAt: new Date(Date.now() - 6 * 24 * 3600_000) },
  });
  const known = [open, proxy, old, recent];
  expect(ours(await idsOf('?overdue=true'), known)).toEqual([old]);
  // 期望值从库里这批行的 outcome 算出来，筛选一放松（连已丢弃的也回来）就会红。
  const expectedPending: string[] = [];
  for (const id of known) {
    const screening = await screeningOf(connection, id);
    if (screening && screening.outcome !== 'reviewed') {
      expectedPending.push(id);
    }
  }
  expect(ours(await idsOf('?pending=true'), known)).toEqual(expectedPending.sort());
  expect(ours(await idsOf('?createdBefore=2026-01-01T00:00:00%2B08:00'), known)).toEqual([]);
});

test('R-026 15/16: 维护行的拼装字段、初筛八列与工单五列，无邮箱无用户名', async ({
  app,
  testApp,
  connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const staffUser = await createUser(admin, 'r026s3-decorate-staff', { app: ['staff'] });
  const staff = await signInAs(testApp, 'r026s3-decorate-staff');
  await createUser(admin, 'r026s3-manager', { app: ['quality_inspector'] });
  const manager = await signInAs(testApp, 'r026s3-manager');
  const file = await insertFile(connection, staffUser.id);
  const id = ((await expectJson(
    await postFeedback(staff, { content: '带附件的单', attachmentIds: [file] }),
    201,
  )) as FeedbackBody).data.id;
  const screeningId = (await screeningOf(connection, id))!.id as string;
  await connection.repository('fqcTickets').createOne({
    values: {
      id: randomUUID(),
      code: 'R026-S3-1',
      title: '演示单',
      description: '不该读到的工单正文',
      sourceMessageId: id,
      screeningId,
      category: 'dimension',
      severity: 'major',
      state: 'open',
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  });

  const detail = (await expectJson(await getOne(manager, id), 200)) as FeedbackBody;
  const row = detail.data;
  expect(row.submitterName).toBe('r026s3-decorate-staff');
  expect(row.attachments).toHaveLength(1);
  expect(row.canEdit).toBe(true);
  expect(row.canDiscard).toBe(false); // 有工单
  expect(row).toHaveProperty('note');
  expect(row).toHaveProperty('discardedBy');
  expect(Object.keys(row.screening ?? {}).sort()).toEqual([
    'category', 'confidence', 'id', 'messageId', 'outcome', 'severity', 'suggestedOwner', 'summary',
  ]);
  expect(row.screening).not.toHaveProperty('evidence');
  expect(Object.keys(row.ticket ?? {}).sort()).toEqual([
    'code', 'id', 'screeningId', 'sourceMessageId', 'state',
  ]);
  expect(row.ticket).not.toHaveProperty('description');
  const text = JSON.stringify(detail);
  expect(text).not.toContain('@example.test');
  // 真用户名是 r026s3decoratestaff（建人时去掉连字符）；姓名与用户名必须分得开。
  expect(text).not.toContain('r026s3decoratestaff');
  expect(row.submitterName).toBe('r026s3-decorate-staff');

  await connection.repository('fqcMessages').updateMany({
    filter: { id },
    values: { status: 'discarded', discardedAt: new Date(), discardedBy: staffUser.id, discardReason: 'other' },
  });
  // 机器入口没有提交人：submitterName 必须是 null。
  const intakeAccount = await createIntakeAccount(app, 'decorate-machine', false);
  const machine = (await expectJson(
    await postIntake(testApp, intakeAccount.secret, {
      channel: 'wechat',
      content: '机器入口没有提交人',
    }),
    201,
  )) as { data: { message: { id: string } } };
  const machineDetail = ((await expectJson(
    await getOne(manager, machine.data.message.id),
    200,
  )) as FeedbackBody).data;
  expect(machineDetail.submitterName).toBeNull();

  const discarded = ((await expectJson(await getOne(manager, id), 200)) as FeedbackBody).data;
  expect(discarded.canEdit).toBe(false);
  expect(discarded.canDiscard).toBe(false);
});

test('R-026 19/20: PATCH 只改表单列；原文、状态与丢弃列都不变；null 与空数组清空', async ({
  testApp,
  connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const staffUser = await createUser(admin, 'r026s3-patch-staff', { app: ['staff'] });
  const staff = await signInAs(testApp, 'r026s3-patch-staff');
  await createUser(admin, 'r026s3-patch-manager', { app: ['quality_manager'] });
  const manager = await signInAs(testApp, 'r026s3-patch-manager');
  const file = await insertFile(connection, staffUser.id);
  const id = ((await expectJson(
    await postFeedback(staff, {
      content: '不可改的原文',
      customerName: '旧客户',
      attachmentIds: [file],
    }),
    201,
  )) as FeedbackBody).data.id;

  const updated = (await expectJson(
    await patchOne(manager, id, {
      customerName: '新客户',
      productName: '新产品',
      model: '新型号',
      batchNo: '新批次',
      note: '内部备注',
      content: '想改原文',
      senderContact: '想改联系方式',
      ownerId: staffUser.id,
      channel: 'proxy',
      status: 'discarded',
      discardedAt: '2026-01-01T00:00:00',
      discardedBy: 'somebody',
      discardReason: 'other',
    }),
    200,
  )) as FeedbackBody;
  expect(updated.data).toMatchObject({ customerName: '新客户', productName: '新产品' });
  const stored = (await messageOf(connection, id))!;
  expect(stored).toMatchObject({
    customerName: '新客户',
    content: '不可改的原文',
    senderContact: null,
    channel: 'web',
    status: 'open',
    discardedAt: null,
    discardedBy: null,
    discardReason: null,
  });

  await expectError(await patchOne(manager, id, {}), 400, 'EMPTY_UPDATE');
  await expectError(await patchOne(manager, id, { customerName: '' }), 400, 'INVALID_INPUT');
  await expectError(await patchOne(manager, id, { note: 'x'.repeat(2001) }), 400, 'INVALID_INPUT');

  await expectJson(await patchOne(manager, id, { customerName: null, attachmentIds: [] }), 200);
  expect(await messageOf(connection, id)).toMatchObject({ customerName: null, attachmentIds: [] });
  expect((await fileOf(connection, file))?.feedbackId).toBeNull();

  await connection.repository('fqcMessages').updateMany({
    filter: { id },
    values: { status: 'discarded' },
  });
  await expectError(
    await patchOne(manager, id, { customerName: '已丢弃不能改' }),
    409,
    'FEEDBACK_NOT_OPEN',
  );
});

test('R-026 21/22: 丢弃记录谁、何时、为什么；重复与已派单都被拒', async ({
  testApp,
  connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  await createUser(admin, 'r026s3-discard-staff', { app: ['staff'] });
  const staff = await signInAs(testApp, 'r026s3-discard-staff');
  const managerUser = await createUser(admin, 'r026s3-discard-manager', { app: ['quality_manager'] });
  const manager = await signInAs(testApp, 'r026s3-discard-manager');

  const id = ((await expectJson(
    await postFeedback(staff, { content: '丢弃这一张' }),
    201,
  )) as FeedbackBody).data.id;
  const discarded = (await expectJson(
    await discardOne(manager, id, { reason: 'duplicate' }),
    200,
  )) as FeedbackBody;
  expect(discarded.data.status).toBe('discarded');
  expect(discarded.data.discardedBy).toBe(managerUser.id);
  expect(await messageOf(connection, id)).toMatchObject({
    status: 'discarded',
    discardedBy: managerUser.id,
    discardReason: 'duplicate',
  });
  expect((await messageOf(connection, id))?.discardedAt).not.toBeNull();
  await expectError(
    await discardOne(manager, id, { reason: 'duplicate' }),
    409,
    'FEEDBACK_NOT_OPEN',
  );
  expect(await connection.repository('fqcMessages').count({ filter: { id } })).toBe(1);

  const otherId = ((await expectJson(
    await postFeedback(staff, { content: '有工单不能丢' }),
    201,
  )) as FeedbackBody).data.id;
  const screeningId = (await screeningOf(connection, otherId))!.id as string;
  await connection.repository('fqcTickets').createOne({
    values: {
      id: randomUUID(),
      code: 'R026-S3-2',
      title: '演示单',
      sourceMessageId: otherId,
      screeningId,
      category: 'dimension',
      severity: 'major',
      state: 'open',
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  });
  await expectError(
    await discardOne(manager, otherId, { reason: 'not-defect' }),
    409,
    'FEEDBACK_DISPATCHED',
  );
  expect((await messageOf(connection, otherId))?.status).toBe('open');
});

test('R-026 重放经请求自己的读范围：改掉 ownerId 后重放 409，响应只有 error', async ({
  testApp,
  connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  await createUser(admin, 'r026s3-replay', { app: ['staff'] });
  const session = await signInAs(testApp, 'r026s3-replay');
  const key = operationKey();
  const body = { channel: 'web', content: '重放读范围' };
  const first = (await expectJson(await postFeedback(session, body, key), 201)) as FeedbackBody;
  // 首回由写入值拼，重放经读范围读回；键集必须一致，否则 FeedbackSchema 的必有列会缺。
  expect(Object.keys(first.data).sort()).toContain('discardedAt');
  expect(Object.keys(first.data).sort()).toContain('discardReason');
  const replay = await postFeedback(session, body, key);
  expect(replay.headers.get('Idempotency-Replayed')).toBe('true');
  const replayed = ((await expectJson(replay, 201)) as FeedbackBody).data;
  expect(replayed.id).toBe(first.data.id);
  expect(Object.keys(replayed).sort()).toEqual(Object.keys(first.data).sort());

  // 范围外：把这一行挪到别人名下，同一把钥匙重放就读不到。
  await connection.repository('fqcMessages').updateMany({
    filter: { id: first.data.id },
    values: { ownerId: randomUUID() },
  });
  const text = await (await postFeedback(session, body, key)).text();
  expect(text).toContain('OPERATION_CONFLICT');
  expect(text).not.toContain(first.data.id);
  expect(text).not.toContain('"data"');
});

test('R-026 变异靶：去重只认 (channel, externalId) 这一个约束', () => {
  const wrapped = (constraint: string) => ({ code: '23505', constraint, cause: { code: '23505' } });
  const recognized = feedbackUniqueError(wrapped('uq_fqc_messages_channel_external'));
  expect(recognized?.reason).toBe('FEEDBACK_ALREADY_RECORDED');
  expect(recognized?.status).toBe('ALREADY_EXISTS');
  for (const name of ['uq_fqc_feedback_reminders_feedback', 'pk_fqc_messages', 'other']) {
    expect(
      feedbackUniqueError(wrapped(name)),
      `${name} 不该映射成 FEEDBACK_ALREADY_RECORDED`,
    ).toBeUndefined();
  }
});

test('R-026 变异靶：空串归一在入库前完成，仓储调用也走它', async ({
  testApp,
  connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const user = await createUser(admin, 'r026s3-normalize', { app: ['staff'] });
  const authz = testApp.application.container.resolve(authorizationToken);
  const decision = await authz
    .for({ principal: { type: 'user', id: user.id } })
    .authorize({ resource: { type: 'composite', id: 'fqc' }, action: 'submit' });
  const policies = decision.conditions!.database! as {
    fqcMessages: never;
    fqcScreenings: never;
  };
  await connection.transaction((transaction) =>
    ingestFeedback(
      {
        channel: 'web',
        externalId: '',
        senderName: null,
        senderContact: null,
        content: '仓储直接写空串',
        contentType: 'text',
        customerName: null,
        productName: null,
        model: null,
        batchNo: null,
        attachmentIds: [],
        ownerId: user.id,
      },
      transaction,
      { messages: policies.fqcMessages, screenings: policies.fqcScreenings },
      user.id,
    ),
  );
  const rows = await connection.repository('fqcMessages').findMany({
    filter: { content: '仓储直接写空串' },
  });
  expect(rows).toHaveLength(1);
  expect(rows[0]?.externalId).toBeNull();
});

test('R-026 变异靶：升级只改未确认的行，确认抢先后不替换', async ({
  app,
  testApp,
  connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const user = await createUser(admin, 'r026s3-upgrade', { app: ['staff'] });
  const session = await signInAs(testApp, 'r026s3-upgrade');
  const id = ((await expectJson(
    await postFeedback(session, { content: '升级谓词' }),
    201,
  )) as FeedbackBody).data.id;
  const screening = (await screeningOf(connection, id))!;
  const authz = app.container.resolve(authorizationToken);
  const decision = await authz
    .for({ principal: { type: 'user', id: user.id } })
    .authorize({ resource: { type: 'composite', id: 'fqc' }, action: 'submit' });
  const policy = decision.conditions!.database!.fqcScreenings as never;
  await connection.repository('fqcScreenings').updateMany({
    filter: { id: screening.id },
    values: { reviewId: randomUUID() },
  });
  const result = await upgradeScreeningDraft({
    connection,
    policy,
    screeningId: String(screening.id),
    text: '升级谓词',
    drafting: app.container.resolve(qualityDraftingToken),
  });
  expect(result.written).toBe(false);
  expect((await screeningOf(connection, id))?.summary).toBe(screening.summary);
});

modelTest('R-026 变异靶：网页入口的模型升级用「提交反馈」传来的范围', async ({
  testApp,
  connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const user = await createUser(admin, 'r026s3-scope', { app: ['staff'] });
  const session = await signInAs(testApp, 'r026s3-scope');
  fakeGateway.calls.length = 0;
  const originalAnswer = fakeGateway.answer;
  // 模型确实被调用了，但在升级写库之前把这一行挪到别人名下：
  // 用「提交反馈」的「仅本人」范围时更新匹配 0 行，模型值不许落库。
  fakeGateway.answer = async (request) => {
    // 「仅本人」比的是初筛表的 ownerId，改的必须是这一列。
    await connection.repository('fqcScreenings').updateMany({
      filter: { ownerId: user.id },
      values: { ownerId: randomUUID() },
    });
    return originalAnswer(request);
  };
  try {
    const id = ((await expectJson(
      await postFeedback(session, { content: '升级范围必须仅本人' }),
      201,
    )) as FeedbackBody).data.id;
    // eslint-disable-next-line vitest/no-standalone-expect
    expect(fakeGateway.calls.length, '模型必须真的跑过').toBe(1);
    const stored = await screeningOf(connection, id);
    // eslint-disable-next-line vitest/no-standalone-expect
    expect(stored).toMatchObject({ engine: 'rules', modelName: 'rule-baseline' });
    // eslint-disable-next-line vitest/no-standalone-expect
    expect(stored?.summary).not.toBe('模型判定：尺寸超差');
  } finally {
    fakeGateway.answer = originalAnswer;
  }
});

test('R-026 并发：同键同体两次投递，一次落库、一次重放', async ({
  app,
  testApp,
  connection,
}) => {
  const account = await createIntakeAccount(app, 'concurrent-key', true);
  const key = operationKey();
  const externalId = randomUUID();
  const body = {
    channel: 'wechat',
    externalId,
    content: '并发同键投递',
  };
  const [first, second] = await Promise.all([
    postIntake(testApp, account.secret, body, key),
    postIntake(testApp, account.secret, body, key),
  ]);
  expect([first.status, second.status].sort()).toEqual([201, 201]);
  expect(
    [first.headers.get('Idempotency-Replayed'), second.headers.get('Idempotency-Replayed')].sort(),
  ).toEqual(['false', 'true']);
  expect(
    await connection.repository('fqcMessages').count({ filter: { externalId } }),
  ).toBe(1);
});

test('R-026 并发（仅 Postgres）：一个事务未提交时另一个撞同一个外部标识回 409', async ({
  app,
  testApp,
  connection,
}) => {
  if (connection.dialect !== 'postgres') {
    // SQLite 的写锁形态与 Postgres 不同；这一条只在真 Postgres 上验未提交事务的阻挡。
    return;
  }
  const account = await createIntakeAccount(app, 'concurrent-uncommitted', false);
  const externalId = randomUUID();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let inserted!: () => void;
  const held = new Promise<void>((resolve) => {
    inserted = resolve;
  });
  const holder = (async () => {
    await connection.transaction(async (transaction) => {
      await transaction.repository('fqcMessages').createOne({
        values: {
          id: randomUUID(),
          channel: 'wechat',
          externalId,
          content: '先占住但还没提交',
          rawContentType: 'text',
          receivedAt: new Date(),
          status: 'open',
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      });
      inserted();
      await gate;
    });
  })();
  try {
    await held;
    const pending = postIntake(testApp, account.secret, {
      channel: 'wechat',
      externalId,
      content: '另一个未提交的投递',
    });
    // 让第二个请求进到写库、被第一个事务挡住，再放行第一个事务提交。
    await new Promise((resolve) => setTimeout(resolve, 250));
    release();
    const response = await pending;
    const text = await response.text();
    expect(response.status).toBe(409);
    expect((JSON.parse(text) as ApiErrorBody).error.reason).toBe(
      'FEEDBACK_ALREADY_RECORDED',
    );
  } finally {
    release();
    await holder;
  }
  expect(
    await connection.repository('fqcMessages').count({ filter: { externalId } }),
  ).toBe(1);
});

test('R-026 四种角色对反馈端点的放行与拒绝（部门主管按最窄的定）', async ({
  app,
  testApp,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const authz = app.container.resolve(authorizationToken);
  const people = [
    ['manager', 'quality_manager'],
    ['inspector', 'quality_inspector'],
    ['dept', 'dept_manager'],
    ['employee', 'staff'],
  ] as const;
  for (const [name, role] of people) {
    await createUser(admin, `r026s3-role-${name}`, { app: [role] });
  }
  // 部门主管作为「人」带 staff 基线；撤掉基线后只剩业务角色，用来钉住「提交反馈」的持有者。
  const deptOnly = await createUser(admin, 'r026s3-role-dept-only', {
    app: ['dept_manager'],
  });
  await authz.permissionSets.revoke(`user:${deptOnly.id}:staff`);

  const sessions = Object.fromEntries(
    await Promise.all(
      [...people.map(([name]) => name), 'dept-only'].map(async (name) => [
        name,
        await signInAs(testApp, `r026s3-role-${name}`),
      ]),
    ),
  ) as Record<string, TestSession>;

  for (const name of ['manager', 'inspector', 'dept', 'employee']) {
    const response = await postFeedback(sessions[name]!, {
      content: `角色 ${name} 提交`,
      customerName: undefined,
    });
    expect(response.status, `${name} 应当能提交反馈`).toBe(201);
    expect((await getMine(sessions[name]!)).status, `${name} 应当能看我的反馈`).toBe(200);
  }
  await expectError(
    await postFeedback(sessions['dept-only']!, { content: '只有部门主管的业务角色' }),
    403,
    'AUTHORIZATION_DENIED',
  );
  await expectError(await getMine(sessions['dept-only']!), 403, 'AUTHORIZATION_DENIED');

  const list = (await expectJson(
    await getFeedbacks(sessions['manager']!),
    200,
  )) as { data: FeedbackRow[] };
  const id = list.data.find((row) => row.content === '角色 manager 提交')!.id;
  for (const name of ['manager', 'inspector']) {
    expect((await getFeedbacks(sessions[name]!)).status, `${name} 应当能看全部`).toBe(200);
    expect((await getOne(sessions[name]!, id)).status, `${name} 应当能看详情`).toBe(200);
    expect((await patchOne(sessions[name]!, id, { note: `${name} 的备注` })).status).toBe(200);
  }
  for (const name of ['dept', 'employee', 'dept-only']) {
    await expectError(await getFeedbacks(sessions[name]!), 403, 'AUTHORIZATION_DENIED');
    await expectError(await getOne(sessions[name]!, id), 403, 'AUTHORIZATION_DENIED');
    await expectError(
      await patchOne(sessions[name]!, id, { note: '改不了' }),
      403,
      'AUTHORIZATION_DENIED',
    );
    await expectError(
      await discardOne(sessions[name]!, id, { reason: 'other' }),
      403,
      'AUTHORIZATION_DENIED',
    );
  }
});

test('R-026 附件并发（仅 Postgres）：同一附件被另一个事务先占用时绑定失败并回滚', async ({
  testApp,
  connection,
}) => {
  if (connection.dialect !== 'postgres') {
    // SQLite 的写锁形态不同；这一条只在真 Postgres 上验带谓词绑定的行锁重算。
    return;
  }
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  await createUser(admin, 'r026s3-file-race', { app: ['staff'] });
  const session = await signInAs(testApp, 'r026s3-file-race');
  const userId = String(
    (
      await connection.repository('user').findOne({
        filter: { username: 'r026s3filerace' },
      })
    )!.id,
  );
  const fileId = await insertFile(connection, userId);

  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let locked!: () => void;
  const held = new Promise<void>((resolve) => {
    locked = resolve;
  });
  const otherFeedback = randomUUID();
  const holder = (async () => {
    await connection.transaction(async (transaction) => {
      await transaction.repository('fqcFeedbackFiles').updateMany({
        filter: { id: fileId },
        values: { feedbackId: otherFeedback, updatedAt: new Date() } as never,
      });
      locked();
      await gate;
    });
  })();
  try {
    await held;
    const started = Date.now();
    const pending = postFeedback(session, {
      content: '并发抢同一个附件',
      attachmentIds: [fileId],
    });
    // 提交的读看到的是旧快照（还没被占用），绑定更新则被行锁挡住；放行后谓词重算匹配 0 行。
    await new Promise((resolve) => setTimeout(resolve, 300));
    release();
    const response = await pending;
    const text = await response.text();
    expect(Date.now() - started).toBeGreaterThan(200);
    expect(response.status).toBe(422);
    expect((JSON.parse(text) as ApiErrorBody).error.reason).toBe(
      'ATTACHMENT_NOT_AVAILABLE',
    );
    expect(
      await connection.repository('fqcMessages').count({ filter: { content: '并发抢同一个附件' } }),
    ).toBe(0);
    expect((await fileOf(connection, fileId))?.feedbackId).toBe(otherFeedback);
  } finally {
    release();
    await holder;
  }
});
