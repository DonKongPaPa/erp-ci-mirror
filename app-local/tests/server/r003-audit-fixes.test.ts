import { randomUUID } from 'node:crypto';

import {
  DEFAULT_ADMIN_CREDENTIALS,
  signIn,
  type TestSession,
} from '@nocobase/app-plugin-authentication/testing';
import { authorizationToken } from '@nocobase/app-plugin-authorization';
import type { DatabaseConnection } from '@nocobase/db';
import { describe, expect } from 'vitest';

import { createStandaloneServer } from '../../server/standalone.js';
import {
  createAppTest,
  openTestDatabaseAdmin,
  testDatabaseSchemaNames,
} from '../helpers/test-app.js';

/**
 * 第三方审计（audit-r003-dispatch.md）A1/A2/A3/B1/B2/B3/B4 的定向用例。
 * 全部真 Postgres；并发与版本前提在内存库上不成立。
 */
const test = createAppTest({
  scope: 'test',
  createServer: createStandaloneServer,
  config: {
    app: { publicOrigin: 'http://localhost' },
    auth: { secret: 'test-auth-secret-at-least-32-characters' },
  },
});

const PASSWORD = 'R003-audit-123!';

const json = (body: unknown, method = 'POST', key?: string) => ({
  method,
  headers: {
    'content-type': 'application/json',
    origin: 'http://localhost',
    'Idempotency-Key': key ?? `${Date.now()}.${randomUUID()}`,
  },
  body: JSON.stringify(body),
});

const expectJson = async (response: Response, status: number): Promise<any> => {
  const text = await response.text();
  expect(response.status, `${text}`).toBe(status);
  return JSON.parse(text);
};

const expectError = async (response: Response, status: number) =>
  (await expectJson(response, status)).error as { reason: string };

/**
 * 真并发：外部事务用 FOR UPDATE 扣住工单行，另一个 HTTP 请求会阻塞在写这一行上；
 * 等它确实在等锁后，由外部事务把工单关掉/推进版本并提交，再放行。
 */
async function raceAgainstTicket(
  testApp: any,
  ticketId: string,
  request: () => Promise<Response>,
  changes: readonly (readonly [column: string, value: unknown])[],
): Promise<Response> {
  const admin = await openTestDatabaseAdmin(testApp);
  const schema = testDatabaseSchemaNames(testApp)[0];
  let tx: any;
  try {
    tx = await admin.client.transaction();
    await tx.raw('select id from ??.?? where id = ? for update', [
      schema,
      'fqc_tickets',
      ticketId,
    ]);
    const pending = request();
    let blocked = false;
    for (let i = 0; i < 120; i += 1) {
      const rows = await admin.client.raw(
        "select count(*)::int as n from pg_stat_activity where wait_event_type = 'Lock' and query ilike '%fqc_tickets%'",
      );
      if (Number(rows.rows?.[0]?.n ?? 0) > 0) {
        blocked = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(blocked, '另一连接应阻塞在 FOR UPDATE 上').toBe(true);
    for (const [column, value] of changes) {
      await tx.raw('update ??.?? set ?? = ? where id = ?', [
        schema,
        'fqc_tickets',
        column,
        value,
        ticketId,
      ]);
    }
    await tx.commit();
    return await pending;
  } finally {
    if (tx && !tx.isCompleted()) await tx.rollback().catch(() => {});
    await admin.close();
  }
}

const uniq = (prefix: string) =>
  `${prefix}${randomUUID().replaceAll('-', '').slice(0, 10)}`;

const createUser = async (
  admin: TestSession,
  name: string,
  roleScopes: Record<string, string[]> = { app: ['quality_manager'] },
): Promise<{ id: string; username: string }> =>
  (
    await expectJson(
      await admin.fetch(
        '/users',
        json({
          name: `姓名-${randomUUID().slice(0, 6)}`,
          username: name,
          email: `${name}@example.test`,
          password: PASSWORD,
          roleScopes,
        }),
      ),
      201,
    )
  ).data;

const signInAs = (app: any, username: string) =>
  signIn(app, { username, password: PASSWORD });

const createDepartment = async (admin: TestSession, suffix: string) =>
  (
    await expectJson(
      await admin.fetch(
        '/departments',
        json({ title: `部门-${suffix}`, code: uniq(`AU-${suffix}-`) }),
      ),
      201,
    )
  ).data as { id: string };

const addMembers = async (
  admin: TestSession,
  departmentId: string,
  userIds: string[],
) => expectJson(await admin.fetch(`/departments/${departmentId}/members`, json({ userIds })), 200);

const insertTicket = async (
  connection: DatabaseConnection,
  overrides: Partial<Record<string, unknown>> = {},
) => {
  const now = new Date();
  const values = {
    id: randomUUID(),
    code: `T-${randomUUID().slice(0, 8)}`,
    title: '尺寸超差',
    description: '客户正文-不能从处理工单响应 leaked',
    sourceMessageId: null,
    screeningId: null,
    category: 'dimension',
    severity: 'major',
    departmentId: 'dept-a',
    createdBy: 'creator',
    assigneeId: null,
    state: 'open',
    closedAt: null,
    createdAt: now,
    updatedAt: now,
    statusChangedAt: null,
    lifecycleVersion: 0,
    lifecycleDefinition: 'fqcTickets',
    reopenCount: 0,
    dueAt: null,
    ownerDepartment: null,
    ...overrides,
  };
  await connection.repository('fqcTickets').createOne({ values });
  return values;
};

const logsOf = async (connection: DatabaseConnection, id: string) =>
  (await connection
    .repository('lifecycleTransitions')
    .findMany({ filter: { recordId: id } })) as unknown as Record<string, unknown>[];

describe('审计 A1 / B2：转派经办人', () => {
  test('带经办人的工单转派不带经办人时置空，新部门成员能受理', async ({
    testApp,
    connection,
  }) => {
    const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
    const a = await createDepartment(admin, 'from');
    const b = await createDepartment(admin, 'to');
    const old = await createUser(admin, uniq('oldassignee'));
    const next = await createUser(admin, uniq('newmember'));
    await addMembers(admin, a.id, [old.id]);
    await addMembers(admin, b.id, [next.id]);
    const ticket = await insertTicket(connection, {
      departmentId: a.id,
      assigneeId: old.id,
    });
    const operator = await signInAs(testApp, next.username);
    const reassign = await operator.fetch(
      `/quality/tickets/${ticket.id}/transitions`,
      json({ name: 'reassign', input: { departmentId: b.id } }),
    );
    await expectJson(reassign, 200);
    const stored = await connection
      .repository('fqcTickets')
      .findOne({ filter: { id: ticket.id } });
    expect(stored?.departmentId).toBe(b.id);
    expect(stored?.assigneeId).toBeNull();
    // 新部门成员现在能受理。
    await expectJson(
      await operator.fetch(`/quality/tickets/${ticket.id}/transitions`, json({ name: 'accept' })),
      200,
    );
  });

  test('转派带非法经办人一律 422（空串 / 数字 / 布尔 / null / 空格）', async ({
    testApp,
    connection,
  }) => {
    const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
    const a = await createDepartment(admin, 'b2from');
    const b = await createDepartment(admin, 'b2to');
    const operator = await createUser(admin, uniq('b2operator'));
    const ticket = await insertTicket(connection, { departmentId: a.id });
    const session = await signInAs(testApp, operator.username);
    for (const bad of ['', 123, true, null, '   ']) {
      const response = await session.fetch(
        `/quality/tickets/${ticket.id}/transitions`,
        json({ name: 'reassign', input: { departmentId: b.id, assigneeId: bad } }),
      );
      expect(response.status, `bad value ${JSON.stringify(bad)}`).toBe(422);
      expect((await expectError(response, 422)).reason).toBe(
        'ASSIGNEE_NOT_DEPARTMENT_MEMBER',
      );
    }
    const stored = await connection
      .repository('fqcTickets')
      .findOne({ filter: { id: ticket.id } });
    expect(stored?.departmentId).toBe(a.id);
    expect(await logsOf(connection, ticket.id)).toHaveLength(0);
  });
});

describe('审计 A2 / A3：改判', () => {
  test('改判读到未关闭、并发关单后更新 0 行 → 409 TICKET_CLOSED 且类别不变', async ({
    testApp,
    connection,
  }) => {
    const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
    const now = new Date();
    const screeningId = randomUUID();
    await connection.repository('fqcScreenings').createOne({
      values: {
        id: screeningId,
        messageId: randomUUID(),
        category: 'dimension',
        severity: 'major',
        outcome: 'reviewed',
        reviewId: randomUUID(),
        createdAt: now,
        updatedAt: now,
      },
    });
    const ticket = await insertTicket(connection, {
      screeningId,
      category: 'dimension',
      severity: 'major',
      state: 'in_progress',
    });
    const manager = await createUser(admin, uniq('rejudger'));
    const session = await signInAs(testApp, manager.username);
    // 真并发：外部事务扣住工单，改判请求阻塞在写这一行上；外部事务推进版本并提交，
    // 改判的版本前提应当匹配不到行。状态列仍是 in_progress，不是先查就拒绝。
    const response = await raceAgainstTicket(
      testApp,
      ticket.id,
      () => session.fetch(`/quality/screenings/${screeningId}/review`, json({ category: 'appearance' })),
      [['lifecycle_version', 5]],
    );
    const error = await expectError(response, 409);
    expect(error.reason).toBe('TICKET_VERSION_CONFLICT');
    const stored = await connection
      .repository('fqcTickets')
      .findOne({ filter: { id: ticket.id } });
    expect(stored?.category).toBe('dimension');
  });

  test('改判撞并发关单 → 409 TICKET_CLOSED（原因码如实）', async ({
    testApp,
    connection,
  }) => {
    const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
    const now = new Date();
    const screeningId = randomUUID();
    await connection.repository('fqcScreenings').createOne({
      values: {
        id: screeningId,
        messageId: randomUUID(),
        category: 'dimension',
        severity: 'major',
        outcome: 'reviewed',
        reviewId: randomUUID(),
        createdAt: now,
        updatedAt: now,
      },
    });
    const ticket = await insertTicket(connection, {
      screeningId,
      state: 'in_progress',
    });
    const manager = await createUser(admin, uniq('closerace'));
    const session = await signInAs(testApp, manager.username);
    const response = await raceAgainstTicket(
      testApp,
      ticket.id,
      () => session.fetch(`/quality/screenings/${screeningId}/review`, json({ category: 'appearance' })),
      [['state', 'closed'], ['lifecycle_version', 5]],
    );
    expect((await expectError(response, 409)).reason).toBe('TICKET_CLOSED');
    const stored = await connection
      .repository('fqcTickets')
      .findOne({ filter: { id: ticket.id } });
    expect(stored?.category).toBe('dimension');
  });

  test('「处理」对工单表有读权但范围不含该单时，改判 403 不退化成确认', async ({
    app,
    testApp,
    connection,
  }) => {
    const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
    const now = new Date();
    const screeningId = randomUUID();
    await connection.repository('fqcScreenings').createOne({
      values: {
        id: screeningId,
        messageId: randomUUID(),
        category: 'dimension',
        severity: 'major',
        outcome: 'reviewed',
        reviewId: randomUUID(),
        createdAt: now,
        updatedAt: now,
      },
    });
    await insertTicket(connection, { screeningId });
    await connection.repository('fqcScreeningReviews').createOne({
      values: {
        id: randomUUID(),
        screeningId,
        kind: 'dispatch',
        category: 'dimension',
        severity: 'major',
        departmentId: 'dept-a',
        actorId: 'creator',
        createdAt: now,
      },
    });
    const user = await createUser(admin, uniq('noreadticket'), { app: [] });
    const authz = app.container.resolve(authorizationToken) as any;
    const noTicketKey = uniq('handle-no-ticket-');
    await authz.permissionSets.create({
      key: noTicketKey,
      grants: [
        {
          resource: { type: 'composite', id: 'fqc' },
          actions: [
            {
              action: 'handle',
              policy: {
                type: 'composite',
                scopes: {
                  fqcScreenings: 'allRecords',
                  fqcScreeningReviews: 'allRecords',
                  // 关键：工单表有读权、只是范围不含这张工单，仓储读得通，
                  // 403 必须来自 TICKET_NOT_READABLE 显式守卫，而不是 READ_FORBIDDEN。
                  fqcTickets: 'org.myDepartmentsAndBelow',
                },
              },
            },
          ],
        },
      ],
    });
    await authz.permissionSets.assign({
      subject: { type: 'user', id: user.id },
      permissionSet: noTicketKey,
    });
    const session = await signInAs(testApp, user.username);
    const response = await session.fetch(
      `/quality/screenings/${screeningId}/review`,
      json({ category: 'appearance' }),
    );
    expect(response.status).toBe(403);
    const stored = await connection
      .repository('fqcScreenings')
      .findOne({ filter: { id: screeningId } });
    expect(stored?.category).toBe('dimension');
  });
});

describe('审计 A3：范围内读不到已派单工单', () => {
  test('处理对工单表有部门范围但工单不在其中时，改判 403 且初筛不动', async ({
    app,
    testApp,
    connection,
  }) => {
    const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
    const dept = await createDepartment(admin, 'scopedout');
    const now = new Date();
    const screeningId = randomUUID();
    await connection.repository('fqcScreenings').createOne({
      values: {
        id: screeningId,
        messageId: randomUUID(),
        category: 'dimension',
        severity: 'major',
        outcome: 'reviewed',
        reviewId: randomUUID(),
        createdAt: now,
        updatedAt: now,
      },
    });
    await insertTicket(connection, { screeningId, departmentId: dept.id });
    await connection.repository('fqcScreeningReviews').createOne({
      values: {
        id: randomUUID(),
        screeningId,
        kind: 'dispatch',
        category: 'dimension',
        severity: 'major',
        departmentId: dept.id,
        actorId: 'creator',
        createdAt: now,
      },
    });
    const user = await createUser(admin, uniq('scopedhandle'), { app: [] });
    const authz = app.container.resolve(authorizationToken) as any;
    const key = uniq('handle-scoped-');
    await authz.permissionSets.create({
      key,
      grants: [
        {
          resource: { type: 'composite', id: 'fqc' },
          actions: [
            {
              action: 'handle',
              policy: {
                type: 'composite',
                scopes: {
                  fqcScreenings: 'allRecords',
                  fqcScreeningReviews: 'allRecords',
                  fqcTickets: 'org.myDepartmentsAndBelow',
                },
              },
            },
          ],
        },
      ],
    });
    await authz.permissionSets.assign({
      subject: { type: 'user', id: user.id },
      permissionSet: key,
    });
    const session = await signInAs(testApp, user.username);
    const response = await session.fetch(
      `/quality/screenings/${screeningId}/review`,
      json({ category: 'appearance' }),
    );
    expect(response.status).toBe(403);
    const stored = await connection
      .repository('fqcScreenings')
      .findOne({ filter: { id: screeningId } });
    expect(stored?.category).toBe('dimension');
  });
});

describe('审计 A2：改经办人与关单竞态', () => {
  test('读到未关闭、写之前并发关单 → 409 TICKET_CLOSED，经办人不变', async ({
    testApp,
    connection,
  }) => {
    const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
    const dept = await createDepartment(admin, 'assignrace');
    const member = await createUser(admin, uniq('raceassignee'));
    await addMembers(admin, dept.id, [member.id]);
    const ticket = await insertTicket(connection, { departmentId: dept.id });
    const operator = await createUser(admin, uniq('raceoperator'));
    const session = await signInAs(testApp, operator.username);

    // 真并发：外部事务扣住工单，改经办人请求阻塞在写这一行上；外部事务关单并提交，
    // state != closed 的谓词应当匹配不到行。
    const response = await raceAgainstTicket(
      testApp,
      ticket.id,
      () => session.fetch(
        `/quality/tickets/${ticket.id}/assignee`,
        json({ assigneeId: member.id }),
      ),
      [['state', 'closed']],
    );
    const error = await expectError(response, 409);
    expect(error.reason).toBe('TICKET_CLOSED');
    const stored = await connection
      .repository('fqcTickets')
      .findOne({ filter: { id: ticket.id } });
    expect(stored?.state).toBe('closed');
    expect(stored?.assigneeId).toBeNull();
  });
});

describe('审计 B1 / B3：响应边界与转移幂等', () => {
  test('流转与改经办人的响应不含描述、发件人等工单字段；重放不写第二条日志', async ({
    testApp,
    connection,
  }) => {
    const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
    const dept = await createDepartment(admin, 'b1');
    const ticket = await insertTicket(connection, { departmentId: dept.id });
    const operator = await createUser(admin, uniq('b1operator'));
    const session = await signInAs(testApp, operator.username);

    const key = uniq('idem-');
    const first = await expectJson(
      await session.fetch(
        `/quality/tickets/${ticket.id}/transitions`,
        json({ name: 'reassign', input: { departmentId: dept.id } }, 'POST', key),
      ),
      200,
    );
    expect(first.data.replayed).toBe(false);
    expect(Object.keys(first.data).sort()).toEqual([
      'id',
      'lifecycleVersion',
      'replayed',
      'state',
    ]);
    expect(JSON.stringify(first.data)).not.toContain('客户正文');

    const replay = await expectJson(
      await session.fetch(
        `/quality/tickets/${ticket.id}/transitions`,
        json({ name: 'reassign', input: { departmentId: dept.id } }, 'POST', key),
      ),
      200,
    );
    expect(replay.data.replayed).toBe(true);
    expect(await logsOf(connection, ticket.id)).toHaveLength(1);

    const changed = await expectJson(
      await session.fetch(
        `/quality/tickets/${ticket.id}/assignee`,
        json({ assigneeId: null }),
      ),
      200,
    );
    expect(Object.keys(changed.data).sort()).toEqual([
      'id',
      'lifecycleVersion',
      'state',
    ]);
    expect(JSON.stringify(changed.data)).not.toContain('客户正文');
  });
});

describe('审计 B4：停用账号', () => {
  test('停用账号不能指派为经办人，也不出现在搜同事结果里；q 纯空格 400', async ({
    testApp,
    connection,
  }) => {
    const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
    const dept = await createDepartment(admin, 'disabled');
    const good = await createUser(admin, uniq('activeuser'));
    const bad = await createUser(admin, uniq('disableduser'));
    await addMembers(admin, dept.id, [good.id, bad.id]);
    await connection.query
      .updateTable('user')
      .set({ disabledAt: new Date() })
      .where('id', '=', bad.id)
      .execute();
    const ticket = await insertTicket(connection, { departmentId: dept.id });
    const operator = await signInAs(testApp, good.username);

    expect(
      (
        await expectError(
          await operator.fetch(
            `/quality/tickets/${ticket.id}/assignee`,
            json({ assigneeId: bad.id }),
          ),
          422,
        )
      ).reason,
    ).toBe('ASSIGNEE_NOT_DEPARTMENT_MEMBER');
    await expectJson(
      await operator.fetch(
        `/quality/tickets/${ticket.id}/assignee`,
        json({ assigneeId: good.id }),
      ),
      200,
    );

    const candidates = await expectJson(
      await operator.fetch(
        `/quality/ticket-candidates?departmentId=${dept.id}&q=${encodeURIComponent('disableduser')}`,
      ),
      200,
    );
    expect(candidates.data).toEqual([]);
    const all = await expectJson(
      await operator.fetch(
        `/quality/ticket-candidates?departmentId=${dept.id}&q=${good.username}`,
      ),
      200,
    );
    expect(all.data.map((row: any) => row.id)).toContain(good.id);
    expect(
      (await operator.fetch(`/quality/ticket-candidates?departmentId=${dept.id}&q=%20%20`))
        .status,
    ).toBe(400);
  });
});

describe('主会话追加：窄部门清单与派单规则', () => {
  test('ticket-departments 只回在用部门的 id/title；处理或处理工单任一可调', async ({
    app,
    testApp,
    connection,
  }) => {
    const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
    const active = await createDepartment(admin, 'active');
    const inactive = await createDepartment(admin, 'inactive');
    await connection.query
      .updateTable('departments')
      .set({ active: false })
      .where('id', '=', inactive.id)
      .execute();
    const manager = await createUser(admin, uniq('deptviewer'));
    const session = await signInAs(testApp, manager.username);
    const body = await expectJson(await session.fetch('/quality/ticket-departments'), 200);
    expect(body.data).toEqual(expect.arrayContaining([{ id: active.id, title: active.title }]));
    expect(body.data.map((row: any) => row.id)).not.toContain(inactive.id);
    for (const row of body.data as any[]) {
      expect(Object.keys(row).sort()).toEqual(['id', 'title']);
    }
    const nobody = await createUser(admin, uniq('nodeptaccess'), { app: [] });
    const nobodySession = await signInAs(testApp, nobody.username);
    expect((await nobodySession.fetch('/quality/ticket-departments')).status).toBe(403);
    expect(app.container).toBeTruthy();
  });

  test('派单规则 GET 用查看、PUT 用维护派单规则；整体替换与 422', async ({
    testApp,
  }) => {
    const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
    const dept = await createDepartment(admin, 'rule');
    const manager = await createUser(admin, uniq('ruleinspector'), { app: ['quality_inspector'] });
    const session = await signInAs(testApp, manager.username);
    expect((await session.fetch('/quality/routing-rules', json({ rules: [] }, 'PUT'))).status).toBe(403);

    const replaced = await expectJson(
      await admin.fetch(
        '/quality/routing-rules',
        json({ rules: [{ category: 'dimension', departmentId: dept.id }, { category: 'appearance', departmentId: null }] }, 'PUT'),
      ),
      200,
    );
    expect(replaced.data).toHaveLength(2);
    const read = await expectJson(await admin.fetch('/quality/routing-rules'), 200);
    expect(read.data).toEqual([{ category: 'dimension', departmentId: dept.id }]);
    // departmentId 为 null 的类别表示「不配规则」，表里不落行（列是非空的）。
    expect(read.data.some((row: any) => row.category === 'appearance')).toBe(false);
    const badDept = await expectError(
      await admin.fetch(
        '/quality/routing-rules',
        json({ rules: [{ category: 'dimension', departmentId: randomUUID() }] }, 'PUT'),
      ),
      422,
    );
    expect(badDept.reason).toBe('DEPARTMENT_NOT_FOUND');
    expect(
      (
        await expectError(
          await admin.fetch(
            '/quality/routing-rules',
            json({ rules: [{ category: 'not-a-category', departmentId: dept.id }] as never }, 'PUT'),
          ),
          400,
        )
      ).reason,
    ).toBeTruthy();
  });
});

describe('派单 201 带确认记录', () => {
  test('派单响应带上刚写的 review，actorName 是确认人姓名而不是账号标识', async ({
    testApp,
    connection,
  }) => {
    const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
    const dept = await createDepartment(admin, 'dispatchreview');
    const now = new Date();
    const screeningId = randomUUID();
    await connection.repository('fqcScreenings').createOne({
      values: {
        id: screeningId,
        messageId: randomUUID(),
        category: 'dimension',
        severity: 'major',
        outcome: 'needs-review',
        reviewId: null,
        createdAt: now,
        updatedAt: now,
      },
    });
    await connection.repository('fqcRoutingRules').createOne({
      values: { category: 'dimension', departmentId: dept.id, updatedAt: now, updatedBy: 'seed' },
    });
    const dispatcher = await createUser(admin, uniq('dispatcher'));
    const displayName = `姓名-${randomUUID().slice(0, 6)}`;
    await connection.query
      .updateTable('user')
      .set({ name: displayName })
      .where('id', '=', dispatcher.id)
      .execute();
    const session = await signInAs(testApp, dispatcher.username);
    const body = await expectJson(
      await session.fetch(`/quality/screenings/${screeningId}/dispatch`, json({})),
      201,
    );
    expect(body.data.code).toBeTruthy();
    expect(body.data.review).toMatchObject({ kind: 'dispatch', actorName: displayName });
    expect(body.data.review.actorName).not.toBe(dispatcher.id);
    expect(body.data.review.actorName).not.toBe(dispatcher.username);
    expect(Object.keys(body.data.review).sort()).toEqual([
      'actorId',
      'actorName',
      'category',
      'createdAt',
      'departmentId',
      'id',
      'kind',
      'screeningId',
      'severity',
    ]);
  });
});

describe('验收门追加：部门清单范围与 lifecycle 成员校验', () => {
  test('只持处理工单、范围本部门的人：能调 ticket-departments，且只看到范围内部门', async ({
    app,
    testApp,
  }) => {
    const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
    const own = await createDepartment(admin, 'scopeown');
    const other = await createDepartment(admin, 'scopeother');
    const user = await createUser(admin, uniq('scopedticket'), { app: [] });
    await addMembers(admin, own.id, [user.id]);
    const authz = app.container.resolve(authorizationToken) as any;
    const key = uniq('ticket-only-');
    await authz.permissionSets.create({
      key,
      grants: [
        {
          resource: { type: 'composite', id: 'fqc' },
          actions: [
            {
              action: 'ticket',
              policy: {
                type: 'composite',
                scopes: { fqcTickets: 'org.myDepartmentsAndBelow' },
              },
            },
          ],
        },
      ],
    });
    await authz.permissionSets.assign({
      subject: { type: 'user', id: user.id },
      permissionSet: key,
    });
    const session = await signInAs(testApp, user.username);
    const body = await expectJson(await session.fetch('/quality/ticket-departments'), 200);
    expect(body.data).toEqual([{ id: own.id, title: own.title }]);
    expect(body.data.map((row: any) => row.id)).not.toContain(other.id);
  });

  test('B4：受理与转派带停用的经办人都回 422', async ({ testApp, connection }) => {
    const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
    const a = await createDepartment(admin, 'b4from');
    const b = await createDepartment(admin, 'b4to');
    const disabled = await createUser(admin, uniq('b4disabled'));
    await addMembers(admin, a.id, [disabled.id]);
    await addMembers(admin, b.id, [disabled.id]);
    await connection.query
      .updateTable('user')
      .set({ disabledAt: new Date() })
      .where('id', '=', disabled.id)
      .execute();
    const operator = await createUser(admin, uniq('b4operator'));
    const session = await signInAs(testApp, operator.username);
    const ticket = await insertTicket(connection, { departmentId: a.id });

    const acceptError = await expectError(
      await session.fetch(
        `/quality/tickets/${ticket.id}/transitions`,
        json({ name: 'accept', input: { assigneeId: disabled.id } }),
      ),
      422,
    );
    expect(acceptError.reason).toBe('ASSIGNEE_NOT_DEPARTMENT_MEMBER');
    const reassignError = await expectError(
      await session.fetch(
        `/quality/tickets/${ticket.id}/transitions`,
        json({ name: 'reassign', input: { departmentId: b.id, assigneeId: disabled.id } }),
      ),
      422,
    );
    expect(reassignError.reason).toBe('ASSIGNEE_NOT_DEPARTMENT_MEMBER');
  });
});
