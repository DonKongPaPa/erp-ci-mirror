import { randomUUID } from 'node:crypto';

import {
  DEFAULT_ADMIN_CREDENTIALS,
  signIn,
  type TestSession,
} from '@nocobase/app-plugin-authentication/testing';
import { authorizationToken } from '@nocobase/app-plugin-authorization/server';
import { userManagementServiceToken } from '@nocobase/app-plugin-users/server';
import type { DatabaseConnection } from '@nocobase/db';
import { userAdministrationServiceToken } from '@nocobase/app-plugin-authentication';
import { expect } from 'vitest';

import { createAppTest } from '../helpers/test-app.js';
import { createStandaloneServer } from '../../server/standalone.js';
import { employeeServiceToken } from '../../server/providers/employee-service.js';
import { employeeMutationsToken } from '../../server/providers/employees.js';

/**
 * R-011 S4/S5/S6 的端点验收，只在真 Postgres 上跑。
 *
 * 本机 SQLite 上显示为 skipped，不是通过：工号发号、整批回滚、会话删除都依赖
 * Postgres 的事务行为。授权矩阵用真实登录会话打真实端点，不用替身。
 */
const pgOnly = process.env.NOCOBASE_TEST_DB_DIALECT === 'postgres';
const test = createAppTest({
  createServer: createStandaloneServer,
  config: {
    app: { publicOrigin: 'http://localhost' },
    auth: { secret: 'test-auth-secret-at-least-32-characters' },
  },
});

const PASSWORD = 'R011-employee-123!';
const json = (body: unknown, method = 'POST') => ({
  method,
  headers: {
    'content-type': 'application/json',
    origin: 'http://localhost',
    'Idempotency-Key': `${Date.now()}.${randomUUID()}`,
  },
  body: JSON.stringify(body),
});

interface ErrorBody {
  error: { status: string; reason: string; message: string; metadata?: { reason?: string } };
}

interface Row {
  [key: string]: unknown;
}

const expectJson = async (response: Response, status: number): Promise<unknown> => {
  const text = await response.text();
  expect(response.status).toBe(status);
  return JSON.parse(text) as unknown;
};

const expectError = async (response: Response, status: number): Promise<ErrorBody['error']> =>
  ((await expectJson(response, status)) as ErrorBody).error;

const expectDenied = async (response: Response, what: string): Promise<void> => {
  const error = await expectError(response, 403);
  expect(error.reason, `${what}: ${error.reason}`).toBe('AUTHORIZATION_DENIED');
};

const unique = (prefix: string): string =>
  `${prefix}${randomUUID().replaceAll('-', '').slice(0, 10)}`;

const dataOf = async (response: Response, status: number): Promise<Row> =>
  ((await expectJson(response, status)) as { data: Row }).data;

const grant = async (
  app: Parameters<Parameters<typeof test>[0]>['app'],
  userId: string,
  grants: readonly Record<string, unknown>[],
): Promise<void> => {
  const sets = app.container.resolve(authorizationToken).permissionSets;
  const key = unique('r011set');
  await sets.create({ key, grants: grants as never });
  await sets.assign({ subject: { type: 'user', id: userId }, permissionSet: key });
};

const employeeGrant = (actions: readonly string[]) => ({
  resource: { type: 'composite', id: 'employees' },
  actions: actions.map((action) => ({
    action,
    policy: {
      type: 'composite',
      scopes: {
        employees: 'allRecords',
        employeeChanges: 'allRecords',
        positions: 'allRecords',
        jobGrades: 'allRecords',
      },
    },
  })),
});

const departmentGrant = {
  resource: { type: 'composite', id: 'departments' },
  actions: [
    {
      action: 'manage',
      policy: {
        type: 'composite',
        scopes: {
          departments: 'allRecords',
          departmentMembers: 'allRecords',
          departmentMemberHistory: 'allRecords',
        },
      },
    },
  ],
};

const userGrant = (actions: readonly string[]) => ({
  resource: { type: 'user', id: '*' },
  actions: actions.map((action) => ({ action })),
});

const makeUser = async (
  admin: TestSession,
  testApp: Parameters<typeof signIn>[0],
  roles: readonly string[],
): Promise<{ id: string; username: string; session: TestSession }> => {
  const username = unique('r011u');
  const created = await dataOf(
    await admin.fetch(
      '/users',
      json({
        name: username,
        username,
        email: `${username}@example.test`,
        password: PASSWORD,
        roleScopes: { app: [...roles] },
      }),
    ),
    201,
  );
  return {
    id: String(created.id),
    username,
    session: await signIn(testApp, { username, password: PASSWORD }),
  };
};

const hire = async (
  session: TestSession,
  input: Record<string, unknown> = {},
): Promise<Row> => {
  const name = unique('Hire');
  return await dataOf(
    await session.fetch('/employees', json({
      name,
      username: name,
      hiredOn: '2026-01-05',
      ...input,
    })),
    201,
  );
};

const department = async (admin: TestSession): Promise<Row> => {
  const tag = unique('D');
  return await dataOf(
    await admin.fetch('/departments', json({ title: tag, code: tag, kind: 'company' })),
    201,
  );
};

const hireWithDepartment = async (
  admin: TestSession,
  departmentId: string,
  input: Record<string, unknown> = {},
): Promise<Row> =>
  await hire(admin, { primaryDepartmentId: departmentId, ...input });

const changesOf = async (connection: DatabaseConnection, userId: string): Promise<Row[]> =>
  await connection.repository<Row>('employeeChanges').findMany({ filter: { userId } });

const membershipsOf = async (connection: DatabaseConnection, userId: string): Promise<Row[]> =>
  await connection.repository<Row>('departmentMembers').findMany({ filter: { userId } });

const userOf = async (
  app: Parameters<Parameters<typeof test>[0]>['app'],
  userId: string,
): Promise<{ id: string; email: string; disabledAt: Date | null; kind: string; roleScopes: Record<string, string[]> }> =>
  await app.container.resolve(userManagementServiceToken).get(userId) as never;

test('R-011 验收1: hire without a department creates one account, one profile and one change', { skip: !pgOnly }, async ({
  testApp,
  app,
  connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const profile = await hire(admin);
  const userId = String(profile.userId);

  expect(String(profile.employeeNo)).toMatch(/^E\d{6}$/);
  expect(profile.status).toBe('active');
  expect(Object.keys(profile).some((key) => key.toLowerCase().includes('email'))).toBe(false);
  const users = app.container.resolve(userManagementServiceToken);
  expect((await users.get(userId)).roleScopes.app).toContain('member');
  expect(await connection.repository<Row>('employees').count({ filter: { userId } })).toBe(1);
  const changes = await changesOf(connection, userId);
  expect(changes.map((row) => row.kind)).toEqual(['hired']);
  expect(await membershipsOf(connection, userId)).toHaveLength(0);
});

test('R-011 验收4: no-email accounts use staff.invalid and cannot sign in', { skip: !pgOnly }, async ({
  testApp,
  app,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const profile = await hire(admin);
  const userId = String(profile.userId);
  const email = (await userOf(app, userId)).email;
  expect(email.endsWith('@staff.invalid')).toBe(true);
  await expect(signIn(testApp, { email, password: PASSWORD })).rejects.toThrow();

  const used = unique('used');
  await makeUser(admin, testApp, []);
  const other = await dataOf(
    await admin.fetch('/users', json({
      name: used,
      username: used,
      email: `${used}@example.test`,
      password: PASSWORD,
      roleScopes: { app: [] },
    })),
    201,
  );
  const error = await expectError(
    await admin.fetch('/employees', json({
      name: unique('Hire'),
      hiredOn: '2026-01-05',
      email: String(other.email),
    })),
    409,
  );
  expect(error.reason).toBe('USER_EMAIL_CONFLICT');
});

test('R-011 验收2: a primary department needs departments.manage before any write', { skip: !pgOnly }, async ({
  testApp,
  app,
  connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const dept = await department(admin);
  const changesBefore = await connection.repository<Row>('employeeChanges').count();
  const profilesBefore = await connection.repository<Row>('employees').count();
  const noDept = await makeUser(admin, testApp, []);
  await grant(app, noDept.id, [
    employeeGrant(['view', 'manage']),
    userGrant(['create', 'assign-role']),
  ]);

  const accountsBefore = await connection.repository<Row>('user').count();
  await expectDenied(
    await noDept.session.fetch('/employees', json({
      name: unique('Hire'),
      hiredOn: '2026-01-05',
      primaryDepartmentId: dept.id,
    })),
    '缺管理部门',
  );
  // 被拒发生在开事务之前：三张表一行都不多（不是 count()>=0 那种怎样都绿的断言）。
  expect(await connection.repository<Row>('employeeChanges').count()).toBe(changesBefore);
  expect(await connection.repository<Row>('employees').count()).toBe(profilesBefore);
  expect(await connection.repository<Row>('user').count()).toBe(accountsBefore);

  await grant(app, noDept.id, [departmentGrant]);
  const profile = await hireWithDepartment(admin, String(dept.id));
  expect(await membershipsOf(connection, String(profile.userId))).toHaveLength(1);
  const history = await connection.repository<Row>('departmentMemberHistory').findMany({
    filter: { userId: String(profile.userId) },
  });
  expect(history).toHaveLength(2); // addMembers + setPrimaryDepartment
});

test('R-011 验收5: link refuses an existing profile and service accounts', { skip: !pgOnly }, async ({
  testApp,
  app,
  connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const profile = await hire(admin);
  const existing = await expectError(
    await admin.fetch('/employees/link', json({ userId: profile.userId, hiredOn: '2026-01-05' })),
    409,
  );
  expect(existing.reason).toBe('PROFILE_EXISTS');

  const service = await app.container
    .resolve(userAdministrationServiceToken)
    .createServiceAccount({ name: unique('svc') });
  const serviceError = await expectError(
    await admin.fetch('/employees/link', json({ userId: service.id, hiredOn: '2026-01-05' })),
    422,
  );
  expect(serviceError.reason).toBe('SERVICE_ACCOUNT');

  const plain = await makeUser(admin, testApp, []);
  const before = await connection.repository<Row>('user').count();
  const linked = await dataOf(
    await admin.fetch('/employees/link', json({ userId: plain.id, hiredOn: '2026-02-01' })),
    201,
  );
  expect(linked.userId).toBe(plain.id);
  expect(await connection.repository<Row>('user').count()).toBe(before);
});

test('R-011 验收6: position, grade and supervisor changes append one row each', { skip: !pgOnly }, async ({
  testApp,
  app,
  connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const position = await dataOf(await admin.fetch('/positions', json({ id: unique('P'), title: 'Engineer' })), 201);
  const grade = await dataOf(await admin.fetch('/job-grades', json({ id: unique('G'), title: 'P5', rank: 5 })), 201);
  const boss = await hire(admin);
  const person = await hire(admin, {
    positionId: position.id,
    gradeId: grade.id,
    reportsToUserId: boss.userId,
  });
  const newGrade = await dataOf(await admin.fetch('/job-grades', json({ id: unique('G'), title: 'P6', rank: 6 })), 201);
  const updated = await dataOf(
    await admin.fetch(`/employees/${person.userId}`, json({
      positionId: null,
      gradeId: newGrade.id,
    }, 'PATCH'),
    ),
    200,
  );
  expect(updated.positionName).toBeNull();
  expect(updated.gradeName).toBe('P6');
  const kinds = (await changesOf(connection, String(person.userId))).map((row) => row.kind);
  expect(kinds).toContain('position');
  expect(kinds).toContain('grade');

  const selfError = await expectError(
    await admin.fetch(`/employees/${person.userId}`, json({ reportsToUserId: person.userId }, 'PATCH')),
    409,
  );
  expect(selfError.reason).toBe('REPORTS_TO_SELF');
  const cycleError = await expectError(
    await admin.fetch(`/employees/${boss.userId}`, json({ reportsToUserId: person.userId }, 'PATCH')),
    409,
  );
  expect(cycleError.reason).toBe('REPORTS_TO_CYCLE');
  void app;
});

test('R-011 验收7: leaving revokes sessions, removes memberships and rolls back as one', { skip: !pgOnly }, async ({
  testApp,
  app,
  connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const dept = await department(admin);
  const person = await hireWithDepartment(admin, String(dept.id), { password: PASSWORD });
  const userId = String(person.userId);
  const session = await signIn(testApp, {
    username: String(person.username),
    password: PASSWORD,
  });
  expect(await connection.repository<Row>('session').count({ filter: { userId } })).toBeGreaterThan(0);

  // 停用那一步失败：档案、成员关系、两张变动记录表与账号状态都必须和操作前一样。
  const users = app.container.resolve(userManagementServiceToken);
  const originalWithConnection = users.withConnection.bind(users);
  users.withConnection = ((tx: never) => {
    const bound = originalWithConnection(tx);
    return new Proxy(bound, {
      get(target, property, receiver) {
        if (property === 'disable') {
          return async () => {
            throw new Error('disable failed on purpose');
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }) as typeof users.withConnection;
  try {
    await expectError(
      await admin.fetch(`/employees/${userId}/leave`, json({ leftOn: '2026-03-01' })),
      500,
    );
  } finally {
    users.withConnection = originalWithConnection;
  }
  expect((await userOf(app, userId)).disabledAt).toBeNull();
  expect(await membershipsOf(connection, userId)).toHaveLength(1);
  expect((await changesOf(connection, userId)).map((row) => row.kind)).toEqual(['hired']);

  const result = await dataOf(
    await admin.fetch(`/employees/${userId}/leave`, json({ leftOn: '2026-03-01', note: 'resignation' })),
    201,
  );
  expect(result.status).toBe('left');
  expect((await userOf(app, userId)).disabledAt).not.toBeNull();
  expect(await connection.repository<Row>('session').count({ filter: { userId } })).toBe(0);
  expect(await membershipsOf(connection, userId)).toHaveLength(0);
  const history = await connection.repository<Row>('departmentMemberHistory').findMany({ filter: { userId } });
  expect(history).toHaveLength(3);
  // 入职的 addMembers 与 setPrimaryDepartment 各起一个批次（R-012 现有行为），离职共用第三个。
  expect(new Set(history.map((row) => row.batchId)).size).toBe(3);
  const kinds = (await changesOf(connection, userId)).map((row) => row.kind);
  expect(new Set(kinds)).toEqual(new Set(['hired', 'left']));
  expect(session.cookie).toBeTruthy();
});

test('R-011 验收9: every departure guard gives its own reason', { skip: !pgOnly }, async ({
  testApp,
  app,
  connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const dept = await department(admin);
  const manager = await hireWithDepartment(admin, String(dept.id));
  await admin.fetch(`/departments/${dept.id}`, json({ managerId: manager.userId }, 'PATCH'));
  const managerError = await expectError(
    await admin.fetch(`/employees/${manager.userId}/leave`, json({ leftOn: '2026-03-01' })),
    409,
  );
  expect(managerError.reason).toBe('IS_DEPARTMENT_MANAGER');

  const boss = await hire(admin);
  const report = await hire(admin, { reportsToUserId: boss.userId, password: PASSWORD });
  const reportError = await expectError(
    await admin.fetch(`/employees/${boss.userId}/leave`, json({ leftOn: '2026-03-01' })),
    409,
  );
  expect(reportError.reason).toBe('HAS_DIRECT_REPORTS');

  await grant(app, String(report.userId), [employeeGrant(['manage']), userGrant(['disable']), departmentGrant]);
  const reportSession = await signIn(testApp, { username: String(report.username), password: PASSWORD });
  const selfError = await expectError(
    await reportSession.fetch(`/employees/${report.userId}/leave`, json({ leftOn: '2026-03-01' })),
    409,
  );
  expect(selfError.reason).toBe('SELF_LEAVE');

  const clean = await hire(admin);
  const service = app.container.resolve(employeeServiceToken);
  const offboard = service.registerOffboardCheck(async (id) =>
    id === clean.userId ? 'open tickets' : null,
  );
  try {
    const blocked = await expectError(
      await admin.fetch(`/employees/${clean.userId}/leave`, json({ leftOn: '2026-03-01' })),
      409,
    );
    expect(blocked.reason).toBe('OFFBOARD_REJECTED');
    expect(blocked.message).toContain('open tickets');
  } finally {
    offboard();
  }

  const protectedUser = await makeUser(admin, testApp, []);
  await app.container.resolve(authorizationToken).permissionSets.assign({
    subject: { type: 'user', id: protectedUser.id },
    permissionSet: 'root',
  });
  const operator = await makeUser(admin, testApp, []);
  await grant(app, operator.id, [
    employeeGrant(['manage']),
    userGrant(['disable']),
    departmentGrant,
  ]);
  const protectedProfile = await dataOf(
    await admin.fetch('/employees/link', json({ userId: protectedUser.id, hiredOn: '2026-01-01' })),
    201,
  );
  const protectedError = await expectError(
    await operator.session.fetch(`/employees/${protectedProfile.userId}/leave`, json({ leftOn: '2026-03-01' })),
    403,
  );
  expect(protectedError.reason).toBe('ACCOUNT_PROTECTED');
  void connection;
});

test('R-011 验收10: rehire keeps the number, accepts a new position and can join a department', { skip: !pgOnly }, async ({
  testApp,
  app,
  connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const oldPosition = await dataOf(await admin.fetch('/positions', json({ id: unique('P'), title: 'Old' })), 201);
  const newPosition = await dataOf(await admin.fetch('/positions', json({ id: unique('P'), title: 'New' })), 201);
  const dept = await department(admin);
  const person = await hireWithDepartment(admin, String(dept.id), { positionId: oldPosition.id });
  const userId = String(person.userId);
  const employeeNo = String(person.employeeNo);
  const notLeft = await expectError(
    await admin.fetch(`/employees/${userId}/rehire`, json({ hiredOn: '2026-04-01' })),
    409,
  );
  expect(notLeft.reason).toBe('NOT_LEFT');
  await admin.fetch(`/employees/${userId}/leave`, json({ leftOn: '2026-03-01' }));

  await admin.fetch(`/positions/${oldPosition.id}`, json({ active: false }, 'PATCH'));
  const inactive = await expectError(
    await admin.fetch(`/employees/${userId}/rehire`, json({ hiredOn: '2026-04-01' })),
    422,
  );
  expect(inactive.reason).toBe('POSITION_INACTIVE');

  const rehired = await dataOf(
    await admin.fetch(`/employees/${userId}/rehire`, json({
      hiredOn: '2026-04-01',
      primaryDepartmentId: dept.id,
      positionId: newPosition.id,
    })),
    201,
  );
  expect(rehired.employeeNo).toBe(employeeNo);
  expect(rehired.status).toBe('active');
  expect(rehired.leftOn).toBeNull();
  expect(rehired.positionName).toBe('New');
  expect((await userOf(app, userId)).disabledAt).toBeNull();
  expect(await membershipsOf(connection, userId)).toHaveLength(1);
  const kinds = (await changesOf(connection, userId)).map((row) => row.kind);
  expect(new Set(kinds)).toEqual(new Set(['hired', 'left', 'rehired', 'position']));
});

test('R-011 验收11/12/13: authorization matrix and per-entry columns', { skip: !pgOnly }, async ({
  testApp,
  app,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const profile = await hire(admin);
  const noView = await makeUser(admin, testApp, ['quality_manager']);
  const deptManager = await makeUser(admin, testApp, ['dept_manager']);
  const staff = await makeUser(admin, testApp, ['staff']);
  const unrelated = await makeUser(admin, testApp, []);
  for (const session of [noView.session, deptManager.session, staff.session, unrelated.session]) {
    await expectDenied(await session.fetch('/employees'), '读要查看员工');
  }
  for (const session of [noView.session, deptManager.session, staff.session, unrelated.session]) {
    await expectDenied(
      await session.fetch('/employees', json({ name: unique('Hire'), hiredOn: '2026-01-05' })),
      '写要管理员工',
    );
  }

  const managerNoAccountActions = await makeUser(admin, testApp, []);
  await grant(app, managerNoAccountActions.id, [employeeGrant(['view', 'manage'])]);
  await expectDenied(
    await managerNoAccountActions.session.fetch('/employees', json({ name: unique('Hire'), hiredOn: '2026-01-05' })),
    '缺建账号与分配角色',
  );

  const managerNoDisable = await makeUser(admin, testApp, []);
  await grant(app, managerNoDisable.id, [
    employeeGrant(['view', 'manage']),
    userGrant(['create', 'assign-role', 'enable']),
    departmentGrant,
  ]);
  await expectDenied(
    await managerNoDisable.session.fetch(`/employees/${profile.userId}/leave`, json({ leftOn: '2026-03-01' })),
    '缺停用账号',
  );
  const managerNoDepartment = await makeUser(admin, testApp, []);
  await grant(app, managerNoDepartment.id, [
    employeeGrant(['view', 'manage']),
    userGrant(['create', 'assign-role', 'disable']),
  ]);
  await expectDenied(
    await managerNoDepartment.session.fetch(`/employees/${profile.userId}/leave`, json({ leftOn: '2026-03-01' })),
    '缺管理部门',
  );

  const viewer = await makeUser(admin, testApp, []);
  await grant(app, viewer.id, [employeeGrant(['view'])]);
  const list = ((await expectJson(await viewer.session.fetch('/employees'), 200)) as { data: Row[] }).data;
  const detail = await dataOf(await viewer.session.fetch(`/employees/${profile.userId}`), 200);
  const changes = ((await expectJson(await viewer.session.fetch(`/employees/${profile.userId}/changes`), 200)) as { data: Row[] }).data;
  const candidates = ((await expectJson(await viewer.session.fetch('/employees/candidates?q=Hire'), 200)) as { data: Row[] }).data;
  for (const rows of [list, [detail], changes, candidates]) {
    for (const row of rows) {
      expect(Object.keys(row)).not.toContain('email');
    }
  }
  expect(Object.keys(list[0] ?? {})).not.toContain('leftOn');
  expect(Object.keys(list[0] ?? {})).not.toContain('reportsToName');
  expect(Object.keys(list[0] ?? {})).not.toContain('secondaryDepartmentNames');
  for (const key of ['leftOn', 'reportsToName', 'secondaryDepartmentNames']) {
    expect(Object.keys(detail)).toContain(key);
  }
  for (const row of changes) {
    expect(Object.keys(row)).toEqual([
      'kind', 'fromValue', 'toValue', 'occurredOn', 'note', 'actorName', 'createdAt',
    ]);
  }
  expect(Object.keys(candidates[0] ?? {})).toEqual([
    'userId', 'name', 'username', 'employeeNo', 'primaryDepartmentName',
  ]);
  await expectError(await viewer.session.fetch('/employees/candidates'), 400);
});

test('R-011 验收12: search never matches an email-only keyword', { skip: !pgOnly }, async ({
  testApp,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const name = unique('hidden');
  const tag = unique('mailtag');
  await admin.fetch('/users', json({
    name,
    username: name,
    email: `${tag}@example.test`,
    password: PASSWORD,
    roleScopes: { app: [] },
  }));
  const result = ((await expectJson(
    await admin.fetch(`/employees/candidates?q=${tag}`),
    200,
  )) as { data: Row[] }).data;
  expect(result).toEqual([]);
});

test('R-011 验收14: dictionaries deactivate but never delete', { skip: !pgOnly }, async ({
  testApp,
  connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const position = await dataOf(await admin.fetch('/positions', json({ id: unique('P'), title: 'Engineer' })), 201);
  const grade = await dataOf(await admin.fetch('/job-grades', json({ id: unique('G'), title: 'P5' })), 201);
  await hire(admin, { positionId: position.id, gradeId: grade.id });
  const positionError = await expectError(
    await admin.fetch(`/positions/${position.id}`, json({ active: false }, 'PATCH')),
    409,
  );
  expect(positionError.reason).toBe('POSITION_IN_USE');
  const gradeError = await expectError(
    await admin.fetch(`/job-grades/${grade.id}`, json({ active: false }, 'PATCH')),
    409,
  );
  expect(gradeError.reason).toBe('GRADE_IN_USE');

  const freePosition = await dataOf(await admin.fetch('/positions', json({ id: unique('P'), title: 'Temp' })), 201);
  const freeGrade = await dataOf(await admin.fetch('/job-grades', json({ id: unique('G'), title: 'T1' })), 201);
  const disabledPosition = await dataOf(
    await admin.fetch(`/positions/${freePosition.id}`, json({ title: 'Temp 2', active: false, sortOrder: 3 }, 'PATCH')),
    200,
  );
  expect(disabledPosition.active).toBe(false);
  expect(disabledPosition.title).toBe('Temp 2');
  const disabledGrade = await dataOf(
    await admin.fetch(`/job-grades/${freeGrade.id}`, json({ active: false }, 'PATCH')),
    200,
  );
  expect(disabledGrade.active).toBe(false);
  expect(await connection.repository<Row>('positions').count({ filter: { id: String(freePosition.id) } })).toBe(1);
  expect(await connection.repository<Row>('jobGrades').count({ filter: { id: String(freeGrade.id) } })).toBe(1);
});

test('R-011 验收16: internal service omits unknown ids and non-active supervisors', { skip: !pgOnly }, async ({
  testApp,
  app,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const person = await hire(admin);
  const service = app.container.resolve(employeeServiceToken);
  const displayed = await service.displayByIds([String(person.userId), 'missing-user']);
  expect(Object.keys(displayed)).toEqual([String(person.userId)]);
  expect(Object.keys(displayed[String(person.userId)])).toEqual([
    'userId', 'name', 'username', 'employeeNo', 'positionName',
  ]);
  expect(await service.isActive('missing-user')).toBe(false);
  expect(await service.isActive(String(person.userId))).toBe(true);
  expect(await service.reportsTo(String(person.userId))).toBeNull();
  expect(await service.getByUserId('missing-user')).toBeUndefined();
  const term = unique('nomatch');
  expect(await service.search(term, { limit: 10 })).toEqual([]);
  expect((await service.search('Hire', { limit: 10 })).length).toBeGreaterThan(0);
  void app;
});

test('R-011 验收8: disabling the account is the last write of the leave transaction', { skip: !pgOnly }, async ({
  testApp,
  app,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const person = await hire(admin, { password: PASSWORD });
  const mutations = app.container.resolve(employeeMutationsToken);
  const users = app.container.resolve(userManagementServiceToken);
  const order: string[] = [];

  type AppendFn = (...args: unknown[]) => Promise<unknown>;
  const proto = Object.getPrototypeOf(mutations) as { appendChange: AppendFn };
  const originalAppend = proto.appendChange;
  proto.appendChange = async function (this: unknown, ...args: unknown[]) {
    order.push('change');
    return (await Reflect.apply(originalAppend, this, args)) as unknown;
  };
  const originalWithConnection = users.withConnection.bind(users);
  users.withConnection = ((tx: never) => {
    const bound = originalWithConnection(tx);
    return new Proxy(bound, {
      get(target, property, receiver) {
        if (property === 'disable') {
          return async (...args: unknown[]) => {
            order.push('disable');
            const disable = Reflect.get(target, 'disable') as (...a: unknown[]) => Promise<unknown>;
            return await Reflect.apply(disable, target, args);
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }) as typeof users.withConnection;

  try {
    const response = await admin.fetch(`/employees/${person.userId}/leave`, json({ leftOn: '2026-03-01' }));
    expect(response.status).toBe(201);
  } finally {
    // 不管断言是否成功都要恢复，别让替身漏到别的用例里。
    proto.appendChange = originalAppend;
    users.withConnection = originalWithConnection;
  }
  expect(order).toEqual(['change', 'disable']);
  expect(order.at(-1)).toBe('disable');
});

test('R-011 验收11: rehire needs the users.enable action', { skip: !pgOnly }, async ({
  testApp,
  app,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const person = await hire(admin);
  await admin.fetch(`/employees/${person.userId}/leave`, json({ leftOn: '2026-03-01' }));
  const operator = await makeUser(admin, testApp, []);
  await grant(app, operator.id, [employeeGrant(['manage']), departmentGrant]);
  await expectDenied(
    await operator.session.fetch(`/employees/${person.userId}/rehire`, json({ hiredOn: '2026-04-01' })),
    '复聘缺启用账号',
  );
});

test('R-011 验收6: update refuses an inactive position and an inactive supervisor', { skip: !pgOnly }, async ({
  testApp,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const position = await dataOf(await admin.fetch('/positions', json({ id: unique('P'), title: 'Closed' })), 201);
  const grade = await dataOf(await admin.fetch('/job-grades', json({ id: unique('G'), title: 'Closed grade' })), 201);
  await admin.fetch(`/positions/${position.id}`, json({ active: false }, 'PATCH'));
  await admin.fetch(`/job-grades/${grade.id}`, json({ active: false }, 'PATCH'));
  const person = await hire(admin);

  const positionError = await expectError(
    await admin.fetch(`/employees/${person.userId}`, json({ positionId: position.id }, 'PATCH')),
    422,
  );
  expect(positionError.reason).toBe('POSITION_INACTIVE');
  const gradeError = await expectError(
    await admin.fetch(`/employees/${person.userId}`, json({ gradeId: grade.id }, 'PATCH')),
    422,
  );
  expect(gradeError.reason).toBe('GRADE_INACTIVE');

  const boss = await hire(admin);
  await admin.fetch(`/employees/${boss.userId}/leave`, json({ leftOn: '2026-03-01' }));
  const supervisorError = await expectError(
    await admin.fetch(`/employees/${person.userId}`, json({ reportsToUserId: boss.userId }, 'PATCH')),
    422,
  );
  expect(supervisorError.reason).toBe('REPORTS_TO_NOT_ACTIVE');
});
