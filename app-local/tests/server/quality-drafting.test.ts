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
import { knowledgeToken } from '@nocobase/app-plugin-knowledge/server/tokens';
import { loggingToken } from '@nocobase/app-server/logging';
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
import type {
  DatabaseConnection,
  RepositoryOperations,
  RepositoryRecord,
} from '@nocobase/db';
import { expect, vi } from 'vitest';

import { createAppTest, createTestApp } from '../helpers/test-app.js';
import { createApp } from '../../server/app.js';
import {
  DRAFT_TIMEOUT_MS,
  qualityDraftingToken,
  type DraftResult,
  type DraftSimilarCaseSources,
  type QualityDraftingService,
} from '../../server/providers/quality-drafting.js';
import {
  qualityModelGatewayToken,
  type QualityModelGateway,
  type QualityModelGatewayRequest,
  type QualityModelGatewayResult,
} from '../../server/providers/quality-model-gateway.js';
import appRuntime from '../../server/runtime.js';
import { createStandaloneServer } from '../../server/standalone.js';

/**
 * R-002 第二个切片：代填服务的模型层（验收 1–8、10、13）。
 *
 * 「模型服务已经配好、假网关也在」用一个真的实现容器来满足：测试的应用在启动
 * 之前把自己的假网关绑进容器（`qualityModelGatewayToken`），provider 看到这个
 * 令牌已经绑好就不再绑真的。容器不允许覆盖已绑定的服务（`ServiceContainer` 的
 * `assertAvailable`），所以假网关必须在 `startApplicationInScope` 之前放进容器；
 * 这也正是设计里「测试在容器里换成一个假的」那一条的实现。
 *
 * 开关按配置走：主应用开着（`quality.drafting.modelEnabled: true`）。关着的那一条
 * 与「开关开着、没有启用任何聊天模型」各起一个自己的应用，因为它们的配置不同，
 * 而配置在应用启动时就定了。
 *
 * 编造的手机号一律分段拼出来：仓库的敏感信息预检按源码里的连续数字串判定。
 */

const APP_ROOT = path.resolve(import.meta.dirname, '../..');
const PASSWORD = 'R002-drafting-123!';
const BASE_CONFIG = {
  app: { publicOrigin: 'http://localhost' },
  auth: { secret: 'test-auth-secret-at-least-32-characters' },
};
const digits = (...parts: readonly string[]) => parts.join('');
const spacedMobile = (...parts: readonly string[]) => parts.join(' ');
const hyphenatedLandline = (...parts: readonly string[]) => parts.join('-');

/** 一个假网关：记下每次请求，按当前场景回答。 */
interface FakeGateway extends QualityModelGateway {
  readonly calls: QualityModelGatewayRequest[];
  answer: (
    request: QualityModelGatewayRequest,
  ) => Promise<QualityModelGatewayResult>;
}

const defaultAnswer: FakeGateway['answer'] = async () => ({
  text: JSON.stringify({
    category: 'dimension',
    severity: 'major',
    summary: '模型判定：尺寸超差',
    confidence: 0.86,
    evidence: ['尺寸'],
  }),
  model: 'fake-service/fake-model',
});

const fakeGateway: FakeGateway = {
  calls: [],
  answer: defaultAnswer,
  async generate(request) {
    this.calls.push(request);
    return this.answer(request);
  },
};

/** 与 `server/embedded.ts` 的 createServer 同一步骤，只多了「启动之前把假的绑进容器」。 */
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

const test = createAppTest({
  createServer: createServerWithFakeGateway,
  config: {
    ...BASE_CONFIG,
    quality: { drafting: { modelEnabled: true } },
  },
});

interface Ingested {
  data: {
    message: { id: string; content: string };
    screening: Record<string, unknown> & { id: string };
    ticket: { id: string };
  };
}

const json = (body: unknown, method = 'POST') => ({
  method,
  headers: {
    'content-type': 'application/json',
    origin: 'http://localhost',
    'Idempotency-Key': `${Date.now()}.${randomUUID()}`,
  },
  body: JSON.stringify(body),
});

const apiKeyHeaders = (secret: string, key: string) => ({
  'content-type': 'application/json',
  origin: 'http://localhost',
  'x-api-key': secret,
  'Idempotency-Key': key,
});

const expectJson = async (
  response: Response,
  status: number,
): Promise<unknown> => {
  const text = await response.text();
  expect(response.status, `${text}`).toBe(status);
  return JSON.parse(text) as unknown;
};

const createUser = async (
  admin: TestSession,
  name: string,
  roleScopes: Record<string, string[]>,
): Promise<{ id: string }> => {
  const response = await admin.fetch(
    '/users',
    json({
      name,
      username: name,
      email: `${name}@example.test`,
      password: PASSWORD,
      roleScopes,
    }),
  );
  const text = await response.text();
  expect(response.status, `${text}`).toBe(201);
  return (JSON.parse(text) as { data: { id: string } }).data;
};

const signInAs = (app: SignInTarget, username: string): Promise<TestSession> =>
  signIn(app, { username, password: PASSWORD });

/** `fqc.intake`：投递的测试权限集。 */
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

/**
 * 一个投递用的服务账号：`fqc.intake`；`knowledge: true` 时再给
 * `{ type: 'kb', id: 'kb.knowledge' }` 的 `read.related`（投递读知识库那一档）。
 */
const createIntakeAccount = async (
  app: Application,
  options: {
    readonly name: string;
    readonly knowledge: boolean;
    /** 初筛的读范围：'all' 或一组 record id；不给就是没有读资格。 */
    readonly view?: 'all' | { readonly screenings: readonly string[] };
  },
): Promise<{ id: string; secret: string }> => {
  const authz = app.container.resolve(authorizationToken);
  const key = `r002d-${options.name}`;
  await authz.permissionSets.create({
    key,
    grants: [
      intakeGrant,
      ...(options.view
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
                      fqcScreenings:
                        options.view === 'all'
                          ? 'allRecords'
                          : {
                              type: 'records',
                              ids: [...options.view.screenings],
                            },
                      fqcTickets: 'allRecords',
                      fqcScreeningReviews: 'allRecords',
                    },
                  },
                },
              ],
            },
          ]
        : []),
      ...(options.knowledge
        ? [
            {
              resource: { type: 'kb', id: 'kb.knowledge' },
              actions: [{ action: 'read.related' }],
            },
          ]
        : []),
    ],
  });
  const users = app.container.resolve(userAdministrationServiceToken);
  const account = await users.createServiceAccount({ name: options.name });
  await authz.permissionSets.assign({
    subject: { type: 'user', id: account.id },
    permissionSet: key,
  });
  const keys = app.container.resolve(scopedApiKeysToken);
  const secret = (
    await keys.create(
      account.id,
      { name: `${options.name} key` },
      await keys.identityOf(account.id),
    )
  ).secret;
  return { id: account.id, secret };
};

const postIntake = (
  app: TestApp,
  secret: string,
  body: Record<string, unknown>,
  idempotencyKey = `${Date.now()}.${randomUUID()}`,
) =>
  app.request('/quality/intake', {
    method: 'POST',
    headers: apiKeyHeaders(secret, idempotencyKey),
    body: JSON.stringify(body),
  });

const intakeBody = (content: string, extra: Record<string, unknown> = {}) => ({
  channel: 'wechat',
  contentType: 'text',
  content,
  ...extra,
});

/** 一次投递在库里留下的那一行初筛（投递本身不回读，测试从仓储读）。 */
const screeningOfMessage = async (
  connection: DatabaseConnection,
  messageId: string,
): Promise<Record<string, unknown>> => {
  const row = await connection
    .repository('fqcScreenings')
    .findOne({ filter: { messageId } });
  expect(row, '库里找不到这次投递的初筛').toBeDefined();
  return row as unknown as Record<string, unknown>;
};

const messageIdOfContent = async (
  connection: DatabaseConnection,
  content: string,
): Promise<string> => {
  const row = await connection
    .repository('fqcMessages')
    .findOne({ filter: { content } });
  expect(row, '库里找不到这条消息').toBeDefined();
  return String((row as unknown as { id: string }).id);
};

/** 每个测试开始前把假网关恢复成「什么都不记」的干净状态。 */
const resetFake = (answer?: FakeGateway['answer']): void => {
  fakeGateway.calls.length = 0;
  fakeGateway.answer = answer ?? defaultAnswer;
};

/** 接收一个 logger 的调用，测试结束时还原。 */
const spyOnLogger = (
  app: Application,
  name: string,
  level: 'warn' | 'info',
) => {
  const logger = app.container.resolve(loggingToken).getLogger(name);
  return vi.spyOn(logger, level).mockImplementation(() => undefined);
};

const screeningFixture = (
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => {
  const id = (overrides.id as string | undefined) ?? randomUUID();
  const createdAt = overrides.createdAt ?? new Date();
  return {
    id,
    messageId: `message-${id}`,
    category: 'dimension',
    severity: 'major',
    suggestedOwner: 'quality-dimension',
    summary: '尺寸超差',
    confidence: '0.7500',
    evidence: ['尺寸'],
    modelName: 'rule-baseline',
    outcome: 'needs-review',
    engine: 'rules',
    promptVersion: null,
    degraded: false,
    degradeReason: null,
    knowledgeRefs: [],
    redacted: false,
    reviewId: null,
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  };
};

const insertMessage = async (
  connection: DatabaseConnection,
  values: Record<string, unknown>,
): Promise<void> => {
  const now = new Date();
  await connection.repository('fqcMessages').createOne({
    values: {
      id: randomUUID(),
      channel: 'wechat',
      senderName: null,
      senderContact: null,
      content: '',
      rawContentType: 'text',
      receivedAt: now,
      status: 'screened',
      createdAt: now,
      updatedAt: now,
      ...values,
    },
  });
};

test('R-002 1: 开关关着时假网关一次都不被调用，草稿是规则版，原因是 model-disabled', async () => {
  // 开关关着、假网关也在：另起一个应用，配置与主应用只差这一个开关。
  const offApp = await createTestApp({
    createServer: createServerWithFakeGateway,
    config: {
      ...BASE_CONFIG,
      quality: { drafting: { modelEnabled: false } },
    },
  });
  resetFake();
  try {
    const account = await createIntakeAccount(offApp.application, {
      name: 'r002d-off',
      knowledge: false,
    });
    const content = '这批零件尺寸超差，装配不上';
    const response = await postIntake(
      offApp,
      account.secret,
      intakeBody(content),
    );
    const body = (await expectJson(response, 201)) as Ingested;

    expect(fakeGateway.calls, '开关关着时不该碰网关').toHaveLength(0);
    const stored = await screeningOfMessage(
      offApp.connection,
      body.data.message.id,
    );
    expect(stored).toMatchObject({
      engine: 'rules',
      modelName: 'rule-baseline',
      degraded: false,
      degradeReason: 'model-disabled',
      redacted: false,
      knowledgeRefs: [],
    });
    expect(body.data.screening).toMatchObject({
      engine: 'rules',
      degradeReason: 'model-disabled',
    });
  } finally {
    await offApp.close();
  }
});

test('R-002 2: 开关开着、没有启用任何聊天模型时不发请求，原因是 model-not-configured', async () => {
  // 不换假网关：用真的适配器，走它「目录里没有默认聊天模型」的分支。
  const realApp = await createTestApp({
    createServer: createStandaloneServer,
    config: {
      ...BASE_CONFIG,
      quality: { drafting: { modelEnabled: true } },
    },
  });
  try {
    const account = await createIntakeAccount(realApp.application, {
      name: 'r002d-nomodel',
      knowledge: false,
    });
    const content = '这批零件尺寸超差，装配不上';
    const response = await postIntake(
      realApp,
      account.secret,
      intakeBody(content),
    );
    const body = (await expectJson(response, 201)) as Ingested;
    const stored = await screeningOfMessage(
      realApp.connection,
      body.data.message.id,
    );
    expect(stored).toMatchObject({
      engine: 'rules',
      degraded: true,
      degradeReason: 'model-not-configured',
    });
    expect(
      await realApp.connection.repository('agModelUsage').count({
        filter: { source: 'fqc.draft' },
      }),
      '没有模型时不该产生任何用量',
    ).toBe(0);
  } finally {
    await realApp.close();
  }
});

test('R-002 3: 假网关抛错时投递仍是 201，草稿回落规则版、degraded 为真、原因是 model-error，应用自己记一条', async ({
  testApp,
  app,
  connection,
}) => {
  const account = await createIntakeAccount(app, {
    name: 'r002d-error',
    knowledge: false,
  });
  resetFake(async () => {
    throw new Error('假网关炸了');
  });
  const content = '这批零件尺寸超差，装配不上';
  const warn = spyOnLogger(app, 'quality-drafting', 'warn');
  try {
    const response = await postIntake(
      testApp,
      account.secret,
      intakeBody(content),
    );
    const body = (await expectJson(response, 201)) as Ingested;
    expect(body.data.message.content).toBe(content);
    const stored = await screeningOfMessage(connection, body.data.message.id);
    expect(stored).toMatchObject({
      engine: 'rules',
      modelName: 'rule-baseline',
      degraded: true,
      degradeReason: 'model-error',
    });
    expect(warn).toHaveBeenCalledTimes(1);
    const [event, message] = warn.mock.calls[0] as [Record<string, unknown>, string];
    expect(event).toMatchObject({
      source: 'fqc.draft',
      reason: 'model-error',
    });
    expect(typeof event.durationMs).toBe('number');
    expect(`${message}`).toContain('recorded');
    expect(JSON.stringify(warn.mock.calls), '日志不该带正文').not.toContain(
      content,
    );
  } finally {
    warn.mockRestore();
  }
});

test(
  'R-002 4: 假网关挂起不放时到十五秒按 timeout 处理，应用自己记一条',
  { timeout: 40_000 },
  async ({ testApp, app, connection }) => {
    const account = await createIntakeAccount(app, {
      name: 'r002d-timeout',
      knowledge: false,
    });
    let abortedAt = 0;
    resetFake(
      (request) =>
        new Promise((_resolve, reject) => {
          // 挂起不放，但尊重 signal：十五秒的总预算应当 abort 它。
          request.signal?.addEventListener('abort', () => {
            abortedAt = Date.now();
            reject(new Error('aborted'));
          });
        }),
    );
    const warn = spyOnLogger(app, 'quality-drafting', 'warn');
    try {
      const startedAt = Date.now();
      const response = await postIntake(
        testApp,
        account.secret,
        intakeBody('这批零件尺寸超差，装配不上'),
      );
      const elapsed = Date.now() - startedAt;
      const body = (await expectJson(response, 201)) as Ingested;
      expect(elapsed, '十五秒之前不该返回').toBeGreaterThanOrEqual(14_500);
      expect(abortedAt, '超时应当 abort 假网关').toBeGreaterThan(0);
      const stored = await screeningOfMessage(connection, body.data.message.id);
      expect(stored).toMatchObject({
        engine: 'rules',
        degraded: true,
        degradeReason: 'timeout',
      });
      expect(warn).toHaveBeenCalledTimes(1);
      const [event] = warn.mock.calls[0] as [Record<string, unknown>];
      expect(event).toMatchObject({ source: 'fqc.draft', reason: 'timeout' });
      expect(event.durationMs as number).toBeGreaterThanOrEqual(14_500);
      expect(JSON.stringify(warn.mock.calls)).not.toContain('尺寸超差');
    } finally {
      warn.mockRestore();
    }
  },
);

test(
  'R-002 4: 十五秒预算盖住取上下文——慢仓储卡过预算时按 timeout 回落，网关没被调用',
  { timeout: 40_000 },
  async ({ app }) => {
    const drafting: QualityDraftingService = app.container.resolve(
      qualityDraftingToken,
    );
    resetFake();
    // 把「取上下文」做成可控的慢函数：假仓储的 findMany 卡在 gate 上，
    // 只有测试放开才完成。先推进假时钟到预算到点，看实现有没有先回落。
    const gate = Promise.withResolvers<unknown[]>();
    const slowRepo = {
      findMany: () => gate.promise,
    } as unknown as RepositoryOperations<RepositoryRecord>;
    const cases: DraftSimilarCaseSources = {
      screenings: slowRepo,
      messages: slowRepo,
      reviews: slowRepo,
    };
    vi.useFakeTimers();
    let settled: DraftResult | undefined;
    const tracked = drafting
      .draft({ text: '尺寸超差 装配不上' }, { cases })
      .then((result) => {
        settled = result;
        return result;
      });
    try {
      // 推进到预算到点：正确的实现在这里 abort 并按 timeout 回落，上下文还卡着。
      await vi.advanceTimersByTimeAsync(DRAFT_TIMEOUT_MS);
      expect(settled, '预算到点就该回落，不用等取上下文').toBeDefined();
      expect(settled).toMatchObject({
        engine: 'rules',
        degraded: true,
        degradeReason: 'timeout',
      });
      expect(
        fakeGateway.calls,
        '取上下文超预算时网关不该被调用',
      ).toHaveLength(0);
    } finally {
      gate.resolve([]);
      vi.useRealTimers();
      // 被放弃的那一支之后 settle，吞掉它的结果，不留未处理的拒绝。
      await tracked.catch(() => undefined);
    }
  },
);

test('R-002 5: 不是 JSON、缺字段、枚举或数值越界，都判为 invalid-output 并回落规则版', async ({
  testApp,
  app,
  connection,
}) => {
  const account = await createIntakeAccount(app, {
    name: 'r002d-invalid',
    knowledge: false,
  });
  const cases: readonly { readonly name: string; readonly text: string }[] = [
    { name: '不是 JSON', text: '这不是 JSON' },
    {
      name: '缺严重度',
      text: JSON.stringify({
        category: 'dimension',
        summary: '缺了严重度',
        confidence: 0.8,
        evidence: [],
      }),
    },
    {
      name: '严重度越界',
      text: JSON.stringify({
        category: 'dimension',
        severity: 'severe',
        summary: '严重度不在四级里',
        confidence: 0.8,
        evidence: [],
      }),
    },
    {
      name: '置信度越界',
      text: JSON.stringify({
        category: 'dimension',
        severity: 'major',
        summary: '置信度大于一',
        confidence: 1.5,
        evidence: [],
      }),
    },
    {
      name: '类别越界',
      text: JSON.stringify({
        category: 'unknown',
        severity: 'major',
        summary: '类别不在七类里',
        confidence: 0.8,
        evidence: [],
      }),
    },
  ];
  for (const scenario of cases) {
    resetFake(async () => ({
      text: scenario.text,
      model: 'fake-service/fake-model',
    }));
    const response = await postIntake(
      testApp,
      account.secret,
      intakeBody(`越界场景 ${scenario.name} 尺寸超差`),
    );
    const body = (await expectJson(response, 201)) as Ingested;
    expect(
      await screeningOfMessage(connection, body.data.message.id),
      `${scenario.name} 应当回落规则版`,
    ).toMatchObject({
      engine: 'rules',
      degraded: true,
      degradeReason: 'invalid-output',
    });
  }
});

test('R-002 6: 重放的投递不再调模型，响应与库里的值一致', async ({
  testApp,
  app,
  connection,
}) => {
  const account = await createIntakeAccount(app, {
    name: 'r002d-replay',
    knowledge: false,
    // 重放要经请求自己的读范围读回当前行：给全量，才走得到「范围内」这一支。
    view: 'all',
  });
  resetFake();
  const key = `${Date.now()}.${randomUUID()}`;
  const body = intakeBody('重放的消息 尺寸超差');
  const first = await postIntake(testApp, account.secret, body, key);
  expect(first.headers.get('Idempotency-Replayed')).toBe('false');
  const firstBody = (await expectJson(first, 201)) as Ingested;
  expect(fakeGateway.calls).toHaveLength(1);
  const stored = await screeningOfMessage(
    connection,
    firstBody.data.message.id,
  );
  expect(stored).toMatchObject({ engine: 'model' });

  const replay = await postIntake(testApp, account.secret, body, key);
  expect(replay.headers.get('Idempotency-Replayed')).toBe('true');
  const replayBody = (await expectJson(replay, 201)) as Ingested;
  expect(fakeGateway.calls, '重放不该再调模型').toHaveLength(1);
  // 第一次的 201 拼在模型升级之前；重放要回与库里一致的值，而不是那份规则版。
  expect(replayBody.data.screening).toEqual(firstBody.data.screening);
  // 只比读者看得到的列：`ownerId` 是 R-026 的列，「查看」的列清单里没有它，重放也读不到。
  const visible = Object.fromEntries(
    Object.keys(firstBody.data.screening).map((key) => [key, stored[key]]),
  );
  expect(replayBody.data.screening).toEqual(visible);
});

test('R-002 6: 重放经请求自己的读范围——范围外或没有读资格时 409，响应只有 error', async ({
  testApp,
  app,
}) => {
  resetFake();
  const scoped = await createIntakeAccount(app, {
    name: 'r002d-replay-scoped',
    knowledge: false,
    // 读范围只放一条不存在的记录：自己刚投的那一行不在里面。
    view: { screenings: ['r002d-not-in-range'] },
  });
  const blind = await createIntakeAccount(app, {
    name: 'r002d-replay-blind',
    knowledge: false,
  });
  const post = (secret: string, key: string) =>
    postIntake(
      testApp,
      secret,
      intakeBody('范围外重放 尺寸超差'),
      key,
    );

  for (const account of [scoped, blind]) {
    const key = `${Date.now()}.${randomUUID()}`;
    const first = await post(account.secret, key);
    const firstBody = (await expectJson(first, 201)) as Ingested;
    const replay = await post(account.secret, key);
    const text = await replay.text();
    expect(replay.status).toBe(409);
    const body = JSON.parse(text) as Record<string, unknown>;
    expect((body.error as { reason: string }).reason).toBe(
      'OPERATION_CONFLICT',
    );
    // 只带 error，不带任何记录字段：连这一次的行 id 都不回。
    expect(body).not.toHaveProperty('data');
    expect(text).not.toContain(firstBody.data.screening.id);
    expect(text).not.toContain('screening');
  }
  expect(fakeGateway.calls, '范围外的重放也不该调模型').toHaveLength(2);
});

test('R-002 7: 确认抢先时模型结果丢掉，库里与 201 都保持规则版，原因是空', async ({
  testApp,
  app,
  connection,
}) => {
  const account = await createIntakeAccount(app, {
    name: 'r002d-race',
    knowledge: false,
  });
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  let release!: (result: QualityModelGatewayResult) => void;
  resetFake(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const info = spyOnLogger(app, 'quality', 'info');
  try {
    const content = '确认抢先 尺寸超差';
    const pending = postIntake(testApp, account.secret, intakeBody(content));
    // 等假网关真的被叫到：这时投递的事务已经提交，确认可以抢在模型回答之前。
    await expect
      .poll(() => fakeGateway.calls.length, { timeout: 10_000 })
      .toBe(1);
    const messageId = await messageIdOfContent(connection, content);
    const before = await screeningOfMessage(connection, messageId);
    const screeningId = String(before.id);
    await expectJson(
      await admin.fetch(
        `/quality/screenings/${screeningId}/review`,
        json({}),
      ),
      200,
    );

    release({
      text: JSON.stringify({
        category: 'function',
        severity: 'critical',
        summary: '模型版不应写进来',
        confidence: 0.95,
        evidence: ['被确认抢先'],
      }),
      model: 'fake-service/fake-model',
    });
    const body = (await expectJson(await pending, 201)) as Ingested;

    const after = await screeningOfMessage(connection, messageId);
    for (const column of [
      'category',
      'severity',
      'suggestedOwner',
      'summary',
      'confidence',
    ]) {
      expect(after[column], `${column} 不该被模型版改写`).toEqual(
        before[column],
      );
    }
    expect(after.reviewId, '确认记录指针应当还在').toBeTruthy();
    // 开关是开着的、模型没跑到；行里不许声称任何一种「已回落」的原因。
    expect(after.degradeReason).toBeNull();
    // 0 行更新不算成功：201 里也不能出现被丢弃的模型值。
    expect(body.data.screening).toMatchObject({
      engine: 'rules',
      category: before.category,
      severity: before.severity,
      summary: before.summary,
      confidence: before.confidence,
      degradeReason: null,
    });
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({ screeningId }),
      expect.stringContaining('matched no row'),
    );
  } finally {
    info.mockRestore();
  }
});

test('R-002 8: 规则版的行为不变：engine 是 rules、modelName 是 rule-baseline', async ({
  testApp,
  app,
  connection,
}) => {
  const account = await createIntakeAccount(app, {
    name: 'r002d-rules',
    knowledge: false,
  });
  // 模型没成时留在库里的仍是事务里写的那份规则版：类别、严重度与依据都取规则表。
  resetFake(async () => ({
    text: '不是 JSON',
    model: 'fake-service/fake-model',
  }));
  const content = '这批零件尺寸超差，装配不上';
  const response = await postIntake(
    testApp,
    account.secret,
    intakeBody(content),
  );
  const body = (await expectJson(response, 201)) as Ingested;
  const stored = await screeningOfMessage(connection, body.data.message.id);
  expect(stored).toMatchObject({
    category: 'dimension',
    severity: 'major',
    engine: 'rules',
    modelName: 'rule-baseline',
  });
});

test('R-002 10: 脱敏——常见写法都不进出站提示词，记录上 redacted 为真，提示词限定摘要来源', async ({
  testApp,
  app,
  connection,
}) => {
  const account = await createIntakeAccount(app, {
    name: 'r002d-redact',
    knowledge: false,
  });
  resetFake();
  const phone = digits('139', '0013', '9000');
  const hyphen = digits('139', '0013', '9000');
  const fullWidth = [...phone]
    .map((digit) => String.fromCharCode(digit.charCodeAt(0) + 0xfee0))
    .join('');
  const landline = hyphenatedLandline('010', '12345678');
  const prefixed = `+86 ${spacedMobile('139', '0013', '9000')}`;
  const email = 'customer@example.test';
  const senderName = '张三发件人';
  const senderContact = digits('138', '0013', '8000');
  const content =
    `尺寸超差，请联系 ${spacedMobile('139', '0013', '9000')}、` +
    `${hyphen.replace(/^(\d{3})(\d{4})(\d{4})$/u, '$1-$2-$3')}、` +
    `${fullWidth}、${landline} 或 ${prefixed}，也可以发 ${email}`;
  const response = await postIntake(
    testApp,
    account.secret,
    intakeBody(content, { senderName, senderContact }),
  );
  const body = (await expectJson(response, 201)) as Ingested;
  expect(fakeGateway.calls).toHaveLength(1);
  const request = fakeGateway.calls[0]!;
  for (const raw of [
    spacedMobile('139', '0013', '9000'),
    hyphen.replace(/^(\d{3})(\d{4})(\d{4})$/u, '$1-$2-$3'),
    fullWidth,
    landline,
    phone,
    prefixed,
  ]) {
    expect(request.prompt, `提示词不该含 ${raw}`).not.toContain(raw);
  }
  expect(request.prompt, '手机号应当被遮罩').toContain('139****9000');
  expect(request.prompt, '座机应当被遮罩').toContain('010-****5678');
  expect(request.prompt).not.toContain(email);
  expect(request.prompt).not.toContain(senderName);
  expect(request.prompt).not.toContain(senderContact);
  expect(
    request.system,
    '提示词要限定摘要与依据只能来自本次提交的正文',
  ).toContain('摘要与依据只能来自本次提交的正文');
  expect(
    (await screeningOfMessage(connection, body.data.message.id)).redacted,
  ).toBe(true);
});

test('R-002 10: redact 覆盖分隔符、全角、前缀与座机，编号与时间不动', async ({
  app,
}) => {
  const drafting: QualityDraftingService = app.container.resolve(
    qualityDraftingToken,
  );
  const pairs: readonly [string, string][] = [
    [digits('139', '0013', '9000'), '139****9000'],
    [spacedMobile('139', '0013', '9000'), '139****9000'],
    [
      `+86 ${spacedMobile('139', '0013', '9000')}`,
      '+86 139****9000',
    ],
    [
      `0086 ${spacedMobile('139', '0013', '9000')}`,
      '0086 139****9000',
    ],
    [
      [...digits('139', '0013', '9000')]
        .map((digit) => String.fromCharCode(digit.charCodeAt(0) + 0xfee0))
        .join(''),
      '139****9000',
    ],
    [hyphenatedLandline('010', '12345678'), '010-****5678'],
    ['customer@example.test', '***@example.test'],
  ];
  for (const [input, expected] of pairs) {
    expect(drafting.redact(input)).toEqual({ text: expected, redacted: true });
  }
  for (const untouched of [
    '550 5.1.1',
    'INV-2024-001',
    '2026-11-25 14:30:00',
    'https://example.com/orders/13812345678',
  ]) {
    expect(drafting.redact(untouched)).toEqual({
      text: untouched,
      redacted: false,
    });
  }
});

test('R-002 13: 投递的服务账号持 read.related 时 knowledgeRefs 有 kb 项；不持有时为空且投递照常成功', async ({
  testApp,
  app,
  connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  // 用一组在别的测试里不出现的词，避免「相似案例」把 knowledgeRefs 撑起来：
  // 这一条只验知识库那一段。别的案例都围绕「尺寸超差」。
  const knowledge = app.container.resolve(knowledgeToken);
  await knowledge.docs.create(
    { userId: admin.user.id },
    {
      scope: 'quality',
      scopeId: 'standards',
      title: '镀层起泡判定口径',
      content: '镀层起泡的判定：表面出现起泡即判外观缺陷，严重度按面积大小定级。',
    },
  );

  const reader = await createIntakeAccount(app, {
    name: 'r002d-kb-reader',
    knowledge: true,
  });
  const stranger = await createIntakeAccount(app, {
    name: 'r002d-kb-stranger',
    knowledge: false,
  });

  resetFake();
  const content = '镀层 起泡';
  const read = (await expectJson(
    await postIntake(testApp, reader.secret, intakeBody(content)),
    201,
  )) as Ingested;
  const withKnowledge = await screeningOfMessage(
    connection,
    read.data.message.id,
  );
  const refs = withKnowledge.knowledgeRefs as unknown;
  expect(Array.isArray(refs), 'knowledgeRefs 应当是数组').toBe(true);
  expect(
    (refs as string[]).length,
    '持 read.related 且标准命中的投递应当有 knowledgeRefs',
  ).toBeGreaterThan(0);
  expect(
    (refs as string[]).every((ref) => ref.startsWith('kb:')),
    '没有案例范围时只有 kb: 项',
  ).toBe(true);
  expect(
    fakeGateway.calls.at(-1)?.prompt ?? '',
    '提示词应当带上命中的段落',
  ).toContain('镀层起泡');

  resetFake();
  const denied = (await expectJson(
    await postIntake(testApp, stranger.secret, intakeBody('包装箱 受潮')),
    201,
  )) as Ingested;
  const withoutKnowledge = await screeningOfMessage(
    connection,
    denied.data.message.id,
  );
  expect(withoutKnowledge.knowledgeRefs).toEqual([]);
});

test('R-002 E3/E4: 相似案例走读者的范围；范围外的正文不进提示词，案例正文先脱敏', async ({
  testApp,
  app,
  connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const inScopePhone = spacedMobile('139', '0013', '9000');
  const outOfScopePhone = spacedMobile('137', '0013', '7000');
  const inScopeMessage = randomUUID();
  const outOfScopeMessage = randomUUID();
  await insertMessage(connection, {
    id: inScopeMessage,
    content: `镀层起泡 联系电话 ${inScopePhone}`,
  });
  await insertMessage(connection, {
    id: outOfScopeMessage,
    content: `镀层起泡 联系电话 ${outOfScopePhone}`,
  });
  const inScope = screeningFixture({
    id: 'r002d-case-in',
    messageId: inScopeMessage,
  });
  const outOfScope = screeningFixture({
    id: 'r002d-case-out',
    messageId: outOfScopeMessage,
  });
  await connection.repository('fqcScreenings').createMany({
    values: [inScope, outOfScope],
  });
  const reviewValues = [inScope, outOfScope].map((screening) => ({
    id: randomUUID(),
    screeningId: String(screening.id),
    kind: 'confirm',
    category: 'appearance',
    severity: 'minor',
    departmentId: null,
    actorId: admin.user.id,
    createdAt: new Date(),
  }));
  await connection
    .repository('fqcScreeningReviews')
    .createMany({ values: reviewValues });

  const user = await createUser(admin, 'r002dcases', { app: [] });
  const authz = app.container.resolve(authorizationToken);
  await authz.permissionSets.create({
    key: 'r002d-cases',
    grants: [
      intakeGrant,
      {
        resource: { type: 'composite', id: 'fqc' },
        actions: [
          {
            action: 'view',
            policy: {
              type: 'composite',
              scopes: {
                fqcMessages: 'allRecords',
                // 只看得到范围内那一条初筛：相似案例也只能从它来。
                fqcScreenings: { type: 'records', ids: [inScope.id] },
                fqcTickets: 'allRecords',
                fqcScreeningReviews: 'allRecords',
              },
            },
          },
        ],
      },
    ],
  });
  await authz.permissionSets.assign({
    subject: { type: 'user', id: user.id },
    permissionSet: 'r002d-cases',
  });
  const session = await signInAs(testApp, 'r002dcases');
  resetFake();
  const response = await session.fetch(
    '/quality/intake',
    json(intakeBody('镀层起泡 客户投诉')),
  );
  const body = (await expectJson(response, 201)) as Ingested;
  const request = fakeGateway.calls.at(-1)!;
  expect(request.prompt).toContain('镀层起泡');
  expect(request.prompt).toContain('139****9000');
  expect(request.prompt, '案例正文应当先脱敏').not.toContain(inScopePhone);
  expect(
    request.prompt,
    '范围外的案例正文不该进提示词',
  ).not.toContain(outOfScopePhone);
  expect(request.prompt, '范围外的号码也不该以遮罩形态出现').not.toContain(
    '137****7000',
  );
  expect(
    request.system,
    '提示词要限定摘要与依据只能来自本次提交的正文',
  ).toContain('摘要与依据只能来自本次提交的正文');

  const stored = await screeningOfMessage(connection, body.data.message.id);
  const refs = stored.knowledgeRefs as string[];
  expect(refs).toContain(`case:${String(inScope.id)}`);
  expect(refs).not.toContain(`case:${String(outOfScope.id)}`);
});

test('R-002 3: 模型版写入只改十五列里的那些，reviewId 与 messageId 不变', async ({
  testApp,
  app,
  connection,
}) => {
  const account = await createIntakeAccount(app, {
    name: 'r002d-columns',
    knowledge: false,
  });
  resetFake();
  const content = '列清单 尺寸超差';
  const body = (await expectJson(
    await postIntake(testApp, account.secret, intakeBody(content)),
    201,
  )) as Ingested;
  const stored = await screeningOfMessage(connection, body.data.message.id);
  expect(stored).toMatchObject({
    engine: 'model',
    modelName: 'fake-service/fake-model',
    category: 'dimension',
    severity: 'major',
    degraded: false,
    degradeReason: null,
    reviewId: null,
    messageId: body.data.message.id,
  });
  expect(stored.promptVersion).toBe('fqc-draft-1');
  // 201 拼的是写进去的值：与随后从列表读到的同一条逐字段一致（时间与置信度按列的形态）。
  expect(body.data.screening).toMatchObject({
    engine: 'model',
    promptVersion: 'fqc-draft-1',
    degraded: false,
    degradeReason: null,
    modelName: 'fake-service/fake-model',
    outcome: 'auto',
    updatedAt: stored.updatedAt,
    confidence: stored.confidence,
    category: stored.category,
    severity: stored.severity,
  });
});
