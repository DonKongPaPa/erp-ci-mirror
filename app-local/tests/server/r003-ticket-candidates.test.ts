import { randomUUID } from 'node:crypto';

import {
  DEFAULT_ADMIN_CREDENTIALS,
  signIn,
  type TestSession,
} from '@nocobase/app-plugin-authentication/testing';
import { authorizationToken } from '@nocobase/app-plugin-authorization';
import type { DatabaseConnection } from '@nocobase/db';
import { describe, expect, it } from 'vitest';

import { createStandaloneServer } from '../../server/standalone.js';
import {
  inTicketScope,
  resolveTicketScope,
  ticketScopeOfDecision,
} from '../../server/ticket-scope.js';
import { createAppTest } from '../helpers/test-app.js';

/**
 * R-003 S4：范围解析与搜同事（验收 10、12）。
 *
 * 纯函数部分钉死只认 true 与 departmentId $eq 两种形状；端点部分在真 Postgres 上
 * 用两个不同部门的经办人各试一次：范围内成功、范围外 404（与不存在、停用同形）。
 * 邮箱诱饵只写在建账号的请求里，不进任何断言。
 */
const test = createAppTest({
  scope: 'test',
  createServer: createStandaloneServer,
  config: {
    app: { publicOrigin: 'http://localhost' },
    auth: { secret: 'test-auth-secret-at-least-32-characters' },
  },
});

const PASSWORD = 'R003-candidates-123!';

interface ApiErrorBody {
  error: { status: string; reason: string; domain: string };
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
  email: string,
  roleScopes: Record<string, string[]> = { app: [] },
): Promise<{ id: string; name: string; username: string }> => {
  const response = await admin.fetch(
    '/users',
    json({
      name,
      username: name,
      email,
      password: PASSWORD,
      roleScopes,
    }),
  );
  const text = await response.text();
  expect(response.status, `${text}`).toBe(201);
  return (
    JSON.parse(text) as {
      data: { id: string; name: string; username: string };
    }
  ).data;
};

const createDepartment = async (admin: TestSession, suffix: string) => {
  const response = await admin.fetch(
    '/departments',
    json({ title: `部门-${suffix}`, code: `R003-${suffix}` }),
  );
  return ((await expectJson(response, 201)) as { data: { id: string } }).data;
};

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

/** 建一个只持 ticket 动作的权限集并指派给用户。 */
const grantTicket = async (
  app: any,
  userId: string,
  key: string,
  scope: string,
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

const insertTicket = async (connection: DatabaseConnection, departmentId: string) => {
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
    departmentId,
    createdBy: 'seed',
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
  };
  await connection.repository('fqcTickets').createOne({ values });
  return values;
};

const candidatesPath = (
  departmentId: string,
  q: string,
  page = 1,
  pageSize = 20,
) =>
  `/quality/ticket-candidates?departmentId=${encodeURIComponent(departmentId)}&q=${encodeURIComponent(q)}&page=${page}&pageSize=${pageSize}`;

// ---- 纯函数：只认 true 与 departmentId $eq ----

describe('R-003 S4 范围解析的形状', () => {
  const decision = (read: unknown) =>
    ({ conditions: { database: { fqcTickets: { read } } } }) as never;

  it('true 是全部部门', () => {
    expect(resolveTicketScope(true)).toEqual({ kind: 'all' });
    expect(inTicketScope(ticketScopeOfDecision(decision(true)), 'any-dept')).toBe(true);
  });

  it('单个 departmentId $eq（scopeAst 会包进 and 组）解析为这一个部门', () => {
    const read = {
      scope: {
        kind: 'filter',
        version: 1,
        collection: 'fqcTickets',
        root: {
          kind: 'group',
          logic: 'and',
          items: [
            {
              kind: 'condition',
              path: ['departmentId'],
              operator: '$eq',
              value: 'dept-a',
            },
          ],
        },
      },
    };
    const scope = ticketScopeOfDecision(decision(read));
    expect(inTicketScope(scope, 'dept-a')).toBe(true);
    expect(inTicketScope(scope, 'dept-b')).toBe(false);
  });

  it('多个 $eq 的 or 组解析为部门集合', () => {
    const read = {
      scope: {
        kind: 'filter',
        version: 1,
        collection: 'fqcTickets',
        root: {
          kind: 'group',
          logic: 'or',
          items: ['dept-a', 'dept-b'].map((value) => ({
            kind: 'condition',
            path: ['departmentId'],
            operator: '$eq',
            value,
          })),
        },
      },
    };
    const scope = resolveTicketScope(read);
    expect(inTicketScope(scope, 'dept-a')).toBe(true);
    expect(inTicketScope(scope, 'dept-b')).toBe(true);
    expect(inTicketScope(scope, 'dept-c')).toBe(false);
  });

  it('{scope:true,fields,relations}（allRecords 的真实形状）与裸 true 一样是全部部门', () => {
    const allRecords = {
      scope: true,
      fields: ['id', 'departmentId'],
      relations: {},
    };
    expect(resolveTicketScope(allRecords)).toEqual({ kind: 'all' });
    expect(
      inTicketScope(ticketScopeOfDecision(decision(allRecords)), 'any-dept'),
    ).toBe(true);
    expect(resolveTicketScope({ scope: true })).toEqual({ kind: 'all' });
  });

  it('{scope:false}、$in、别的字段与 false 一律不可解析', () => {
    const cond = (operator: string, path: string[]) => ({
      scope: {
        kind: 'filter',
        root: { kind: 'condition', path, operator, value: 'x' },
      },
    });
    expect(resolveTicketScope({ scope: false })).toBeNull();
    expect(resolveTicketScope(false)).toBeNull();
    expect(resolveTicketScope(cond('$in', ['departmentId']))).toBeNull();
    expect(resolveTicketScope(cond('$eq', ['category']))).toBeNull();
    expect(resolveTicketScope({ scope: { root: {} } })).toBeNull();
    expect(
      inTicketScope(resolveTicketScope(cond('$in', ['departmentId'])), 'x'),
    ).toBe(false);
  });
});

// ---- 端点：真 Postgres 上两个部门各试一次 ----

test('R-003 验收12：只回三列，只按姓名与用户名匹配，邮箱诱饵搜不到', async ({
  testApp,
  app,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const needle = uniq('needle');
  const dept = await createDepartment(admin, uniq('cand'));
  const byName = await createUser(
    admin,
    uniq(`nam${needle}`),
    `${uniq('n')}@example.test`,
  );
  const mailOnly = await createUser(admin, uniq('other'), `${needle}@example.test`);
  await addMembers(admin, dept.id, [byName.id, mailOnly.id]);

  const viewer = await createUser(admin, uniq('viewer'), `${uniq('v')}@example.test`);
  await addMembers(admin, dept.id, [viewer.id]);
  await grantTicket(
    app,
    viewer.id,
    `r003-cand-${randomUUID().slice(0, 8)}`,
    'org.myDepartments',
  );
  const session = await signInAs(testApp, viewer.username);

  const hit = await expectJson(
    await session.fetch(candidatesPath(dept.id, needle)),
    200,
  );
  expect(hit.data.map((row: any) => row.id)).toEqual([byName.id]);
  for (const row of hit.data) {
    expect(Object.keys(row).sort()).toEqual(['id', 'name', 'username']);
    expect(row).not.toHaveProperty('email');
  }
  // 再断言一次诱饵账号没被返回，避免「搜人坏了才回空」的假绿。
  expect(hit.data.map((row: any) => row.id)).not.toContain(mailOnly.id);
});

test('R-003 验收10/12：部门范围内成功、范围外与停用同形回 404', async ({
  testApp,
  app,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const suffix = uniq('scope');
  const deptA = await createDepartment(admin, `A${suffix}`);
  const deptB = await createDepartment(admin, `B${suffix}`);
  const memberA = await createUser(admin, uniq('memberA'), `${uniq('ma')}@example.test`);
  const memberB = await createUser(admin, uniq('memberB'), `${uniq('mb')}@example.test`);
  await addMembers(admin, deptA.id, [memberA.id]);
  await addMembers(admin, deptB.id, [memberB.id]);

  const scoped = await createUser(admin, uniq('scoped'), `${uniq('sc')}@example.test`);
  await addMembers(admin, deptA.id, [scoped.id]);
  await grantTicket(
    app,
    scoped.id,
    `r003-scope-${randomUUID().slice(0, 8)}`,
    'org.myDepartmentsAndBelow',
  );
  const session = await signInAs(testApp, scoped.username);

  const hit = await expectJson(
    await session.fetch(candidatesPath(deptA.id, 'memberA')),
    200,
  );
  expect(hit.data.map((row: any) => row.id)).toContain(memberA.id);
  for (const row of hit.data) {
    expect(Object.keys(row).sort()).toEqual(['id', 'name', 'username']);
  }

  const outOfScope = await expectError(
    await session.fetch(candidatesPath(deptB.id, 'memberB')),
    404,
  );
  expect(outOfScope.reason).toBe('DEPARTMENT_NOT_FOUND');
  const empty = await expectJson(
    await session.fetch(candidatesPath(deptB.id, 'memberB')),
    404,
  );
  expect(empty.data).toBeUndefined();
  expect(Array.isArray(empty.data)).toBe(false);

  const emptyQ = await expectError(
    await session.fetch(candidatesPath(deptA.id, '')),
    400,
  );
  expect(emptyQ.status).toBe('INVALID_ARGUMENT');

  // 范围内部门停用后与范围外同形：先把成员移出去，部门才允许停用。
  for (const id of [memberA.id, scoped.id]) {
    await expectJson(
      await admin.fetch(
        `/departments/${deptA.id}/members/${id}`,
        json({}, 'DELETE'),
      ),
      200,
    );
  }
  await expectJson(
    await admin.fetch(`/departments/${deptA.id}/deactivate`, json({})),
    200,
  );
  const disabled = await expectError(
    await session.fetch(candidatesPath(deptA.id, 'memberA')),
    404,
  );
  expect(disabled.reason).toBe('DEPARTMENT_NOT_FOUND');
});

test('R-003 验收9（反向）：只持处理的人不能搜同事', async ({ testApp, app }) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const dept = await createDepartment(admin, uniq('handleonly'));
  const handleOnly = await createUser(
    admin,
    uniq('handleonlyuser'),
    `${uniq('h')}@example.test`,
  );
  const authz = app.container.resolve(authorizationToken) as any;
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
    subject: { type: 'user', id: handleOnly.id },
    permissionSet: key,
  });

  const session = await signInAs(testApp, handleOnly.username);
  const error = await expectError(
    await session.fetch(candidatesPath(dept.id, 'any')),
    403,
  );
  expect(error.status).toBe('PERMISSION_DENIED');
});

test('R-003 验收10/12（真授权）：seed 的 quality_manager 拿到 allRecords，能搜任一部门同事并转派', async ({
  testApp,
  app,
  connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const dept = await createDepartment(admin, uniq('allrecords'));
  const colleague = await createUser(
    admin,
    uniq('colleague'),
    `${uniq('c')}@example.test`,
  );
  await addMembers(admin, dept.id, [colleague.id]);
  const manager = await createUser(
    admin,
    uniq('manager'),
    `${uniq('m')}@example.test`,
    { app: ['quality_manager'] },
  );

  // 决策来自授权服务与 seed 的真实授权，不手拼 conditions。
  const authz = app.container.resolve(authorizationToken) as any;
  const decision = await authz
    .for({ principal: { type: 'user', id: manager.id } })
    .authorize({ resource: { type: 'composite', id: 'fqc' }, action: 'ticket' });
  const read = decision.conditions?.database?.fqcTickets?.read;
  expect(read).toBeTruthy();
  expect(read.scope).toBe(true);

  const session = await signInAs(testApp, manager.username);
  const hit = await expectJson(
    await session.fetch(candidatesPath(dept.id, colleague.name)),
    200,
  );
  expect(hit.data.map((row: any) => row.id)).toContain(colleague.id);
  for (const row of hit.data) {
    expect(Object.keys(row).sort()).toEqual(['id', 'name', 'username']);
  }

  // 同一身份并发转派：真 Postgres 两个事务，至多一个成功。
  const ticket = await insertTicket(connection, dept.id);
  const otherManager = await createUser(
    admin,
    uniq('manager2'),
    `${uniq('m2')}@example.test`,
    { app: ['quality_manager'] },
  );
  const otherSession = await signInAs(testApp, otherManager.username);
  const transition = (s: TestSession) =>
    s.fetch(`/quality/tickets/${ticket.id}/transitions`,
      json({ name: 'reassign', input: { departmentId: dept.id } }));
  const [ra, rb] = await Promise.allSettled([transition(session), transition(otherSession)]);
  const statuses = [ra, rb]
    .map((r) => (r.status === 'fulfilled' ? r.value.status : -1))
    .sort();
  expect(statuses).toEqual([200, 409]);
  const stored = await connection.repository('fqcTickets').findOne({ filter: { id: ticket.id } });
  expect(stored?.lifecycleVersion).toBe(1);
});

test('R-003 验收12：q 超过 64 个字符回 400', async ({ testApp }) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const dept = await createDepartment(admin, uniq('longq'));
  const manager = await createUser(
    admin,
    uniq('longqmgr'),
    `${uniq('lq')}@example.test`,
    { app: ['quality_manager'] },
  );
  const session = await signInAs(testApp, manager.username);
  const error = await expectError(
    await session.fetch(candidatesPath(dept.id, 'x'.repeat(65))),
    400,
  );
  expect(error.status).toBe('INVALID_ARGUMENT');
});
