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
import { createAppTest } from '../helpers/test-app.js';

/**
 * R-003 S6 + S7：工单列表 / 详情 / canTransition（验收 7、10、11）与帮手（验收 13）。
 *
 * 全部在真 Postgres 上跑：授权的数据范围、带策略仓储的按列读、事务里的流转日志，
 * 都不是内存库能替代的。先写断言，端点还没改全时这些用例必须红。
 */
const test = createAppTest({
  scope: 'test',
  createServer: createStandaloneServer,
  config: {
    app: { publicOrigin: 'http://localhost' },
    auth: { secret: 'test-auth-secret-at-least-32-characters' },
  },
});

const PASSWORD = 'R003-read-123!';
const CODE_SENTINEL = 'CUSTOMER-PRIVATE-TEXT-8f3a';

type TicketValues = Record<string, unknown> & {
  id: string;
  code: string;
  title: string;
  state: string;
};

const json = (body: unknown, method = 'POST') => ({
  method,
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

const expectError = async (response: Response, status: number) =>
  (await expectJson(response, status)).error as {
    status: string;
    reason: string;
    domain: string;
  };

const uniq = (prefix: string) =>
  `${prefix}${randomUUID().replaceAll('-', '').slice(0, 10)}`;

const createUser = async (
  admin: TestSession,
  name: string,
  roleScopes: Record<string, string[]> = { app: [] },
): Promise<{ id: string; username: string }> => {
  const response = await admin.fetch(
    '/users',
    json({
      name: `姓名-${randomUUID().replaceAll('-', '').slice(0, 8)}`,
      username: name,
      email: `${name}@example.test`,
      password: PASSWORD,
      roleScopes,
    }),
  );
  const text = await response.text();
  expect(response.status, `${text}`).toBe(201);
  return (JSON.parse(text) as { data: { id: string; username: string } }).data;
};

const signInAs = (app: any, username: string) =>
  signIn(app, { username, password: PASSWORD });

const createDepartment = async (admin: TestSession, suffix: string) =>
  (
    (await expectJson(
      await admin.fetch(
        '/departments',
        json({ title: `部门-${suffix}`, code: uniq(`R003R-${suffix}-`) }),
      ),
      201,
    )) as { data: { id: string } }
  ).data;

const addMembers = async (
  admin: TestSession,
  departmentId: string,
  userIds: string[],
) =>
  expectJson(
    await admin.fetch(`/departments/${departmentId}/members`, json({ userIds })),
    200,
  );

const insertTicket = async (
  connection: DatabaseConnection,
  overrides: Partial<Record<string, unknown>> = {},
): Promise<TicketValues> => {
  const now = new Date();
  const values = {
    id: randomUUID(),
    code: `T-${randomUUID().slice(0, 8)}`,
    title: '尺寸超差',
    description: null,
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
  return values as TicketValues;
};

/** 造一个只持某几个 fqc 动作的权限集，用来钉死授权矩阵。 */
const grantFqc = async (
  app: any,
  userId: string,
  actions: readonly ('view' | 'handle' | 'ticket')[],
  scopes: Record<string, unknown>,
) => {
  const authz = app.container.resolve(authorizationToken) as any;
  const key = uniq('r003r-');
  await authz.permissionSets.create({
    key,
    grants: [
      {
        resource: { type: 'composite', id: 'fqc' },
        actions: actions.map((action) => ({
          action,
          policy: { type: 'composite', scopes },
        })),
      },
    ],
  });
  await authz.permissionSets.assign({
    subject: { type: 'user', id: userId },
    permissionSet: key,
  });
};

describe('R-003 S6 工单列表与详情', () => {
  test('授权矩阵：root / 质量主管 / 质量员可读，只持处理工单的人读列表详情都 403', async ({
    app,
    testApp,
    connection,
  }) => {
    const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
    await insertTicket(connection);
    const manager = await createUser(admin, uniq('r003rmgr'), {
      app: ['quality_manager'],
    });
    const inspector = await createUser(admin, uniq('r003rinsp'), {
      app: ['quality_inspector'],
    });
    const ticketOnly = await createUser(admin, uniq('r003ronly'));
    await grantFqc(app, ticketOnly.id, ['ticket'], {
      fqcTickets: 'allRecords',
    });

    for (const user of [manager, inspector]) {
      const session = await signInAs(testApp, user.username);
      expect((await session.fetch('/quality/tickets')).status).toBe(200);
    }
    // 只持「处理工单」不持「查看」：工单只给做不给看。
    const only = await signInAs(testApp, ticketOnly.username);
    const listError = await expectError(await only.fetch('/quality/tickets'), 403);
    expect(listError.status).toBe('PERMISSION_DENIED');
    expect(
      (await only.fetch(`/quality/tickets/${randomUUID()}`)).status,
    ).toBe(403);
  });

  test('部门主管只看本部门及下级工单；范围外与不存在同形 404', async ({
    testApp,
    connection,
  }) => {
    const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
    const dept = await createDepartment(admin, 'own');
    const other = await createDepartment(admin, 'other');
    const inside = await insertTicket(connection, { departmentId: dept.id });
    await insertTicket(connection, { departmentId: other.id });

    const dm = await createUser(admin, uniq('r003rdm'), { app: ['dept_manager'] });
    await addMembers(admin, dept.id, [dm.id]);
    const session = await signInAs(testApp, dm.username);

    const list = await expectJson(await session.fetch('/quality/tickets'), 200);
    expect(list.data.map((row: any) => row.id)).toEqual([inside.id]);

    const outsideId = (
      await connection
        .repository('fqcTickets')
        .findOne({ filter: { departmentId: other.id } })
    ) as TicketValues;
    const outside = await expectError(
      await session.fetch(`/quality/tickets/${outsideId.id}`),
      404,
    );
    const missing = await expectError(
      await session.fetch(`/quality/tickets/${randomUUID()}`),
      404,
    );
    expect(outside).toMatchObject({ status: 'NOT_FOUND', domain: 'quality' });
    expect(missing).toMatchObject({ status: 'NOT_FOUND', domain: 'quality' });
    expect(outside.reason).toBe(missing.reason);
  });

  test('列表按 state / departmentId / assigneeId / q 过滤，q 只匹配编号与标题', async ({
    testApp,
    connection,
  }) => {
    const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
    const dept = await createDepartment(admin, 'filter');
    const assignee = await createUser(admin, uniq('r003rassignee'));
    const wanted = await insertTicket(connection, {
      title: '外壳划伤',
      description: CODE_SENTINEL,
      state: 'in_progress',
      departmentId: dept.id,
      assigneeId: assignee.id,
    });
    await insertTicket(connection, {
      title: '尺寸超差',
      description: CODE_SENTINEL,
      state: 'open',
    });
    const manager = await createUser(admin, uniq('r003rmgr2'), {
      app: ['quality_manager'],
    });
    const session = await signInAs(testApp, manager.username);

    const byState = await expectJson(
      await session.fetch('/quality/tickets?state=in_progress'),
      200,
    );
    expect(byState.data.map((row: any) => row.id)).toEqual([wanted.id]);
    const byDept = await expectJson(
      await session.fetch(`/quality/tickets?departmentId=${dept.id}`),
      200,
    );
    expect(byDept.data.map((row: any) => row.id)).toEqual([wanted.id]);
    const byAssignee = await expectJson(
      await session.fetch(`/quality/tickets?assigneeId=${assignee.id}`),
      200,
    );
    expect(byAssignee.data.map((row: any) => row.id)).toEqual([wanted.id]);
    const byTitle = await expectJson(
      await session.fetch(`/quality/tickets?q=${encodeURIComponent('划伤')}`),
      200,
    );
    expect(byTitle.data.map((row: any) => row.id)).toEqual([wanted.id]);
    const byCode = await expectJson(
      await session.fetch(`/quality/tickets?q=${wanted.code}`),
      200,
    );
    expect(byCode.data.map((row: any) => row.id)).toEqual([wanted.id]);
    // q 匹配描述里的客户正文时不能命中（反向断言：描述只用于帮手的相似匹配）。
    const byDescription = await expectJson(
      await session.fetch(`/quality/tickets?q=${CODE_SENTINEL}`),
      200,
    );
    expect(byDescription.data).toEqual([]);
    // q 纯空格与搜同事一致回 400，不列出整个清单。
    expect((await session.fetch('/quality/tickets?q=%20%20')).status).toBe(400);
  });

  test('每行带 departmentTitle / assigneeName，不带邮箱、用户名、联系方式', async ({
    testApp,
    connection,
  }) => {
    const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
    const dept = await createDepartment(admin, 'decoration');
    const assignee = await createUser(admin, uniq('r003rdec'));
    await addMembers(admin, dept.id, [assignee.id]);
    await insertTicket(connection, {
      departmentId: dept.id,
      assigneeId: assignee.id,
    });
    const manager = await createUser(admin, uniq('r003rmgr3'), {
      app: ['quality_manager'],
    });
    const session = await signInAs(testApp, manager.username);
    const list = await expectJson(await session.fetch('/quality/tickets'), 200);
    const row = list.data[0];
    expect(row.departmentTitle).toBeTruthy();
    expect(row.assigneeName).toBeTruthy();
    const serialized = JSON.stringify(row);
    expect(serialized).not.toContain(assignee.username);
    expect(serialized).not.toContain(`${assignee.username}@example.test`);
    expect(row).not.toHaveProperty('assigneeUsername');
    expect(row).not.toHaveProperty('senderContact');
  });

  test('canTransition 逐行算：有处理权按状态给，没处理权每行都是空数组', async ({
    app,
    testApp,
    connection,
  }) => {
    const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
    const open = await insertTicket(connection, { state: 'open' });
    const resolved = await insertTicket(connection, { state: 'resolved' });
    const closed = await insertTicket(connection, { state: 'closed' });
    const manager = await createUser(admin, uniq('r003rmgr4'), {
      app: ['quality_manager'],
    });
    const viewOnly = await createUser(admin, uniq('r003rview'));
    await grantFqc(app, viewOnly.id, ['view'], { fqcTickets: 'allRecords' });

    const withTicket = await signInAs(testApp, manager.username);
    const list = await expectJson(
      await withTicket.fetch('/quality/tickets'),
      200,
    );
    const byId = new Map(
      (list.data as any[]).map((row) => [row.id, row] as const),
    );
    expect(byId.get(open.id).canTransition).toEqual(
      expect.arrayContaining(['accept']),
    );
    expect(byId.get(open.id).canTransition).not.toContain('resolve');
    expect(byId.get(resolved.id).canTransition).toEqual(
      expect.arrayContaining(['close', 'reopen']),
    );
    expect(byId.get(resolved.id).canTransition).not.toContain('resolve');
    expect(byId.get(closed.id).canTransition).toEqual(['reopen']);

    const withoutTicket = await signInAs(testApp, viewOnly.username);
    const viewList = await expectJson(
      await withoutTicket.fetch('/quality/tickets'),
      200,
    );
    for (const row of viewList.data as any[]) {
      expect(row.canTransition).toEqual([]);
    }
  });

  test('详情：工单字段 + 确认记录 + 流转历史；部门主管确认记录是空数组不是 403', async ({
    testApp,
    connection,
  }) => {
    const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
    const dept = await createDepartment(admin, 'detail');
    const screeningId = randomUUID();
    const ticket = await insertTicket(connection, {
      departmentId: dept.id,
      screeningId,
    });
    await connection.repository('fqcScreeningReviews').createOne({
      values: {
        id: randomUUID(),
        screeningId,
        kind: 'dispatch',
        category: 'dimension',
        severity: 'major',
        departmentId: dept.id,
        actorId: 'creator',
        createdAt: new Date(),
      },
    });
    const dm = await createUser(admin, uniq('r003rdm2'), {
      app: ['dept_manager'],
    });
    await addMembers(admin, dept.id, [dm.id]);
    const dmSession = await signInAs(testApp, dm.username);
    const detail = await expectJson(
      await dmSession.fetch(`/quality/tickets/${ticket.id}`),
      200,
    );
    expect(detail.data.ticket.id).toBe(ticket.id);
    expect(detail.data.reviews).toEqual([]);
    expect(Array.isArray(detail.data.transitions)).toBe(true);
    expect(detail.data.ticket.canTransition).toEqual([]);

    const manager = await createUser(admin, uniq('r003rmgr5'), {
      app: ['quality_manager'],
    });
    const managerSession = await signInAs(testApp, manager.username);
    const full = await expectJson(
      await managerSession.fetch(`/quality/tickets/${ticket.id}`),
      200,
    );
    expect(full.data.reviews.length).toBe(1);
    expect(full.data.transitions).toEqual(expect.any(Array));
  });
});

describe('R-003 S7 帮手 assist', () => {
  test('只回范围内已解决或已关闭的工单，不回描述与发件人，suggestion 空、engine none', async ({
    testApp,
    connection,
  }) => {
    const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
    const resolved = await insertTicket(connection, {
      title: '尺寸超差',
      description: `${CODE_SENTINEL} 尺寸超差`,
      state: 'resolved',
      resolution: '调整公差',
      closedAt: new Date(),
    });
    const closed = await insertTicket(connection, {
      description: '尺寸超差 已换料',
      state: 'closed',
      resolution: '换料',
      closedAt: new Date(),
    });
    const open = await insertTicket(connection, { state: 'open' });
    // 关键字命中但状态不对：in_progress 的描述含本单标题，不能出现在 similar 里。
    const inProgress = await insertTicket(connection, {
      title: '不相关的标题',
      description: '尺寸超差 仍在办',
      state: 'in_progress',
    });
    const manager = await createUser(admin, uniq('r003rmgr6'), {
      app: ['quality_manager'],
    });
    const session = await signInAs(testApp, manager.username);

    const body = await expectJson(
      await session.fetch(`/quality/tickets/${open.id}/assist`),
      200,
    );
    const ids = (body.data.similar as any[]).map((row) => row.id);
    expect(ids).toEqual(expect.arrayContaining([resolved.id, closed.id]));
    expect(ids).not.toContain(open.id);
    expect(ids).not.toContain(inProgress.id);
    const row = (body.data.similar as any[]).find((item) => item.id === resolved.id);
    expect(row).toMatchObject({
      code: resolved.code,
      title: resolved.title,
      category: 'dimension',
      severity: 'major',
      resolution: '调整公差',
    });
    expect(row).toHaveProperty('closedAt');
    // 反向断言：描述与客户正文、发件人字段一概不回。
    expect(row).not.toHaveProperty('description');
    expect(row).not.toHaveProperty('senderName');
    expect(row).not.toHaveProperty('senderContact');
    expect(row).not.toHaveProperty('sourceMessageId');
    expect(JSON.stringify(body)).not.toContain(CODE_SENTINEL);
    expect(body.data.suggestion).toEqual({ text: '', source: null });
    expect(body.data.engine).toBe('none');
  });

  test('相似匹配用本单标题在描述里做关键字，但描述不发回；只持处理的人 403', async ({
    app,
    testApp,
    connection,
  }) => {
    const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
    const subject = await insertTicket(connection, {
      title: '尺寸超差',
      state: 'open',
    });
    const match = await insertTicket(connection, {
      title: '另一个标题',
      description: '以前遇到尺寸超差是这样处理的',
      state: 'resolved',
      resolution: '历史处理说明',
      closedAt: new Date(),
    });
    const unrelated = await insertTicket(connection, {
      title: '无关',
      description: '完全不同的描述',
      state: 'closed',
      resolution: '无关处理',
      closedAt: new Date(),
    });
    const manager = await createUser(admin, uniq('r003rmgr7'), {
      app: ['quality_manager'],
    });
    const session = await signInAs(testApp, manager.username);
    const body = await expectJson(
      await session.fetch(`/quality/tickets/${subject.id}/assist`),
      200,
    );
    const ids = (body.data.similar as any[]).map((row) => row.id);
    expect(ids).toContain(match.id);
    expect(ids).not.toContain(unrelated.id);
    expect(JSON.stringify(body)).not.toContain('尺寸超差是这样处理的');

    // 只持「处理」（不是处理工单）的人调帮手 403（验收 9）。
    const handleOnly = await createUser(admin, uniq('r003rhandle'));
    await grantFqc(app, handleOnly.id, ['handle'], {
      fqcTickets: 'allRecords',
    });
    const handleSession = await signInAs(testApp, handleOnly.username);
    expect(
      (await handleSession.fetch(`/quality/tickets/${subject.id}/assist`)).status,
    ).toBe(403);
  });

  test('帮手范围外与不存在同形 404', async ({ app, testApp, connection }) => {
    const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
    const dept = await createDepartment(admin, 'assistscope');
    const other = await createDepartment(admin, 'assistother');
    const own = await insertTicket(connection, {
      departmentId: dept.id,
      state: 'open',
    });
    const foreign = await insertTicket(connection, {
      departmentId: other.id,
      state: 'resolved',
      closedAt: new Date(),
    });
    const dm = await createUser(admin, uniq('r003rdm3'), {
      app: ['dept_manager'],
    });
    await grantFqc(app, dm.id, ['ticket', 'view'], {
      fqcTickets: 'org.myDepartmentsAndBelow',
    });
    await addMembers(admin, dept.id, [dm.id]);
    const session = await signInAs(testApp, dm.username);
    const outError = await expectError(
      await session.fetch(`/quality/tickets/${foreign.id}/assist`),
      404,
    );
    const missError = await expectError(
      await session.fetch(`/quality/tickets/${randomUUID()}/assist`),
      404,
    );
    expect(outError).toMatchObject({ status: 'NOT_FOUND', domain: 'quality' });
    expect(missError).toMatchObject({ status: 'NOT_FOUND', domain: 'quality' });
    expect(outError.reason).toBe(missError.reason);
    const ownBody = await expectJson(
      await session.fetch(`/quality/tickets/${own.id}/assist`),
      200,
    );
    expect(Array.isArray(ownBody.data.similar)).toBe(true);
  });
});

