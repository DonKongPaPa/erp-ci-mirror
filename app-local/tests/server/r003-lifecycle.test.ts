import { randomUUID } from 'node:crypto';

import {
  DEFAULT_ADMIN_CREDENTIALS,
  signIn,
  type TestSession,
} from '@nocobase/app-plugin-authentication/testing';
import { authorizationToken } from '@nocobase/app-plugin-authorization';
import type { DatabaseConnection } from '@nocobase/db';
import { describe, expect, it } from 'vitest';

import { fqcTicketsLifecycle } from '../../server/lifecycles/fqc-tickets.js';
import { createStandaloneServer } from '../../server/standalone.js';
import { createAppTest } from '../helpers/test-app.js';

/**
 * R-003 S5：lifecycle 定义与五个流转、改经办人、并发、存量首流转（验收 7、8、
 * 16 的流转部分），以及验收 9、10、15 的反向断言。全部在真 Postgres 上跑：
 * 并发与同版本条件更新在 SQLite 上不成立。
 */
const test = createAppTest({
  scope: 'test',
  createServer: createStandaloneServer,
  config: {
    app: { publicOrigin: 'http://localhost' },
    auth: { secret: 'test-auth-secret-at-least-32-characters' },
  },
});

const PASSWORD = 'R003-lifecycle-123!';

interface ApiErrorBody {
  error: { status: string; reason: string; domain: string };
}

type TicketValues = Record<string, unknown> & {
  id: string;
  departmentId: string | null;
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

const expectError = async (
  response: Response,
  status: number,
): Promise<ApiErrorBody['error']> => (await expectJson(response, status)).error;

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
      name,
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

const createDepartment = async (admin: TestSession, suffix: string) =>
  ((await expectJson(
    await admin.fetch(
      '/departments',
      json({ title: `部门-${suffix}`, code: `R003L-${suffix}` }),
    ),
    201,
  )) as { data: { id: string } }).data;

const addMembers = async (
  admin: TestSession,
  departmentId: string,
  userIds: string[],
) =>
  expectJson(
    await admin.fetch(
      `/departments/${departmentId}/members`,
      json({ userIds }),
    ),
    200,
  );

const signInAs = (app: any, username: string) =>
  signIn(app, { username, password: PASSWORD });

const grantTicket = async (
  app: any,
  userId: string,
  scope: string,
  key = `r003-l-${randomUUID().slice(0, 8)}`,
) => {
  const authz = app.container.resolve(authorizationToken) as any;
  await authz.permissionSets.create({
    key,
    grants: [
      {
        resource: { type: 'composite', id: 'fqc' },
        actions: [
          {
            action: 'ticket',
            policy: { type: 'composite', scopes: { fqcTickets: scope } },
          },
        ],
      },
    ],
  });
  await authz.permissionSets.assign({
    subject: { type: 'user', id: userId },
    permissionSet: key,
  });
};

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

const ticketOf = async (connection: DatabaseConnection, id: string) =>
  (await connection.repository('fqcTickets').findOne({ filter: { id } })) as
    | TicketValues
    | undefined;

const logsOf = async (connection: DatabaseConnection, id: string) =>
  (await connection
    .repository('lifecycleTransitions')
    .findMany({ filter: { recordId: id } })) as unknown as Record<
    string,
    unknown
  >[];

const transitionsPath = (id: string) => `/quality/tickets/${id}/transitions`;
const assigneePath = (id: string) => `/quality/tickets/${id}/assignee`;

const fire = (session: TestSession, id: string, name: string, input: unknown = {}) =>
  session.fetch(transitionsPath(id), json({ name, input }));

// ---- 定义本身 ----

describe('R-003 S5 lifecycle 定义', () => {
  it('name 是 fqcTickets，五个状态都有出路、没有 dueAt 字段与定时触发器', () => {
    expect(fqcTicketsLifecycle.name).toBe('fqcTickets');
    expect(fqcTicketsLifecycle.key).toBe('fqcTickets');
    expect(fqcTicketsLifecycle.version).toBe(1);
    expect(fqcTicketsLifecycle.states.map((s: any) => (typeof s === 'string' ? s : s.name)).sort()).toEqual([
      'closed',
      'in_progress',
      'open',
      'reopened',
      'resolved',
    ]);
    expect((fqcTicketsLifecycle as any).dueAtField).toBeUndefined();
    // defineLifecycle 总把 triggers 规整成 ReadonlyMap（definition.js:210），
    // 所以「没有定时触发器」要钉成注册表为空，而不是 undefined。
    expect((fqcTicketsLifecycle as any).triggers.size).toBe(0);
    // 运行时把 transitions 规整成 ReadonlyMap（definition.js:117）。
    expect([...fqcTicketsLifecycle.transitions.keys()].sort()).toEqual([
      'accept',
      'close',
      'reassign',
      'reopen',
      'resolve',
    ]);
  });
});

// ---- 验收 7：状态机 ----

test('R-003 验收7：四步依次成功，跳步与重复关单 409 且状态不变，重开能再受理', async ({
  testApp,
  connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const user = await createUser(admin, uniq('flow'), { app: ['quality_manager'] });
  const session = await signInAs(testApp, user.username);
  const ticket = await insertTicket(connection);

  // 跳步：open 直接解决 → 409，状态与版本不变。
  const jump = await expectError(await fire(session, ticket.id, 'resolve', { resolution: '处理说明' }), 409);
  expect(jump.reason).toBe('INVALID_TRANSITION');
  expect((await ticketOf(connection, ticket.id))?.state).toBe('open');
  expect((await ticketOf(connection, ticket.id))?.lifecycleVersion).toBe(0);

  await expectJson(await fire(session, ticket.id, 'accept'), 200);
  expect((await ticketOf(connection, ticket.id))?.state).toBe('in_progress');
  await expectJson(
    await fire(session, ticket.id, 'resolve', { resolution: '已调整公差' }),
    200,
  );
  expect((await ticketOf(connection, ticket.id))?.resolution).toBe('已调整公差');
  await expectJson(await fire(session, ticket.id, 'close'), 200);
  expect((await ticketOf(connection, ticket.id))?.state).toBe('closed');
  expect((await ticketOf(connection, ticket.id))?.closedAt).toBeTruthy();

  // 重复关单 → 409，状态不变。
  const again = await expectError(await fire(session, ticket.id, 'close'), 409);
  expect(again.reason).toBe('INVALID_TRANSITION');
  expect((await ticketOf(connection, ticket.id))?.state).toBe('closed');

  // closed 重开 → reopened，reopenCount + 1，closedAt 复位；再受理。
  await expectJson(
    await fire(session, ticket.id, 'reopen', { reason: '客户复现' }),
    200,
  );
  expect((await ticketOf(connection, ticket.id))?.state).toBe('reopened');
  expect((await ticketOf(connection, ticket.id))?.reopenCount).toBe(1);
  expect((await ticketOf(connection, ticket.id))?.closedAt).toBeNull();
  await expectJson(await fire(session, ticket.id, 'accept'), 200);
  expect((await ticketOf(connection, ticket.id))?.state).toBe('in_progress');

  // solved 重开也成功，并留下第二次。
  await expectJson(await fire(session, ticket.id, 'resolve', { resolution: '再处理' }), 200);
  await expectJson(await fire(session, ticket.id, 'reopen', { reason: '仍需跟进' }), 200);
  expect((await ticketOf(connection, ticket.id))?.reopenCount).toBe(2);

  // 每次成功流转在日志里有一行，记着谁、什么时候、从哪到哪。
  const logs = await logsOf(connection, ticket.id);
  expect(logs).toHaveLength(7);
  expect(logs[0]).toMatchObject({
    lifecycle: 'fqcTickets',
    transition: 'accept',
    from: 'open',
    to: 'in_progress',
    actorId: user.id,
  });
  expect(logs.every((row) => typeof row.at === 'string')).toBe(true);
  expect(logs.map((row) => row.version)).toEqual([1, 2, 3, 4, 5, 6, 7]);
});

test('R-003 验收7：解决缺处理说明、重开缺原因回 400', async ({
  testApp,
  connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const user = await createUser(admin, uniq('flowinput'), { app: ['quality_manager'] });
  const session = await signInAs(testApp, user.username);
  const ticket = await insertTicket(connection, { state: 'in_progress' });

  const missing = await expectError(await fire(session, ticket.id, 'resolve'), 400);
  expect(missing.status).toBe('INVALID_ARGUMENT');
  expect((await ticketOf(connection, ticket.id))?.state).toBe('in_progress');

  await expectJson(await fire(session, ticket.id, 'resolve', { resolution: 'ok' }), 200);
  const noReason = await expectError(await fire(session, ticket.id, 'reopen'), 400);
  expect(noReason.status).toBe('INVALID_ARGUMENT');
  expect((await ticketOf(connection, ticket.id))?.state).toBe('resolved');
});

// ---- 验收 8：真 Postgres 上的并发 ----

test('R-003 验收8：两个会话同时受理，至多一个成功、另一个 409', async ({
  testApp,
  connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const a = await createUser(admin, uniq('concurrentA'), { app: ['quality_manager'] });
  const b = await createUser(admin, uniq('concurrentB'), { app: ['quality_inspector'] });
  const sa = await signInAs(testApp, a.username);
  const sb = await signInAs(testApp, b.username);
  const ticket = await insertTicket(connection);

  const [ra, rb] = await Promise.allSettled([
    fire(sa, ticket.id, 'accept'),
    fire(sb, ticket.id, 'accept'),
  ]);
  const statuses = [ra, rb].map((r) =>
    r.status === 'fulfilled' ? r.value.status : -1,
  );
  expect(statuses.filter((s) => s === 200)).toHaveLength(1);
  expect(statuses.filter((s) => s === 409)).toHaveLength(1);
  expect((await ticketOf(connection, ticket.id))?.state).toBe('in_progress');
  expect((await ticketOf(connection, ticket.id))?.lifecycleVersion).toBe(1);
  expect(await logsOf(connection, ticket.id)).toHaveLength(1);
});

// ---- 验收 16：存量工单首次流转 ----

test('R-003 验收16：迁移前建的工单（无 departmentId、已回填定义）首次流转成功；定义留空抛 DEFINITION_MISMATCH', async ({
  testApp,
  connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const user = await createUser(admin, uniq('legacy'), { app: ['quality_manager'] });
  const session = await signInAs(testApp, user.username);
  const legacy = await insertTicket(connection, {
    departmentId: null,
    lifecycleDefinition: 'fqcTickets',
  });
  const accepted = await expectJson(
    await fire(session, legacy.id, 'accept'),
    200,
  );
  expect(accepted.data.record?.state ?? accepted.data.state).toBe('in_progress');
  expect((await ticketOf(connection, legacy.id))?.state).toBe('in_progress');

  const unbound = await insertTicket(connection, { lifecycleDefinition: null });
  const error = await expectError(await fire(session, unbound.id, 'accept'), 400);
  expect(error.reason).toBe('DEFINITION_MISMATCH');
  expect((await ticketOf(connection, unbound.id))?.state).toBe('open');
  expect(await logsOf(connection, unbound.id)).toHaveLength(0);
});

// ---- 改经办人、指派给别人时的 guard ----

test('R-003 改经办人只改一列；非成员 422，已关闭 409', async ({
  testApp,
  connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const user = await createUser(admin, uniq('assignee'), { app: ['quality_manager'] });
  const dept = await createDepartment(admin, uniq('assignee'));
  const member = await createUser(admin, uniq('member'), { app: [] });
  await addMembers(admin, dept.id, [member.id]);
  const session = await signInAs(testApp, user.username);
  const ticket = await insertTicket(connection, { departmentId: dept.id });
  const before = await ticketOf(connection, ticket.id);

  const notMember = await expectError(
    await session.fetch(assigneePath(ticket.id), json({ assigneeId: user.id })),
    422,
  );
  expect(notMember.reason).toBe('ASSIGNEE_NOT_DEPARTMENT_MEMBER');

  const ok = (await expectJson(
    await session.fetch(assigneePath(ticket.id), json({ assigneeId: member.id })),
    200,
  )).data;
  expect(ok.assigneeId).toBe(member.id);
  const after = await ticketOf(connection, ticket.id);
  expect(after?.state).toBe(before?.state);
  expect(after?.lifecycleVersion).toBe(before?.lifecycleVersion);
  expect(after?.departmentId).toBe(dept.id);

  // 经办人已指定给别人，别人不能受理。
  const other = await expectError(
    await fire(session, ticket.id, 'accept'),
    409,
  );
  expect(other.reason).toBe('ASSIGNED_TO_OTHER');

  await connection.repository('fqcTickets').updateMany({
    filter: { id: ticket.id },
    values: { state: 'closed' },
  });
  const closed = await expectError(
    await session.fetch(assigneePath(ticket.id), json({ assigneeId: null })),
    409,
  );
  expect(closed.reason).toBe('TICKET_CLOSED');
});

// ---- 验收 9、10、15 ----

test('R-003 验收9（反向）：只持处理的人不能流转或改经办人', async ({
  testApp,
  connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const user = await createUser(admin, uniq('handleonly'), { app: [] });
  const authz = testApp.application.container.resolve(authorizationToken) as any;
  const key = `r003-handleonly-${randomUUID().slice(0, 8)}`;
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
                fqcMessages: 'allRecords',
                fqcScreenings: 'allRecords',
                fqcTickets: 'allRecords',
                fqcScreeningReviews: 'allRecords',
                fqcRoutingRules: 'allRecords',
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
  const ticket = await insertTicket(connection);

  const a = await expectError(await fire(session, ticket.id, 'accept'), 403);
  expect(a.status).toBe('PERMISSION_DENIED');
  const b = await expectError(
    await session.fetch(assigneePath(ticket.id), json({ assigneeId: null })),
    403,
  );
  expect(b.status).toBe('PERMISSION_DENIED');
  expect((await ticketOf(connection, ticket.id))?.state).toBe('open');
});

test('R-003 验收10：本部门工单流转成功、别的部门 404；转派越界 403、范围内成功', async ({
  testApp,
  app,
  connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const suffix = uniq('scope');
  const deptA = await createDepartment(admin, `A${suffix}`);
  const deptB = await createDepartment(admin, `B${suffix}`);
  const scoped = await createUser(admin, uniq('scoped'), { app: [] });
  await addMembers(admin, deptA.id, [scoped.id]);
  await grantTicket(app, scoped.id, 'org.myDepartmentsAndBelow');
  const session = await signInAs(testApp, scoped.username);

  const own = await insertTicket(connection, { departmentId: deptA.id });
  const other = await insertTicket(connection, { departmentId: deptB.id });

  await expectJson(await fire(session, own.id, 'accept'), 200);
  const notFound = await expectError(await fire(session, other.id, 'accept'), 404);
  expect(notFound.reason).toBe('TICKET_NOT_FOUND');
  expect((await ticketOf(connection, other.id))?.state).toBe('open');

  // 转派到范围外：403 DEPARTMENT_OUT_OF_SCOPE，工单一行都没改。
  const before = await ticketOf(connection, own.id);
  const out = await expectError(
    await fire(session, own.id, 'reassign', { departmentId: deptB.id }),
    403,
  );
  expect(out.reason).toBe('DEPARTMENT_OUT_OF_SCOPE');
  expect(await ticketOf(connection, own.id)).toEqual(before);

  // 转派到范围内部门：成功，部门变了、版本前进、留一条自转移日志。
  const ok = await expectJson(
    await fire(session, own.id, 'reassign', { departmentId: deptA.id }),
    200,
  );
  expect(ok.data.record?.departmentId ?? ok.data.departmentId).toBe(deptA.id);
  const after = await ticketOf(connection, own.id);
  expect(after?.lifecycleVersion).toBe(before!.lifecycleVersion + 1);
  expect(after?.state).toBe('in_progress');
  const logs = await logsOf(connection, own.id);
  expect(logs.some((row) => row.transition === 'reassign')).toBe(true);
});

test('R-003 验收15（反向）：任何路径都不写 dueAt，也没有定时触发器', async ({
  testApp,
  connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const user = await createUser(admin, uniq('nodue'), { app: ['quality_manager'] });
  const session = await signInAs(testApp, user.username);
  const ticket = await insertTicket(connection);
  await fire(session, ticket.id, 'accept');
  await fire(session, ticket.id, 'resolve', { resolution: 'done' });
  await fire(session, ticket.id, 'close');
  expect((await ticketOf(connection, ticket.id))?.dueAt).toBeNull();
  expect((fqcTicketsLifecycle as any).dueAtField).toBeUndefined();
  expect((fqcTicketsLifecycle as any).triggers.size).toBe(0);
  expect((await connection.repository('fqcTickets').findMany()).every((row: any) => row.dueAt === null)).toBe(true);
});

test('R-003 受理带经办人：成员写入、非成员 422、已指派给别人 409', async ({
  testApp,
  connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const manager = await createUser(admin, uniq('accepter'), { app: ['quality_manager'] });
  const other = await createUser(admin, uniq('otheraccepter'), { app: ['quality_manager'] });
  const member = await createUser(admin, uniq('acceptee'), { app: [] });
  const dept = await createDepartment(admin, uniq('accept'));
  await addMembers(admin, dept.id, [member.id]);
  const session = await signInAs(testApp, manager.username);
  const otherSession = await signInAs(testApp, other.username);
  const ticket = await insertTicket(connection, { departmentId: dept.id });

  const bad = await expectError(
    await fire(session, ticket.id, 'accept', { assigneeId: manager.id }),
    422,
  );
  expect(bad.reason).toBe('ASSIGNEE_NOT_DEPARTMENT_MEMBER');
  expect((await ticketOf(connection, ticket.id))?.state).toBe('open');
  expect((await ticketOf(connection, ticket.id))?.assigneeId).toBeNull();

  await expectJson(
    await fire(session, ticket.id, 'accept', { assigneeId: member.id }),
    200,
  );
  const accepted = await ticketOf(connection, ticket.id);
  expect(accepted?.state).toBe('in_progress');
  expect(accepted?.assigneeId).toBe(member.id);

  // 已经指派给别人时，只有那个人能受理。
  const assigned = await insertTicket(connection, {
    departmentId: dept.id,
    assigneeId: manager.id,
  });
  const refused = await expectError(await fire(otherSession, assigned.id, 'accept'), 409);
  expect(refused.reason).toBe('ASSIGNED_TO_OTHER');
  expect((await ticketOf(connection, assigned.id))?.state).toBe('open');
});

test('R-003 守卫：转派到已停用部门 409，工单不变、没有日志', async ({
  testApp,
  connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const user = await createUser(admin, uniq('disabledreassign'), { app: ['quality_manager'] });
  const session = await signInAs(testApp, user.username);
  const dept = await createDepartment(admin, uniq('disabledtarget'));
  await expectJson(
    await admin.fetch(`/departments/${dept.id}/deactivate`, json({})),
    200,
  );
  const ticket = await insertTicket(connection, { departmentId: 'dept-source' });
  const before = await ticketOf(connection, ticket.id);

  const error = await expectError(
    await fire(session, ticket.id, 'reassign', { departmentId: dept.id }),
    409,
  );
  expect(error.reason).toBe('DEPARTMENT_DISABLED');
  expect(await ticketOf(connection, ticket.id)).toEqual(before);
  expect(await logsOf(connection, ticket.id)).toHaveLength(0);
});

test('R-003 守卫：转派带非新部门成员的经办人 422，工单不变、没有日志', async ({
  testApp,
  connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const manager = await createUser(admin, uniq('badassigneereassign'), {
    app: ['quality_manager'],
  });
  const session = await signInAs(testApp, manager.username);
  const target = await createDepartment(admin, uniq('newdept'));
  const ticket = await insertTicket(connection, { departmentId: 'dept-source' });
  const before = await ticketOf(connection, ticket.id);

  // 调用者不是新部门成员也没关系，只有带回的经办人必须是新部门成员。
  const error = await expectError(
    await fire(session, ticket.id, 'reassign', {
      departmentId: target.id,
      assigneeId: manager.id,
    }),
    422,
  );
  expect(error.reason).toBe('ASSIGNEE_NOT_DEPARTMENT_MEMBER');
  expect(await ticketOf(connection, ticket.id)).toEqual(before);
  expect(await logsOf(connection, ticket.id)).toHaveLength(0);
});

test('R-003 验收E：改经办人并发两次都 200，后写生效，不设版本前提', async ({
  testApp,
  connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const a = await createUser(admin, uniq('assignrace1'), { app: ['quality_manager'] });
  const b = await createUser(admin, uniq('assignrace2'), { app: ['quality_manager'] });
  const m1 = await createUser(admin, uniq('assignm1'), { app: [] });
  const m2 = await createUser(admin, uniq('assignm2'), { app: [] });
  const dept = await createDepartment(admin, uniq('assignrace'));
  await addMembers(admin, dept.id, [m1.id, m2.id]);
  const sa = await signInAs(testApp, a.username);
  const sb = await signInAs(testApp, b.username);
  const ticket = await insertTicket(connection, { departmentId: dept.id });
  const before = await ticketOf(connection, ticket.id);

  const [ra, rb] = await Promise.all([
    sa.fetch(assigneePath(ticket.id), json({ assigneeId: m1.id })),
    sb.fetch(assigneePath(ticket.id), json({ assigneeId: m2.id })),
  ]);
  expect(ra.status).toBe(200);
  expect(rb.status).toBe(200);
  const after = await ticketOf(connection, ticket.id);
  expect([m1.id, m2.id]).toContain(after?.assigneeId);
  expect(after?.state).toBe(before?.state);
  expect(after?.lifecycleVersion).toBe(before?.lifecycleVersion);
  expect(await logsOf(connection, ticket.id)).toHaveLength(0);
});
