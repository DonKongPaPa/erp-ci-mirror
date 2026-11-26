import { randomUUID } from 'node:crypto';

import { authorizationToken } from '@nocobase/app-plugin-authorization';
import {
  DEFAULT_ADMIN_CREDENTIALS,
  signIn,
  type SignInTarget,
  type TestSession,
} from '@nocobase/app-plugin-authentication/testing';
import type { DatabaseConnection } from '@nocobase/db';
import {
  createAppTest,
  openTestDatabaseAdmin,
  testDatabaseSchemaNames,
} from '../helpers/test-app.js';
import { describe, expect } from 'vitest';

import { createStandaloneServer } from '../../server/standalone.js';
import { ScreeningReviewResultSchema } from '../../server/routes/schemas.js';

/**
 * R-002 验收 9、14、15（后半）与 16 的运行期部分：人工确认不再改写草稿、确认记录
 * 只追加、代填效果的统计，以及统计不扩大暴露面。
 *
 * 确认的旧语义（原地改草稿五列）在 `tests/server/quality-authorization.test.ts` 与客户端
 * 的那条确认测试里也有断言；这里钉住新语义的每一件：草稿逐字不变、确认记录多一行、
 * `outcome` 与 `reviewId` 指过去、响应里的 `review` 与库里最近一行逐字段相同。
 *
 * 统计的夹具直接写库（不经过端点），因为端点只读；范围用一个只放两行初筛的权限集
 * 钉住，范围之外的行不计入。
 */
const test = createAppTest({
  // 每个测试一台干净的应用与库：这里数的是绝对条数（确认记录的行数、统计的总数），
  // 同一个文件共享一台应用时，前一条测试的行会把它们数进去。
  scope: 'test',
  createServer: createStandaloneServer,
  config: {
    app: { publicOrigin: 'http://localhost' },
    auth: { secret: 'test-auth-secret-at-least-32-characters' },
  },
});

const PASSWORD = 'R002-review-123!';
const ACTOR_ID = 'r002-review-actor';

interface ApiErrorBody {
  error: {
    code: number;
    status: string;
    reason: string;
    domain: string;
    message: string;
  };
}

interface ScreeningRow extends Record<string, unknown> {
  id: string;
  category: string | null;
  severity: string | null;
  suggestedOwner: string | null;
  summary: string | null;
  confidence: string | null;
  evidence: unknown;
  modelName: string | null;
  outcome: string;
  engine: string;
  promptVersion: string | null;
  degraded: boolean;
  degradeReason: string | null;
  knowledgeRefs: unknown;
  redacted: boolean;
  reviewId: string | null;
  createdAt: string;
  updatedAt: string;
}

interface ReviewRow extends Record<string, unknown> {
  id: string;
  screeningId: string;
  kind: string;
  category: string;
  severity: string;
  departmentId: string | null;
  actorId: string;
  createdAt: string;
}

interface StatsBody {
  data: {
    from: string;
    to: string;
    total: number;
    engines: Record<string, number>;
    degradeReasons: Record<string, number>;
    redacted: number;
    confirmed: number;
    agreement: {
      category: { matched: number; mismatched: number };
      severity: { matched: number; mismatched: number };
    };
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

const signInAs = (app: SignInTarget, username: string) =>
  signIn(app, { username, password: PASSWORD });

/** 一条初筛：默认是规则版、待复核；覆盖项用来造统计夹具。 */
const screeningValues = (
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> => {
  const id = (overrides.id as string | undefined) ?? randomUUID();
  const createdAt = overrides.createdAt ?? new Date('2026-11-15T10:00:00');
  return {
    id,
    messageId: `message-${id}`,
    category: 'dimension',
    severity: 'major',
    suggestedOwner: 'quality-dimension',
    summary: '尺寸超差',
    confidence: '0.7500',
    evidence: ['尺寸', '超差'],
    modelName: 'rule-baseline',
    outcome: 'needs-review',
    engine: 'rules',
    promptVersion: null,
    degraded: false,
    degradeReason: 'model-disabled',
    knowledgeRefs: [],
    redacted: false,
    reviewId: null,
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  };
};

const insertScreening = async (
  connection: DatabaseConnection,
  overrides: Partial<Record<string, unknown>> = {},
): Promise<ScreeningRow> => {
  const values = screeningValues(overrides);
  await connection.repository('fqcScreenings').createOne({ values });
  return values as unknown as ScreeningRow;
};

const insertReview = async (
  connection: DatabaseConnection,
  screening: ScreeningRow,
  overrides: Partial<Record<string, unknown>> = {},
): Promise<ReviewRow> => {
  const values = {
    id: randomUUID(),
    screeningId: screening.id,
    kind: 'confirm',
    category: screening.category,
    severity: screening.severity,
    departmentId: 'department-r002',
    actorId: ACTOR_ID,
    createdAt: new Date('2026-11-16T09:00:00'),
    ...overrides,
  };
  await connection.repository('fqcScreeningReviews').createOne({ values });
  return values as unknown as ReviewRow;
};

const reviewPath = (id: string) => `/quality/screenings/${id}/review`;

const statsPath = (from?: string, to?: string) => {
  const search = new URLSearchParams();
  if (from !== undefined) search.set('from', from);
  if (to !== undefined) search.set('to', to);
  const query = search.toString();
  return `/quality/drafting/stats${query ? `?${query}` : ''}`;
};

test('R-002 9: 确认不改写草稿，只追加一行确认记录，响应里的 review 就是库里那一行', async ({
  testApp,
  connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const manager = await createUser(admin, 'r002confirmmanager', {
    app: ['quality_manager'],
  });
  const session = await signInAs(testApp, 'r002confirmmanager');

  const before = await insertScreening(connection, {
    outcome: 'needs-review',
    category: 'dimension',
    severity: 'major',
    suggestedOwner: 'quality-dimension',
    summary: '草稿摘要',
    confidence: '0.4500',
    evidence: ['公差'],
    modelName: 'rule-baseline',
    engine: 'rules',
    promptVersion: 'fqc-draft-1',
    degraded: false,
    degradeReason: 'model-disabled',
    knowledgeRefs: ['kb:quality/standards#dimension'],
    redacted: true,
  });
  const storedBefore = await connection
    .repository('fqcScreenings')
    .findOne({ filter: { id: before.id } });
  expect(storedBefore, '夹具初筛没写进去').toBeDefined();

  const response = (await expectJson(
    await session.fetch(
      reviewPath(before.id),
      json({
        category: 'appearance',
        severity: 'critical',
        departmentId: 'department-r002',
      }),
    ),
    200,
  )) as {
    data: ScreeningRow & { review: ReviewRow & { actorName?: string } };
  };

  // 响应是初筛那一行多出 review。
  expect(response.data.id).toBe(before.id);
  expect(response.data.outcome).toBe('reviewed');
  expect(response.data.review).toBeDefined();
  expect(response.data.review.screeningId).toBe(before.id);
  expect(response.data.review.kind).toBe('confirm');
  expect(response.data.review.category).toBe('appearance');
  expect(response.data.review.severity).toBe('critical');
  expect(response.data.review.departmentId).toBe('department-r002');
  expect(response.data.review.actorId).toBe(manager.id);
  expect(response.data.reviewId).toBe(response.data.review.id);

  // 确认记录只追加：库里那几列与响应逐字段相同，姓名是响应多出的解析列。
  const storedReview = await connection
    .repository('fqcScreeningReviews')
    .findOne({ filter: { id: response.data.review.id } });
  const { actorName, ...storedShape } = response.data.review;
  expect(actorName, '确认响应的姓名来自会话账号').toBe('r002confirmmanager');
  expect(storedReview, '确认记录没有写进库').toEqual(storedShape);

  // 草稿的列逐字不变，只有 outcome / reviewId / updatedAt 变了。
  const storedAfter = await connection
    .repository('fqcScreenings')
    .findOne({ filter: { id: before.id } });
  expect(storedAfter).toBeDefined();
  for (const field of [
    'category',
    'severity',
    'suggestedOwner',
    'summary',
    'confidence',
    'evidence',
    'modelName',
    'engine',
    'promptVersion',
    'degraded',
    'degradeReason',
    'knowledgeRefs',
    'redacted',
    'createdAt',
  ]) {
    expect(storedAfter?.[field], `确认之后草稿的 ${field} 被改了`).toEqual(
      storedBefore?.[field],
    );
  }
  expect(storedAfter?.outcome).toBe('reviewed');
  expect(storedAfter?.reviewId).toBe(response.data.review.id);
  expect(storedAfter?.updatedAt).not.toBe(storedBefore?.updatedAt);

  // 再确认一次：又多一行，reviewId 指向新的；空请求体用草稿的值（草稿没有被上一次确认改掉）。
  const second = (await expectJson(
    await session.fetch(reviewPath(before.id), json({})),
    200,
  )) as {
    data: ScreeningRow & { review: ReviewRow & { actorName?: string } };
  };
  expect(second.data.review.id).not.toBe(response.data.review.id);
  expect(second.data.reviewId).toBe(second.data.review.id);
  expect(
    second.data.review.category,
    '第二次确认应当用草稿的类别，而不是上一次确认的值',
  ).toBe('dimension');
  expect(second.data.review.severity).toBe('major');
  expect(second.data.review.departmentId).toBeNull();
  expect(
    await connection.repository('fqcScreeningReviews').count(),
    '两次确认应当有两行',
  ).toBe(2);
});

test('R-002 9: 只持查看的人确认被拒，且一行确认记录都不写', async ({
  testApp,
  connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  await createUser(admin, 'r002reviewdept', { app: ['dept_manager'] });
  const session = await signInAs(testApp, 'r002reviewdept');
  const screening = await insertScreening(connection);

  const refused = await session.fetch(reviewPath(screening.id), json({}));
  const error = await expectError(refused, 403);
  expect(error.status, '应当是 PERMISSION_DENIED').toBe('PERMISSION_DENIED');
  expect(error.reason, '应当以 AUTHORIZATION_DENIED 被拒').toBe(
    'AUTHORIZATION_DENIED',
  );
  expect(
    await connection.repository('fqcScreeningReviews').count(),
    '被拒的确认不该写确认记录',
  ).toBe(0);
  expect(
    await connection.repository('fqcScreenings').findOne({
      filter: { id: screening.id },
    }),
  ).toMatchObject({ outcome: 'needs-review', reviewId: null });
});

test('R-002 9: 类别或严重度不在取值里时 400，草稿与确认记录都不动', async ({
  testApp,
  connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  await createUser(admin, 'r002reviewinvalid', { app: ['quality_manager'] });
  const session = await signInAs(testApp, 'r002reviewinvalid');
  const screening = await insertScreening(connection);

  for (const body of [
    { category: 'not-a-category' },
    { severity: 'blocker' },
  ]) {
    await expectError(
      await session.fetch(reviewPath(screening.id), json(body)),
      400,
    );
  }
  expect(await connection.repository('fqcScreeningReviews').count()).toBe(0);
  expect(
    await connection.repository('fqcScreenings').findOne({
      filter: { id: screening.id },
    }),
  ).toMatchObject({ outcome: 'needs-review' });
});

test('R-002 14: 统计给出各引擎、回落原因、脱敏与类别/严重度的一致数', async ({
  testApp,
  connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  await createUser(admin, 'r002statsmanager', { app: ['quality_manager'] });
  const session = await signInAs(testApp, 'r002statsmanager');

  const from = '2026-11-01T00:00:00.000Z';
  const to = '2026-11-30T23:59:59.999Z';
  const inRange = (day: number) =>
    new Date(`2026-11-${String(day).padStart(2, '0')}T10:00:00`);

  // 十条已确认：六条类别一致、四条不一致；七条严重度一致、三条不一致。
  // 八条规则版（五条 model-disabled、三条 model-error），两条模型版；两条脱敏。
  for (let index = 0; index < 10; index += 1) {
    const model = index >= 8;
    const screening = await insertScreening(connection, {
      id: `r002-stats-${index}`,
      createdAt: inRange(index + 1),
      updatedAt: inRange(index + 1),
      engine: model ? 'model' : 'rules',
      modelName: model ? 'test-gateway-model' : 'rule-baseline',
      degraded: !model && index >= 5,
      degradeReason: model
        ? null
        : index < 5
          ? 'model-disabled'
          : 'model-error',
      redacted: index < 2,
      category: 'dimension',
      severity: 'major',
    });
    await insertReview(connection, screening, {
      id: `r002-stats-review-${index}`,
      category: index < 6 ? 'dimension' : 'appearance',
      severity: index < 7 ? 'major' : 'minor',
      departmentId: `department-${index}`,
    });
  }

  // 没有确认记录的行不计入一致/不一致；范围之外的行整条不计入。
  const unreviewed = await insertScreening(connection, {
    id: 'r002-stats-unreviewed',
    createdAt: inRange(20),
    updatedAt: inRange(20),
    degradeReason: 'model-disabled',
  });
  expect(unreviewed.id).toBe('r002-stats-unreviewed');
  await insertScreening(connection, {
    id: 'r002-stats-out-of-range',
    createdAt: new Date('2026-10-01T10:00:00'),
    updatedAt: new Date('2026-10-01T10:00:00'),
    degradeReason: 'timeout',
  });

  const body = (await expectJson(
    await session.fetch(statsPath(from, to)),
    200,
  )) as StatsBody;

  expect(body.data.from).toBe(from);
  expect(body.data.to).toBe(to);
  expect(body.data.total).toBe(11);
  expect(body.data.engines).toEqual({ rules: 9, model: 2 });
  expect(body.data.degradeReasons).toEqual({
    'model-disabled': 6,
    'model-not-configured': 0,
    'model-error': 3,
    timeout: 0,
    'invalid-output': 0,
  });
  expect(body.data.redacted).toBe(2);
  expect(body.data.confirmed).toBe(10);
  expect(body.data.agreement).toEqual({
    category: { matched: 6, mismatched: 4 },
    severity: { matched: 7, mismatched: 3 },
  });
});

test('R-002 14: 范围受限的人只统计到自己范围之内的行', async ({
  testApp,
  app,
  connection,
}) => {
  const authz = app.container.resolve(authorizationToken);
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);

  const allowed = await insertScreening(connection, {
    id: 'r002-scope-allowed',
  });
  await insertReview(connection, allowed, { category: 'dimension' });
  const excluded = await insertScreening(connection, {
    id: 'r002-scope-excluded',
    degradeReason: 'model-error',
  });
  await insertReview(connection, excluded, { category: 'appearance' });

  const scopedUser = await createUser(admin, 'r002statsscoped', { app: [] });
  await authz.permissionSets.create({
    key: 'r002-stats-scoped',
    grants: [
      {
        resource: { type: 'composite', id: 'fqc' },
        actions: [
          {
            action: 'view',
            policy: {
              type: 'composite',
              scopes: {
                fqcMessages: 'allRecords',
                fqcScreenings: { type: 'records', ids: [allowed.id] },
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
    subject: { type: 'user', id: scopedUser.id },
    permissionSet: 'r002-stats-scoped',
  });

  const session = await signInAs(testApp, 'r002statsscoped');
  const body = (await expectJson(
    await session.fetch(
      statsPath('2026-11-01T00:00:00.000Z', '2026-11-30T23:59:59.999Z'),
    ),
    200,
  )) as StatsBody;
  expect(body.data.total, '只该算到范围之内的那一行').toBe(1);
  expect(body.data.confirmed).toBe(1);
  expect(body.data.agreement.category).toEqual({ matched: 1, mismatched: 0 });
  expect(body.data.degradeReasons['model-error']).toBe(0);
});

test('R-002 14: 同一份草稿确认两次时，统计只用较晚那一行', async ({
  testApp,
  connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  await createUser(admin, 'r002latestmanager', { app: ['quality_manager'] });
  const session = await signInAs(testApp, 'r002latestmanager');

  // A：先确认成 dimension（与草稿一致），后确认成 appearance（不一致）。
  const a = await insertScreening(connection, {
    id: 'r002-latest-a',
    createdAt: new Date('2026-11-05T10:00:00'),
    updatedAt: new Date('2026-11-05T10:00:00'),
  });
  await insertReview(connection, a, {
    id: 'r002-latest-a-old',
    category: 'dimension',
    severity: 'major',
    createdAt: new Date('2026-11-10T09:00:00.000'),
  });
  await insertReview(connection, a, {
    id: 'r002-latest-a-new',
    category: 'appearance',
    severity: 'major',
    createdAt: new Date('2026-11-10T09:00:01.000'),
  });

  // B：两行同一毫秒。设计只写「最近一行」，同一毫秒没有先后，这里按 id 降序决胜；
  // 用固定 id 钉住这个决胜规则，改排序方向时这条会红。
  const b = await insertScreening(connection, {
    id: 'r002-latest-b',
    createdAt: new Date('2026-11-05T11:00:00'),
    updatedAt: new Date('2026-11-05T11:00:00'),
  });
  const sameMoment = new Date('2026-11-10T10:00:00.000');
  await insertReview(connection, b, {
    id: 'r002-latest-b-a',
    category: 'dimension',
    severity: 'major',
    createdAt: sameMoment,
  });
  await insertReview(connection, b, {
    id: 'r002-latest-b-z',
    category: 'appearance',
    severity: 'major',
    createdAt: sameMoment,
  });

  const body = (await expectJson(
    await session.fetch(
      statsPath('2026-11-01T00:00:00.000Z', '2026-11-30T23:59:59.999Z'),
    ),
    200,
  )) as StatsBody;
  expect(body.data.total).toBe(2);
  expect(body.data.confirmed, '每份草稿只算最近一行').toBe(2);
  expect(
    body.data.agreement.category,
    '两次确认应当取较晚那一行（同毫秒按 id 降序）',
  ).toEqual({ matched: 0, mismatched: 2 });
  expect(body.data.agreement.severity).toEqual({ matched: 2, mismatched: 0 });
});

test('R-002 14: 确认记录表没有读范围时，统计把确认记录当空数组', async ({
  testApp,
  app,
  connection,
}) => {
  const authz = app.container.resolve(authorizationToken);
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const scoped = await insertScreening(connection, {
    id: 'r002-no-review-read',
  });
  await insertReview(connection, scoped, { category: 'dimension' });

  const user = await createUser(admin, 'r002noreviewread', { app: [] });
  await authz.permissionSets.create({
    key: 'r002-no-review-read',
    grants: [
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
                // 空串表示「什么都不选」：底层把确认记录表的读折成 false。
                fqcScreeningReviews: '',
              },
            },
          },
        ],
      },
    ],
  });
  await authz.permissionSets.assign({
    subject: { type: 'user', id: user.id },
    permissionSet: 'r002-no-review-read',
  });

  const session = await signInAs(testApp, 'r002noreviewread');
  const body = (await expectJson(
    await session.fetch(
      statsPath('2026-11-01T00:00:00.000Z', '2026-11-30T23:59:59.999Z'),
    ),
    200,
  )) as StatsBody;
  expect(body.data.total, '草稿仍算得出条数').toBe(1);
  expect(
    body.data.confirmed,
    '读不到确认记录时应当当成空数组，而不是 403 或 500',
  ).toBe(0);
  expect(body.data.agreement).toEqual({
    category: { matched: 0, mismatched: 0 },
    severity: { matched: 0, mismatched: 0 },
  });
});

test('R-002 14: 没有查看权限的人 403；区间不合法时 400', async ({
  testApp,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  await createUser(admin, 'r002statsstaff', { app: ['staff'] });
  await createUser(admin, 'r002statsvalidation', { app: ['quality_manager'] });
  const staff = await signInAs(testApp, 'r002statsstaff');
  const manager = await signInAs(testApp, 'r002statsvalidation');

  const from = '2026-11-01T00:00:00.000Z';
  const to = '2026-11-30T23:59:59.999Z';
  const refused = await staff.fetch(statsPath(from, to));
  const denied = await expectError(refused, 403);
  expect(denied.reason).toBe('AUTHORIZATION_DENIED');

  // 缺一端、起点晚于终点、跨度超过一年：都是 400。
  for (const path of [
    statsPath(undefined, to),
    statsPath(from, undefined),
    statsPath(to, from),
    statsPath('2025-01-01T00:00:00.000Z', '2026-02-02T00:00:00.000Z'),
  ]) {
    await expectError(await manager.fetch(path), 400);
  }

  // 区间内的计数确实存在，证明确实是区间不合法而不是端点整体不可用。
  await expectJson(await manager.fetch(statsPath(from, to)), 200);
});

/**
 * 并发确认（只在真 Postgres 上跑）：两个人同时确认同一份初筛。
 *
 * SQLite 复现不出来（写事务串行）。这里用一条外部事务先把初筛那一行 `FOR UPDATE`
 * 锁住，两个确认请求会先后完成「读初筛 + 写确认记录」，然后一起停在 CAS 更新上；
 * 等 `pg_stat_activity` 里两个后台都在等锁，放锁：一个更新成功，另一个的
 * `WHERE reviewId = <它读到的值>` 不再匹配，得到 409，它写的确认记录随事务回滚。
 */
describe.skipIf(process.env.NOCOBASE_TEST_DB_DIALECT !== 'postgres')(
  'R-002 并发确认（SQLite 复现不出来）',
  () => {
    test(
      'R-002 9: 同时确认同一份初筛时，一个 200、一个 409，库里只留一行',
      { timeout: 40_000 },
      async ({ testApp, connection }) => {
        const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
        await createUser(admin, 'r002racea', { app: ['quality_manager'] });
        await createUser(admin, 'r002raceb', { app: ['quality_manager'] });
        const firstSession = await signInAs(testApp, 'r002racea');
        const secondSession = await signInAs(testApp, 'r002raceb');
        const screening = await insertScreening(connection, {
          id: 'r002-race-screening',
          outcome: 'needs-review',
        });

        const [schema] = testDatabaseSchemaNames(testApp);
        const db = await openTestDatabaseAdmin(testApp);
        const lock = await db.client.transaction();
        let released = false;
        try {
          await lock.raw(
            `SELECT 1 FROM "${schema}"."fqc_screenings" WHERE id = ? FOR UPDATE`,
            [screening.id],
          );
          const requests = [
            firstSession.fetch(
              reviewPath(screening.id),
              json({ category: 'appearance', severity: 'major' }),
            ),
            secondSession.fetch(
              reviewPath(screening.id),
              json({ category: 'dimension', severity: 'minor' }),
            ),
          ];

          // 两个请求都走到 CAS 更新之前不读它们：先等两个后台都排在行锁上。
          const deadline = Date.now() + 20_000;
          let waiting = 0;
          while (Date.now() < deadline) {
            const result = (await db.client.raw(
              `SELECT count(*)::int AS waiting FROM pg_stat_activity ` +
                `WHERE state = 'active' AND wait_event_type = 'Lock' ` +
                `AND query ILIKE '%fqc_screenings%'`,
            )) as { rows?: { waiting: number }[] };
            waiting = Number(result.rows?.[0]?.waiting ?? 0);
            if (waiting >= 2) {
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, 25));
          }
          expect(
            waiting,
            '两个确认请求没有都停在初筛的行锁上，不能证明并发',
          ).toBeGreaterThanOrEqual(2);

          await lock.commit();
          released = true;

          const responses = await Promise.all(requests);
          const outcomes = await Promise.all(
            responses.map(async (response) => ({
              status: response.status,
              body: JSON.parse(await response.text()) as {
                data?: { reviewId: string; review: unknown };
                error?: { reason: string };
              },
            })),
          );
          expect(outcomes.map((outcome) => outcome.status).sort()).toEqual([
            200, 409,
          ]);
          const winner = outcomes.find((outcome) => outcome.status === 200);
          const loser = outcomes.find((outcome) => outcome.status === 409);
          expect(loser?.body.error?.reason).toBe('SCREENING_REVIEW_CONFLICT');

          const rows = await connection
            .repository('fqcScreeningReviews')
            .findMany({ filter: { screeningId: screening.id } });
          expect(rows.length, '输掉的确认不该留下确认记录').toBe(1);
          const stored = await connection
            .repository('fqcScreenings')
            .findOne({ filter: { id: screening.id } });
          const winnerReviewId = winner?.body.data?.reviewId;
          expect(winnerReviewId).toBeDefined();
          expect(stored?.reviewId, '库里的 reviewId 应当是赢家的那一行').toBe(
            winnerReviewId,
          );
          expect(rows[0]?.id).toBe(winnerReviewId);
          const winnerReview = winner?.body.data?.review as
            | (Record<string, unknown> & { actorName?: string })
            | undefined;
          expect(
            winnerReview?.actorName,
            '并发确认的响应也带确认人姓名',
          ).toContain('r002race');
          const { actorName: _actorName, ...storedShape } = winnerReview ?? {};
          expect(
            storedShape,
            '先返回的响应里的 review 除姓名外应当与库里那一行一致',
          ).toEqual(rows[0]);
        } finally {
          if (!released) {
            await lock.rollback().catch(() => undefined);
          }
          await db.close();
        }
      },
    );
  },
);

/** 一次统计的返回形状：只有汇总的数字，没有任何消息内容或发件人字段。 */
const STATS_KEYS = [
  'agreement',
  'confirmed',
  'degradeReasons',
  'engines',
  'from',
  'redacted',
  'to',
  'total',
];

test('R-002 15: 统计不扩大暴露面，也不存在返回相似案例正文的端点', async ({
  testApp,
  connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  await createUser(admin, 'r002statsprivacy', { app: ['quality_manager'] });
  const session = await signInAs(testApp, 'r002statsprivacy');

  const marker = '某位客户的具体联系方式 138-0000-' + '0000';
  const messageId = randomUUID();
  await connection.repository('fqcMessages').createOne({
    values: {
      id: messageId,
      channel: 'wechat',
      externalId: null,
      senderName: 'R-002 发件人姓名',
      senderContact: 'sender-contact@example.test',
      content: marker,
      rawContentType: 'text',
      receivedAt: new Date('2026-11-15T10:00:00'),
      // R-026：反馈单的状态只有 open 与 discarded；测试夹具跟设计走。
      status: 'open',
      createdAt: new Date('2026-11-15T10:00:00'),
      updatedAt: new Date('2026-11-15T10:00:00'),
    },
  });
  const screening = await insertScreening(connection, { messageId });
  await insertReview(connection, screening);

  const response = await session.fetch(
    statsPath('2026-11-01T00:00:00.000Z', '2026-11-30T23:59:59.999Z'),
  );
  const text = await response.text();
  expect(response.status, `${text}`).toBe(200);
  const body = JSON.parse(text) as StatsBody;
  expect(Object.keys(body.data).sort(), '统计只回设计的那些汇总项').toEqual(
    STATS_KEYS,
  );
  expect(Object.keys(body.data.agreement).sort()).toEqual([
    'category',
    'severity',
  ]);
  expect(Object.keys(body.data.engines).sort()).toEqual(['model', 'rules']);
  expect(Object.keys(body.data.degradeReasons).sort()).toEqual([
    'invalid-output',
    'model-disabled',
    'model-error',
    'model-not-configured',
    'timeout',
  ]);
  for (const leaked of [
    marker,
    'R-002 发件人姓名',
    'sender-contact@example.test',
  ]) {
    expect(text, `统计的返回里出现了不该出现的 ${leaked}`).not.toContain(
      leaked,
    );
  }

  // 相似案例只在服务内部用：没有任何 HTTP 端点返回它的结果。
  for (const path of [
    '/quality/drafting/similar-cases',
    '/quality/drafting/cases',
    '/quality/screenings/similar',
  ]) {
    const unknown = await session.fetch(path);
    await unknown.text();
    expect(unknown.status, `${path} 不应当存在`).toBe(404);
  }
});

/* 列表随行确认记录（刷新之后仍可见）：只随请求自己的范围读，姓名只给姓名。 */
interface ListBody {
  data: (ScreeningRow & {
    canReview: boolean;
    review: (ReviewRow & { actorName: string }) | null;
  })[];
  meta: { page: number; pageSize: number; total: number };
}

const LIST_PATH = '/quality/screenings';
const UNKNOWN_ACTOR_NAME = '—';
const REVIEW_KEYS = [
  'actorId',
  'actorName',
  'category',
  'createdAt',
  'departmentId',
  'id',
  'kind',
  'screeningId',
  'severity',
];

/** 姓名与登录名不同，钉住「解析出来的是姓名，不是账号」。 */
const createNamedActor = async (
  admin: TestSession,
  name: string,
  username: string,
): Promise<{ id: string }> => {
  const response = await admin.fetch(
    '/users',
    json({
      name,
      username,
      email: `${username}@example.test`,
      password: PASSWORD,
      roleScopes: { app: [] },
    }),
  );
  const text = await response.text();
  expect(response.status, `${text}`).toBe(201);
  return (JSON.parse(text) as { data: { id: string } }).data;
};

test('R-002 list: 列表随行带最近一次确认记录，多次确认取最近一次', async ({
  testApp,
  connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  await createUser(admin, 'r002listmanager', { app: ['quality_manager'] });
  const earlierActor = await createNamedActor(
    admin,
    '早期确认人',
    'r002listearlylogin',
  );
  const latestActor = await createNamedActor(
    admin,
    '最近确认人',
    'r002listlatestlogin',
  );
  const earlierId = randomUUID();
  const latestId = randomUUID();
  const screening = await insertScreening(connection, {
    id: 'r002-list-latest',
    outcome: 'reviewed',
    reviewId: latestId,
  });
  await insertReview(connection, screening, {
    id: earlierId,
    actorId: earlierActor.id,
    category: 'dimension',
    severity: 'minor',
    createdAt: new Date('2026-11-20T09:00:00Z'),
  });
  await insertReview(connection, screening, {
    id: latestId,
    actorId: latestActor.id,
    category: 'appearance',
    severity: 'critical',
    createdAt: new Date('2026-11-21T09:00:00Z'),
  });

  const session = await signInAs(testApp, 'r002listmanager');
  const body = (await expectJson(
    await session.fetch(LIST_PATH),
    200,
  )) as ListBody;
  const row = body.data.find((item) => item.id === screening.id);
  expect(row, '列表里要有这条初筛').toBeDefined();
  expect(row?.review, '已确认的行要随行带确认记录').not.toBeNull();
  const review = row!.review!;
  expect(review.id, '多次确认只取最近一次').toBe(latestId);
  expect(review.category).toBe('appearance');
  expect(review.severity).toBe('critical');
  expect(review.actorId).toBe(latestActor.id);
  expect(review.actorName, '确认人显示姓名').toBe('最近确认人');
  expect(Object.keys(review).sort(), '确认记录只多出一个姓名列').toEqual(
    REVIEW_KEYS,
  );
  expect(JSON.stringify(review)).not.toContain('r002listlatestlogin');
});

test('R-002 list: 读者读不到确认记录时这一段为空，不报错', async ({
  testApp,
  app,
  connection,
}) => {
  const authz = app.container.resolve(authorizationToken);
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const user = await createUser(admin, 'r002listnoread', { app: [] });
  await authz.permissionSets.create({
    key: 'r002-list-no-review-read',
    grants: [
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
                // 空串把确认记录表的读折成 false。
                fqcScreeningReviews: '',
              },
            },
          },
        ],
      },
    ],
  });
  await authz.permissionSets.assign({
    subject: { type: 'user', id: user.id },
    permissionSet: 'r002-list-no-review-read',
  });

  const screening = await insertScreening(connection, {
    id: 'r002-list-no-read',
    outcome: 'reviewed',
    reviewId: 'r002-list-no-read-review',
  });
  await insertReview(connection, screening, {
    id: 'r002-list-no-read-review',
  });

  const session = await signInAs(testApp, 'r002listnoread');
  const body = (await expectJson(
    await session.fetch(LIST_PATH),
    200,
  )) as ListBody;
  const row = body.data.find((item) => item.id === screening.id);
  expect(row, '范围之内的初筛照常可见').toBeDefined();
  expect(row?.review, '读不到确认记录时这一段为空，不报错').toBeNull();
});

test('R-002 list: 姓名解析只给姓名，解析不到时给中性占位', async ({
  testApp,
  connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  await createUser(admin, 'r002listnames', { app: ['quality_manager'] });
  const named = await createNamedActor(
    admin,
    '名单上的人',
    'r002listnamedlogin',
  );
  const known = await insertScreening(connection, {
    id: 'r002-list-named',
    outcome: 'reviewed',
    reviewId: 'r002-list-named-review',
  });
  await insertReview(connection, known, {
    id: 'r002-list-named-review',
    actorId: named.id,
  });
  const orphan = await insertScreening(connection, {
    id: 'r002-list-orphan',
    outcome: 'reviewed',
    reviewId: 'r002-list-orphan-review',
  });
  await insertReview(connection, orphan, {
    id: 'r002-list-orphan-review',
    actorId: 'r002-deleted-actor',
  });
  const unconfirmed = await insertScreening(connection, {
    id: 'r002-list-unconfirmed',
  });

  const session = await signInAs(testApp, 'r002listnames');
  const response = await session.fetch(LIST_PATH);
  const text = await response.text();
  expect(response.status, `${text}`).toBe(200);
  const body = JSON.parse(text) as ListBody;
  const namedRow = body.data.find((item) => item.id === known.id);
  const orphanRow = body.data.find((item) => item.id === orphan.id);
  const emptyRow = body.data.find((item) => item.id === unconfirmed.id);
  expect(namedRow?.review?.actorName).toBe('名单上的人');
  expect(orphanRow?.review?.actorName, '账号已删时给中性占位').toBe(
    UNKNOWN_ACTOR_NAME,
  );
  expect(emptyRow?.review, '没确认过的行没有确认记录').toBeNull();
  for (const row of [namedRow, orphanRow]) {
    expect(Object.keys(row!.review!).sort()).toEqual(REVIEW_KEYS);
  }
  for (const leaked of [
    'r002listnamedlogin',
    `${named.id}@example.test`,
    'phone',
    'email',
  ]) {
    expect(text, `列表响应里出现了不该有的字段 ${leaked}`).not.toContain(
      leaked,
    );
  }
});

test('R-002 9: 确认端点的响应通过 schema 且当场带确认人姓名', async ({
  testApp,
  connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  await createUser(admin, 'r002confirmnamed', { app: ['quality_manager'] });
  const session = await signInAs(testApp, 'r002confirmnamed');
  const screening = await insertScreening(connection, {
    id: 'r002-confirm-name',
    outcome: 'needs-review',
  });

  const body = (await expectJson(
    await session.fetch(reviewPath(screening.id), json({})),
    200,
  )) as { data: ScreeningRow & { review: ReviewRow & { actorName?: string } } };
  expect(
    ScreeningReviewResultSchema.safeParse(body.data).success,
    '确认响应要满足声明了的响应 schema',
  ).toBe(true);
  expect(body.data.review.actorName, '确认当场就带姓名').toBe(
    'r002confirmnamed',
  );
  expect(Object.keys(body.data.review).sort(), '确认响应与列表同形').toEqual(
    REVIEW_KEYS,
  );
});

test('R-002 list: createdAt 相同时取 id 较大的确认记录', async ({
  testApp,
  connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  await createUser(admin, 'r002listtie', { app: ['quality_manager'] });
  const firstId = 'aaaa-first';
  const lastId = 'zzzz-last';
  const at = new Date('2026-11-22T10:00:00Z');
  const screening = await insertScreening(connection, {
    id: 'r002-list-tie',
    outcome: 'reviewed',
    reviewId: lastId,
  });
  await insertReview(connection, screening, {
    id: firstId,
    createdAt: at,
    category: 'dimension',
    severity: 'minor',
  });
  await insertReview(connection, screening, {
    id: lastId,
    createdAt: at,
    category: 'appearance',
    severity: 'critical',
  });

  const session = await signInAs(testApp, 'r002listtie');
  const body = (await expectJson(
    await session.fetch(LIST_PATH),
    200,
  )) as ListBody;
  const review = body.data.find((item) => item.id === screening.id)?.review;
  expect(review?.id, '同值时按 id 较大者决胜').toBe(lastId);
  expect(review?.category).toBe('appearance');
});
