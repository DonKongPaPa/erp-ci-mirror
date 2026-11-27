import { randomUUID } from 'node:crypto';

import {
  DEFAULT_ADMIN_CREDENTIALS,
  signIn,
  type TestSession,
} from '@nocobase/app-plugin-authentication/testing';
import type { DatabaseConnection } from '@nocobase/db';
import { createAppTest } from '../helpers/test-app.js';
import { expect } from 'vitest';

import { createStandaloneServer } from '../../server/standalone.js';

/**
 * R-003 S3：派单与改判（验收 2–6、9 的前半）。
 *
 * 端点还不存在时这些用例全红；先写断言，再实现。每次都造自己的初筛与派单规则，
 * 数的是「刚写的那一张工单 / 那一行确认记录」，所以 scope: 'test' 每台应用独立。
 */
const test = createAppTest({
  scope: 'test',
  createServer: createStandaloneServer,
  config: {
    app: { publicOrigin: 'http://localhost' },
    auth: { secret: 'test-auth-secret-at-least-32-characters' },
  },
});

const PASSWORD = 'R003-dispatch-123!';

interface ApiErrorBody {
  error: { status: string; reason: string; domain: string };
}

interface ScreeningRow extends Record<string, unknown> {
  id: string;
  category: string | null;
  severity: string | null;
  suggestedOwner: string | null;
  outcome: string;
  reviewId: string | null;
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

interface TicketRow extends Record<string, unknown> {
  id: string;
  screeningId: string;
  category: string | null;
  severity: string;
  departmentId: string | null;
  createdBy: string | null;
  assigneeId: string | null;
  state: string;
  closedAt: string | null;
  lifecycleDefinition: string | null;
  lifecycleVersion: number;
  reopenCount: number;
}

const json = (body: unknown) => ({
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    origin: 'http://localhost',
    'Idempotency-Key': `${Date.now()}.${randomUUID()}`,
  },
  body: JSON.stringify(body),
});

const expectJson = async (response: Response, status: number): Promise<any> => {
  const text = await response.text();
  expect(response.status, `${text}`).toBe(status);
  return JSON.parse(text);
};

const expectError = async (
  response: Response,
  status: number,
): Promise<ApiErrorBody['error']> => (await expectJson(response, status)).error;

const createUser = async (
  admin: TestSession,
  name: string,
  roleScopes: Record<string, string[]>,
): Promise<{ id: string }> => {
  const response = await admin.fetch(
    '/users',
    json({ name, username: name, email: `${name}@example.test`, password: PASSWORD, roleScopes }),
  );
  const text = await response.text();
  expect(response.status, `${text}`).toBe(201);
  return (JSON.parse(text) as { data: { id: string } }).data;
};

const signInAs = (app: any, username: string) =>
  signIn(app, { username, password: PASSWORD });

const insertScreening = async (
  connection: DatabaseConnection,
  overrides: Partial<Record<string, unknown>> = {},
): Promise<ScreeningRow> => {
  const id = randomUUID();
  const now = new Date();
  const values = {
    id,
    messageId: `message-${id}`,
    category: 'dimension',
    severity: 'major',
    suggestedOwner: 'quality-dimension',
    summary: '尺寸超差',
    evidence: [],
    modelName: null,
    engine: 'rules',
    promptVersion: null,
    degraded: false,
    degradeReason: null,
    knowledgeRefs: [],
    redacted: false,
    outcome: 'needs-review',
    reviewId: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
  await connection.repository('fqcScreenings').createOne({ values });
  return values as unknown as ScreeningRow;
};

/** 派单现在会校验责任部门存在且未停用，夹具必须用真的部门。 */
const createDepartment = async (admin: TestSession, code: string) =>
  (
    (await expectJson(
      await admin.fetch('/departments', json({ title: `部门-${code}`, code })),
      201,
    )) as { data: { id: string } }
  ).data.id;

const insertRule = async (
  connection: DatabaseConnection,
  category: string,
  departmentId: string,
) => {
  await connection.repository('fqcRoutingRules').createOne({
    values: { category, departmentId, updatedAt: new Date(), updatedBy: 'seed' },
  });
};

const insertReview = async (
  connection: DatabaseConnection,
  screeningId: string,
  overrides: Partial<Record<string, unknown>> = {},
): Promise<ReviewRow> => {
  const values = {
    id: randomUUID(),
    screeningId,
    kind: 'confirm',
    category: 'dimension',
    severity: 'major',
    departmentId: 'dept-reviewed',
    actorId: 'reviewer',
    createdAt: new Date(),
    ...overrides,
  };
  await connection.repository('fqcScreeningReviews').createOne({ values });
  return values as unknown as ReviewRow;
};

const ticketOf = async (connection: DatabaseConnection, screeningId: string) =>
  (await connection
    .repository('fqcTickets')
    .findOne({ filter: { screeningId } })) as unknown as TicketRow | null;

const reviewsOf = async (connection: DatabaseConnection, screeningId: string) =>
  (await connection
    .repository('fqcScreeningReviews')
    .findMany({ filter: { screeningId } })) as unknown as ReviewRow[];

const screeningsOf = async (connection: DatabaseConnection, id: string) =>
  (await connection
    .repository('fqcScreenings')
    .findOne({ filter: { id } })) as unknown as ScreeningRow | null;

const dispatchPath = (id: string) => `/quality/screenings/${id}/dispatch`;
const reviewPath = (id: string) => `/quality/screenings/${id}/review`;

test('R-003 验收2：确认即派单，201，open 工单七列与确认记录、初筛一起落地', async ({
  testApp,
  connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const manager = await createUser(admin, 'r003dispatchmanager', {
    app: ['quality_manager'],
  });
  const session = await signInAs(testApp, 'r003dispatchmanager');
  const deptId = await createDepartment(admin, 'R003-DIM-2');
  await insertRule(connection, 'dimension', deptId);

  const screening = await insertScreening(connection);
  const before = await connection.repository('fqcScreeningReviews').count();

  const response = await expectJson(
    await session.fetch(dispatchPath(screening.id), json({})),
    201,
  );
  // 派单 201 在工单行之外带刚写的 review；逐字段比工单行时不把这一列算进去。
  const { review: dispatchReview, ...ticket } = response.data as TicketRow & {
    review: { kind: string; actorName: string };
  };
  expect(dispatchReview.kind).toBe('dispatch');
  expect(dispatchReview.actorName).toBeTruthy();
  expect(ticket.screeningId).toBe(screening.id);
  expect(ticket.state).toBe('open');
  expect(ticket.category).toBe('dimension');
  expect(ticket.severity).toBe('major');
  expect(ticket.departmentId).toBe(deptId);
  expect(ticket.createdBy).toBe(manager.id);
  expect(ticket.lifecycleDefinition).toBe('fqcTickets');
  expect(ticket.lifecycleVersion).toBe(0);
  expect(ticket.reopenCount).toBe(0);
  expect(ticket.closedAt).toBeNull();

  // 库里那一行去掉停写的两列后，和响应逐字段相同；响应本身也不出现这两列。
  const stored = await ticketOf(connection, screening.id);
  const { ownerDepartment: _ownerDepartment, dueAt: _dueAt, ...storedPublic } = stored as any;
  const {
    departmentTitle: _departmentTitle,
    assigneeName: _assigneeName,
    canTransition: _canTransition,
    ...ticketRow
  } = ticket as any;
  expect(storedPublic).toEqual(ticketRow);
  expect(ticket).not.toHaveProperty('ownerDepartment');
  expect(ticket).not.toHaveProperty('dueAt');

  // 一行 dispatch 确认记录，departmentId 是生效责任部门。
  const rows = await reviewsOf(connection, screening.id);
  expect(rows).toHaveLength(1);
  expect(rows[0].kind).toBe('dispatch');
  expect(rows[0].category).toBe('dimension');
  expect(rows[0].severity).toBe('major');
  expect(rows[0].departmentId).toBe(deptId);
  expect(rows[0].actorId).toBe(manager.id);
  expect(await connection.repository('fqcScreeningReviews').count()).toBe(before + 1);

  // 初筛的 reviewId 指过去、outcome 记成 reviewed、updatedAt 变了。
  const updated = await screeningsOf(connection, screening.id);
  expect(updated?.outcome).toBe('reviewed');
  expect(updated?.reviewId).toBe(rows[0].id);
  expect(updated?.updatedAt).not.toBe(screening.updatedAt);
});

test('R-003 验收3：同一份草稿再派 409，不出现第二张工单，库约束挡直插', async ({
  testApp,
  connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  await createUser(admin, 'r003dispatchidem', { app: ['quality_manager'] });
  const session = await signInAs(testApp, 'r003dispatchidem');
  await insertRule(connection, 'dimension', await createDepartment(admin, 'R003-IDEM'));
  const screening = await insertScreening(connection);

  await expectJson(await session.fetch(dispatchPath(screening.id), json({})), 201);
  const error = await expectError(
    await session.fetch(dispatchPath(screening.id), json({})),
    409,
  );
  expect(error.reason).toBe('SCREENING_ALREADY_DISPATCHED');
  expect(await connection.repository('fqcTickets').count({ filter: { screeningId: screening.id } })).toBe(1);
  // 显式查重这道防线：顺序重放连确认记录都不多写一行。
  expect(await reviewsOf(connection, screening.id)).toHaveLength(1);

  // 绕过端点直插第二张，被唯一约束拒绝。
  const first = await ticketOf(connection, screening.id);
  await expect(
    connection.repository('fqcTickets').createOne({
      values: { ...first, id: randomUUID() } as never,
    }),
  ).rejects.toThrow();
});

test('R-003 验收4：生效值按字段取请求 → 确认记录 → 草稿，草稿的 suggestedOwner 不参与责任部门', async ({
  testApp,
  connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  await createUser(admin, 'r003dispatchvalues', { app: ['quality_manager'] });
  const session = await signInAs(testApp, 'r003dispatchvalues');
  const ruleDept = await createDepartment(admin, 'R003-FROM-RULE');
  const requestDept = await createDepartment(admin, 'R003-FROM-REQ');
  const reviewDept = await createDepartment(admin, 'R003-FROM-REVIEW');
  await insertRule(connection, 'dimension', ruleDept);
  await insertRule(connection, 'appearance', ruleDept);

  // ① 先 review 把类别改成 appearance，再不带值派单 → 取确认记录的值。
  const a = await insertScreening(connection);
  await insertReview(connection, a.id, {
    kind: 'confirm',
    category: 'appearance',
    severity: 'critical',
    departmentId: null,
  });
  const dispatchedA = (await expectJson(
    await session.fetch(dispatchPath(a.id), json({})),
    201,
  )).data as TicketRow;
  expect(dispatchedA.category).toBe('appearance');
  expect(dispatchedA.severity).toBe('critical');
  expect(dispatchedA.departmentId).toBe(ruleDept);

  // ② dispatch 带了值以请求为准，责任部门也取请求。
  const b = await insertScreening(connection);
  const dispatchedB = (await expectJson(
    await session.fetch(dispatchPath(b.id), json({
      category: 'packaging',
      severity: 'minor',
      departmentId: requestDept,
    })),
    201,
  )).data as TicketRow;
  expect(dispatchedB.category).toBe('packaging');
  expect(dispatchedB.severity).toBe('minor');
  expect(dispatchedB.departmentId).toBe(requestDept);

  // ③ 两者都没有时取草稿；责任部门取规则而不是 suggestedOwner。
  const c = await insertScreening(connection, { suggestedOwner: 'quality-dimension' });
  const dispatchedC = (await expectJson(
    await session.fetch(dispatchPath(c.id), json({})),
    201,
  )).data as TicketRow;
  expect(dispatchedC.category).toBe('dimension');
  expect(dispatchedC.departmentId).toBe(ruleDept);
  expect(dispatchedC.departmentId).not.toBe('quality-dimension');

  // ④ 先 review 带 departmentId，再派单 → 责任部门取确认记录里的。
  const d = await insertScreening(connection);
  await insertReview(connection, d.id, {
    kind: 'confirm',
    departmentId: reviewDept,
  });
  const dispatchedD = (await expectJson(
    await session.fetch(dispatchPath(d.id), json({})),
    201,
  )).data as TicketRow;
  expect(dispatchedD.departmentId).toBe(reviewDept);
});

test('R-003 验收5：类别没有派单规则时，不带 departmentId 回 422，带了成功', async ({
  testApp,
  connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  await createUser(admin, 'r003dispatchnorule', { app: ['quality_manager'] });
  const session = await signInAs(testApp, 'r003dispatchnorule');
  const manualDept = await createDepartment(admin, 'R003-MANUAL');
  // 不插 dimension 的规则。

  const first = await insertScreening(connection);
  const error = await expectError(
    await session.fetch(dispatchPath(first.id), json({})),
    422,
  );
  expect(error.reason).toBeTruthy();
  expect(await ticketOf(connection, first.id)).toBeUndefined();

  const second = await insertScreening(connection);
  const ok = (await expectJson(
    await session.fetch(dispatchPath(second.id), json({ departmentId: manualDept })),
    201,
  )).data as TicketRow;
  expect(ok.departmentId).toBe(manualDept);
});

test('R-003 验收6：改判只改类别与严重度，closed 回 409，换部门回 422', async ({
  testApp,
  connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  await createUser(admin, 'r003dispatchrejudge', { app: ['quality_manager'] });
  const session = await signInAs(testApp, 'r003dispatchrejudge');
  const deptId = await createDepartment(admin, 'R003-REJUDGE');
  await insertRule(connection, 'dimension', deptId);
  const screening = await insertScreening(connection);
  await expectJson(await session.fetch(dispatchPath(screening.id), json({})), 201);
  const ticketBefore = await ticketOf(connection, screening.id);
  const reviewsBefore = await reviewsOf(connection, screening.id);
  const logsBefore = await connection.repository('lifecycleTransitions').count({
    filter: { recordId: ticketBefore!.id },
  });

  // 改判：新增一行 rejudge，初筛 reviewId 跟着变，工单类别与严重度跟着变，其余不动。
  const changed = (await expectJson(
    await session.fetch(reviewPath(screening.id), json({
      category: 'appearance',
      severity: 'critical',
    })),
    200,
  )).data as ScreeningRow & { review: ReviewRow };
  expect(changed.review.kind).toBe('rejudge');
  expect(changed.review.category).toBe('appearance');
  expect(changed.review.severity).toBe('critical');

  const reviewsAfter = await reviewsOf(connection, screening.id);
  expect(reviewsAfter).toHaveLength(reviewsBefore.length + 1);
  expect((await screeningsOf(connection, screening.id))?.reviewId).toBe(changed.review.id);
  const ticketAfter = await ticketOf(connection, screening.id);
  expect(ticketAfter?.category).toBe('appearance');
  expect(ticketAfter?.severity).toBe('critical');
  expect(ticketAfter?.departmentId).toBe(ticketBefore?.departmentId);
  expect(ticketAfter?.state).toBe(ticketBefore?.state);
  expect(ticketAfter?.lifecycleVersion).toBe(ticketBefore?.lifecycleVersion);
  // 验收6「流转历史不动」直接数日志行，不只靠 lifecycleVersion 间接代证。
  expect(
    await connection.repository('lifecycleTransitions').count({
      filter: { recordId: ticketBefore!.id },
    }),
  ).toBe(logsBefore);

  // 带不同的 departmentId → 422 USE_REASSIGN，工单不变。
  const wrong = await expectError(
    await session.fetch(reviewPath(screening.id), json({ departmentId: 'dept-other' })),
    422,
  );
  expect(wrong.reason).toBe('USE_REASSIGN');
  expect((await ticketOf(connection, screening.id))?.departmentId).toBe(deptId);

  // 工单关闭后改判 → 409 TICKET_CLOSED。
  await connection.repository('fqcTickets').updateMany({
    filter: { id: ticketBefore!.id },
    values: { state: 'closed' },
  });
  const closed = await expectError(
    await session.fetch(reviewPath(screening.id), json({ category: 'dimension' })),
    409,
  );
  expect(closed.reason).toBe('TICKET_CLOSED');
});

test('R-003 验收9（反向）：只持处理工单的人不能派单与改判', async ({
  testApp,
  app,
  connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const user = await createUser(admin, 'r003dispatchonlyticket', { app: [] });
  const authz = app.container.resolve(
    (await import('@nocobase/app-plugin-authorization')).authorizationToken,
  ) as any;
  await authz.permissionSets.revoke(`user:${user.id}:staff`).catch(() => undefined);
  await authz.permissionSets.create({
    key: 'r003-ticket-only',
    grants: [
      {
        resource: { type: 'composite', id: 'fqc' },
        actions: [
          {
            action: 'ticket',
            policy: {
              type: 'composite',
              scopes: { fqcTickets: 'allRecords' },
            },
          },
        ],
      },
    ],
  });
  await authz.permissionSets.assign({
    subject: { type: 'user', id: user.id },
    permissionSet: 'r003-ticket-only',
  });

  const session = await signInAs(testApp, 'r003dispatchonlyticket');
  const screening = await insertScreening(connection);
  const a = await expectError(
    await session.fetch(dispatchPath(screening.id), json({ departmentId: 'dept-x' })),
    403,
  );
  expect(a.status).toBe('PERMISSION_DENIED');
  const b = await expectError(
    await session.fetch(reviewPath(screening.id), json({ category: 'appearance' })),
    403,
  );
  expect(b.status).toBe('PERMISSION_DENIED');
});

test('R-003 不变量3：派单的责任部门不存在或已停用 → 422，不建工单、不写确认记录', async ({
  testApp,
  connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  await createUser(admin, 'r003dispatchdept', { app: ['quality_manager'] });
  const session = await signInAs(testApp, 'r003dispatchdept');

  const missing = await insertScreening(connection);
  const before = await connection.repository('fqcScreeningReviews').count();
  const error = await expectError(
    await session.fetch(dispatchPath(missing.id), json({ departmentId: 'dept-NOT-EXIST' })),
    422,
  );
  expect(error.reason).toBe('DEPARTMENT_NOT_FOUND');
  expect(await ticketOf(connection, missing.id)).toBeUndefined();
  expect(await reviewsOf(connection, missing.id)).toHaveLength(0);
  expect(await connection.repository('fqcScreeningReviews').count()).toBe(before);

  // 已停用部门与不存在部门同形。
  const dept = (await expectJson(
    await admin.fetch('/departments', json({ title: '停用部门', code: 'R003-DISPATCH-DISABLED' })),
    201,
  )) as { data: { id: string } };
  await expectJson(
    await admin.fetch(`/departments/${dept.data.id}/deactivate`, json({})),
    200,
  );
  const disabled = await insertScreening(connection);
  const error2 = await expectError(
    await session.fetch(dispatchPath(disabled.id), json({ departmentId: dept.data.id })),
    422,
  );
  expect(error2.reason).toBe('DEPARTMENT_NOT_FOUND');
  expect(await ticketOf(connection, disabled.id)).toBeUndefined();
  expect(await reviewsOf(connection, disabled.id)).toHaveLength(0);
});

test('R-003 验收2：派单带非责任部门成员的经办人 → 422，不建工单、不写确认记录', async ({
  testApp,
  connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  await createUser(admin, 'r003dispatchmember', { app: ['quality_manager'] });
  const session = await signInAs(testApp, 'r003dispatchmember');
  const outsider = await createUser(admin, 'r003dispatchoutsider', { app: [] });
  const deptId = await createDepartment(admin, 'R003-MEMBERSHIP');

  const screening = await insertScreening(connection);
  const before = await connection.repository('fqcScreeningReviews').count();
  const error = await expectError(
    await session.fetch(dispatchPath(screening.id), json({
      departmentId: deptId,
      assigneeId: outsider.id,
    })),
    422,
  );
  expect(error.reason).toBe('ASSIGNEE_NOT_DEPARTMENT_MEMBER');
  expect(await ticketOf(connection, screening.id)).toBeUndefined();
  expect(await reviewsOf(connection, screening.id)).toHaveLength(0);
  expect(await connection.repository('fqcScreeningReviews').count()).toBe(before);
});

test('R-003 验收3（并发，真 Postgres）：两个会话同时派同一草稿 → [201,409]，恰好一张单', async ({
  testApp,
  connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  await createUser(admin, 'r003dispatchrace1', { app: ['quality_manager'] });
  await createUser(admin, 'r003dispatchrace2', { app: ['quality_manager'] });
  const s1 = await signInAs(testApp, 'r003dispatchrace1');
  const s2 = await signInAs(testApp, 'r003dispatchrace2');
  await insertRule(connection, 'dimension', await createDepartment(admin, 'R003-RACE'));
  const screening = await insertScreening(connection);

  const [a, b] = await Promise.all([
    s1.fetch(dispatchPath(screening.id), json({})),
    s2.fetch(dispatchPath(screening.id), json({})),
  ]);
  expect([a.status, b.status].sort()).toEqual([201, 409]);
  // 两个会话可能分别撞在显式查重、版本前提或唯一约束上；这里钉的是至多一张单。
  // 顺序重放单独钉 SCREENING_ALREADY_DISPATCHED，reviewId 抢先单独钉版本前提。
  expect(await connection.repository('fqcTickets').count({ filter: { screeningId: screening.id } })).toBe(1);
  expect(await reviewsOf(connection, screening.id)).toHaveLength(1);
});

test('R-003 验收3（版本前提）：reviewId 已变时并发派单，只有一次 UPDATE 命中', async ({
  testApp,
  connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  await createUser(admin, 'r003dispatchversion1', { app: ['quality_manager'] });
  await createUser(admin, 'r003dispatchversion2', { app: ['quality_manager'] });
  const s1 = await signInAs(testApp, 'r003dispatchversion1');
  const s2 = await signInAs(testApp, 'r003dispatchversion2');
  await insertRule(connection, 'dimension', await createDepartment(admin, 'R003-VERSION'));
  const seedId = `seed-${randomUUID()}`;
  const review = await insertReview(connection, seedId, { screeningId: seedId });
  const screening = await insertScreening(connection, { reviewId: review.id });

  const [a, b] = await Promise.all([
    s1.fetch(dispatchPath(screening.id), json({})),
    s2.fetch(dispatchPath(screening.id), json({})),
  ]);
  expect([a.status, b.status].sort()).toEqual([201, 409]);
  const loser = a.status === 409 ? a : b;
  const error = (await loser.json()) as { error: { reason: string } };
  expect(error.error.reason).toBe('SCREENING_REVIEW_CONFLICT');
  expect(await connection.repository('fqcTickets').count({ filter: { screeningId: screening.id } })).toBe(1);
  expect((await screeningsOf(connection, screening.id))?.reviewId).not.toBe(review.id);
});
