import { randomUUID } from 'node:crypto';

import {
  DEFAULT_ADMIN_CREDENTIALS,
  signIn,
  type TestSession,
} from '@nocobase/app-plugin-authentication/testing';
import { authorizationToken } from '@nocobase/app-plugin-authorization/server';
import { databaseManagerToken, type DatabaseConnection } from '@nocobase/db';
import { userManagementServiceToken } from '@nocobase/app-plugin-users/server';
import type { ServiceToken } from '@nocobase/service-provider';
import { expect, vi } from 'vitest';

import { createAppTest } from '../helpers/test-app.js';
import { createStandaloneServer } from '../../server/standalone.js';
import { departmentMutationsToken } from '../../server/providers/department-mutations.js';
import {
  DatabaseEmployeeMutations,
  employeeMutationsToken,
  EmployeeRuleError,
} from '../../server/providers/employees.js';
import {
  employeeServiceToken,
  type EmployeeChangeRecord,
  type EmployeeRecord,
} from '../../server/providers/employee-service.js';

/**
 * R-011 第三方审计复现：并发交错、变更多日期、合成邮箱占位、变动记录 404。
 *
 * 五种交错都在真 Postgres 的两条事务里跑：第一个事务做完校验和写入后停在提交之前，
 * 第二个事务随后进入自己的事务（取锁/校验），再放第一个提交。修复前第二个事务读到的
 * 是提交前快照，两边都成功；修复后它要么排队、要么被拒，只有一个成功。
 * 测试里只给服务换一条带钩子的 `database` 依赖，不改生产代码也不碰共享的依赖目录。
 */
const test = createAppTest({
  createServer: createStandaloneServer,
  config: {
    app: { publicOrigin: 'http://localhost' },
    auth: { secret: 'test-auth-secret-at-least-32-characters' },
  },
});

const PASSWORD = 'R011-audit-fixes-123!';
const headers = { 'content-type': 'application/json', origin: 'http://localhost' };
const jsonHeaders = () => ({ ...headers, 'Idempotency-Key': randomUUID() });
const unique = (prefix: string): string =>
  `${prefix}${randomUUID().replaceAll('-', '').slice(0, 10)}`;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

interface Row {
  [key: string]: unknown;
}

type MutationDeps = ConstructorParameters<typeof DatabaseEmployeeMutations>;
type Outcome<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown };

const ruleOf = <T>(outcome: Outcome<T>): string | undefined =>
  outcome.ok === false && outcome.error instanceof EmployeeRuleError
    ? outcome.error.code
    : undefined;

function resolveDeps(app: {
  container: { resolve<T>(token: ServiceToken<T>): T };
}): MutationDeps {
  // 用容器里的真实依赖，只替换 database 这一项以便加事务钩子。
  return [
    app.container.resolve(databaseManagerToken),
    app.container.resolve(userManagementServiceToken),
    app.container.resolve(departmentMutationsToken),
    app.container.resolve(employeeServiceToken),
    app.container.resolve(authorizationToken),
  ];
}

function instrumentedMutations(
  deps: MutationDeps,
  hooks: { readonly onStart?: () => void; readonly beforeCommit?: () => Promise<void> },
): DatabaseEmployeeMutations {
  const [database, users, departmentMutations, reader, authz] = deps;
  const observed = new Proxy(database, {
    get(target, property, receiver) {
      if (property !== 'transaction') {
        const value = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      }
      return (work: (tx: DatabaseConnection) => Promise<unknown>) =>
        target.transaction(async (tx) => {
          hooks.onStart?.();
          const result = await work(tx);
          // 仍在这个事务里：提交被扣住，第二个事务看到的是提交前的快照。
          if (hooks.beforeCommit !== undefined) await hooks.beforeCommit();
          return result;
        });
    },
  });
  return new DatabaseEmployeeMutations(observed, users, departmentMutations, reader, authz);
}

/** 两个真事务交错：第一个停在提交前，第二个进入事务后才放行。 */
async function race<T>(
  deps: MutationDeps,
  first: (mutations: DatabaseEmployeeMutations) => Promise<T>,
  second: (mutations: DatabaseEmployeeMutations) => Promise<T>,
): Promise<readonly [Outcome<T>, Outcome<T>]> {
  const held = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const secondStarted = Promise.withResolvers<void>();
  let heldOnce = false;
  const firstMutations = instrumentedMutations(deps, {
    beforeCommit: async () => {
      if (heldOnce) return;
      heldOnce = true;
      held.resolve();
      await release.promise;
    },
  });
  const secondMutations = instrumentedMutations(deps, {
    onStart: () => secondStarted.resolve(),
  });
  const firstRun = first(firstMutations).then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  await held.promise;
  const secondRun = second(secondMutations).then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  try {
    await Promise.race([secondStarted.promise, sleep(5_000)]);
    await sleep(50);
  } finally {
    release.resolve();
  }
  return [await firstRun, await secondRun];
}

const dataOf = async (response: Response): Promise<Row> => {
  const text = await response.text();
  expect(response.status).toBe(201);
  return (JSON.parse(text) as { data: Row }).data;
};

const hire = async (session: TestSession, extra: Record<string, unknown> = {}): Promise<Row> => {
  const name = unique('Emp');
  return await dataOf(
    await session.fetch('/employees', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({
        name,
        username: name,
        hiredOn: '2026-01-05',
        password: PASSWORD,
        ...extra,
      }),
    }),
  );
};

const leave = async (session: TestSession, userId: string): Promise<void> => {
  const response = await session.fetch(`/employees/${userId}/leave`, {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify({ leftOn: '2026-03-01' }),
  });
  expect(response.status).toBe(201);
};

const addPosition = async (connection: DatabaseConnection, id: string): Promise<void> => {
  const now = new Date();
  await connection.repository<Row>('positions').createOne({
    values: { id, title: id, active: true, sortOrder: 0, createdAt: now, updatedAt: now },
  });
};

const addGrade = async (connection: DatabaseConnection, id: string): Promise<void> => {
  const now = new Date();
  await connection.repository<Row>('jobGrades').createOne({
    values: { id, title: id, rank: 1, active: true, createdAt: now, updatedAt: now },
  });
};

const profileOf = async (
  connection: DatabaseConnection,
  userId: string,
): Promise<EmployeeRecord | undefined> =>
  await connection.repository<EmployeeRecord>('employees').findOne({ filter: { userId } });

const changeKinds = async (
  connection: DatabaseConnection,
  userId: string,
): Promise<readonly string[]> => {
  const rows = await connection
    .repository<EmployeeChangeRecord>('employeeChanges')
    .findMany({ filter: { userId } });
  // 断言的是「每类各一行」，不是物理行序；不变量 5 关心的是重复行。
  return rows.map((row) => row.kind).sort();
};

test('[P2] R-011 不变量4: 离职与「把下属挂到离职者名下」并发，只有一个能成', { timeout: 40_000 }, async ({
  app,
  testApp,
  connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const actorId = String(admin.user.id);
  const manager = await hire(admin);
  const report = await hire(admin);
  const deps = resolveDeps(app);

  const [first, second] = await race(
    deps,
    (mutations) =>
      mutations.leave(String(manager.userId), { leftOn: '2026-03-01' }, actorId),
    (mutations) =>
      mutations.update(String(report.userId), { reportsToUserId: String(manager.userId) }, actorId),
  );

  expect(first.ok, `离职应当成功：${String(first.ok === false ? first.error : '')}`).toBe(true);
  expect(ruleOf(second)).toBe('reports-to-not-active');
  const left = await profileOf(connection, String(manager.userId));
  expect(left?.status).toBe('left');
  const subordinate = await profileOf(connection, String(report.userId));
  expect(subordinate?.reportsToUserId).toBeNull();
  expect(await changeKinds(connection, String(manager.userId))).toEqual(['hired', 'left']);
  expect(await changeKinds(connection, String(report.userId))).toEqual(['hired']);
});

test('[P3] R-011 不变量3: A→B 与 B→A 同时提交不会成环', { timeout: 40_000 }, async ({
  app,
  testApp,
  connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const actorId = String(admin.user.id);
  const a = await hire(admin);
  const b = await hire(admin);
  const deps = resolveDeps(app);

  const [first, second] = await race(
    deps,
    (mutations) =>
      mutations.update(String(a.userId), { reportsToUserId: String(b.userId) }, actorId),
    (mutations) =>
      mutations.update(String(b.userId), { reportsToUserId: String(a.userId) }, actorId),
  );

  expect(first.ok, `第一个调岗应当成功：${String(first.ok === false ? first.error : '')}`).toBe(true);
  expect(ruleOf(second)).toBe('reports-to-cycle');
  const afterA = await profileOf(connection, String(a.userId));
  const afterB = await profileOf(connection, String(b.userId));
  expect(afterA?.reportsToUserId).toBe(String(b.userId));
  expect(afterB?.reportsToUserId).toBeNull();
});

test('[P4-position] R-011 不变量6: 停用岗位与把岗位给在职员工并发，只有一个能成', { timeout: 40_000 }, async ({
  app,
  testApp,
  connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const actorId = String(admin.user.id);
  const position = `POS-${unique('X')}`;
  await addPosition(connection, position);
  const employee = await hire(admin);
  const deps = resolveDeps(app);

  const [first, second] = await race(
    deps,
    (mutations) => mutations.updatePosition(position, { active: false }),
    (mutations) =>
      mutations.update(String(employee.userId), { positionId: position }, actorId),
  );

  expect(first.ok, `岗位停用应当成功：${String(first.ok === false ? first.error : '')}`).toBe(true);
  expect(ruleOf(second)).toBe('position-inactive');
  const row = await connection.repository<Row>('positions').findOne({ filter: { id: position } });
  expect(row?.active).toBe(false);
  const after = await profileOf(connection, String(employee.userId));
  expect(after?.positionId).toBeNull();
});

test('[P4-grade] R-011 不变量6: 停用职级与把职级给在职员工并发，只有一个能成', { timeout: 40_000 }, async ({
  app,
  testApp,
  connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const actorId = String(admin.user.id);
  const grade = `GRADE-${unique('X')}`;
  await addGrade(connection, grade);
  const employee = await hire(admin);
  const deps = resolveDeps(app);

  const [first, second] = await race(
    deps,
    (mutations) => mutations.updateGrade(grade, { active: false }),
    (mutations) =>
      mutations.update(String(employee.userId), { gradeId: grade }, actorId),
  );

  expect(first.ok, `职级停用应当成功：${String(first.ok === false ? first.error : '')}`).toBe(true);
  expect(ruleOf(second)).toBe('grade-inactive');
  const row = await connection.repository<Row>('jobGrades').findOne({ filter: { id: grade } });
  expect(row?.active).toBe(false);
  const after = await profileOf(connection, String(employee.userId));
  expect(after?.gradeId).toBeNull();
});

test('[P1] R-011 不变量5: 两个离职同时打同一个人只留一行 left', { timeout: 40_000 }, async ({
  app,
  testApp,
  connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const actorId = String(admin.user.id);
  const employee = await hire(admin);
  const deps = resolveDeps(app);

  const [first, second] = await race(
    deps,
    (mutations) =>
      mutations.leave(String(employee.userId), { leftOn: '2026-03-01' }, actorId),
    (mutations) =>
      mutations.leave(String(employee.userId), { leftOn: '2026-03-01' }, actorId),
  );

  expect(first.ok, `第一个离职应当成功：${String(first.ok === false ? first.error : '')}`).toBe(true);
  expect(ruleOf(second)).toBe('already-left');
  expect(await changeKinds(connection, String(employee.userId))).toEqual(['hired', 'left']);
});

test('[P9] R-011 不变量5: 两个复聘同时打同一个人只留一行 rehired', { timeout: 40_000 }, async ({
  app,
  testApp,
  connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const actorId = String(admin.user.id);
  const employee = await hire(admin);
  await leave(admin, String(employee.userId));
  const deps = resolveDeps(app);

  const [first, second] = await race(
    deps,
    (mutations) =>
      mutations.rehire(String(employee.userId), { hiredOn: '2026-04-01' }, actorId),
    (mutations) =>
      mutations.rehire(String(employee.userId), { hiredOn: '2026-04-01' }, actorId),
  );

  expect(first.ok, `第一个复聘应当成功：${String(first.ok === false ? first.error : '')}`).toBe(true);
  expect(ruleOf(second)).toBe('not-left');
  expect(await changeKinds(connection, String(employee.userId))).toEqual([
    'hired',
    'left',
    'rehired',
  ]);
});

test('[TZ] R-011 调岗变动记录按 Asia/Shanghai 取「今天」', { timeout: 40_000 }, async ({
  app,
  testApp,
  connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const actorId = String(admin.user.id);
  const position = `POS-${unique('TZ')}`;
  await addPosition(connection, position);
  const employee = await hire(admin);
  const mutations = app.container.resolve(employeeMutationsToken);
  vi.useFakeTimers({ toFake: ['Date'] });
  try {
    // 2026-11-26 01:30 (UTC+8) = 2026-11-25 17:30Z；UTC 的「今天」还是 11-25。
    vi.setSystemTime(new Date('2026-11-25T17:30:00.000Z'));
    await mutations.update(String(employee.userId), { positionId: position }, actorId);
  } finally {
    vi.useRealTimers();
  }
  const rows = await connection
    .repository<EmployeeChangeRecord>('employeeChanges')
    .findMany({ filter: { userId: String(employee.userId), kind: 'position' } });
  expect(rows).toHaveLength(1);
  expect(String(rows[0]?.occurredOn)).toBe('2026-11-26');
});

test('[EMAIL] R-011 显式邮箱不能占住将来的合成地址', { timeout: 40_000 }, async ({
  testApp,
  connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const profiles = await connection.repository<Row>('employees').findMany();
  const max = Math.max(
    0,
    ...profiles.map((row) => Number(String(row.employeeNo).slice(1))).filter(Number.isFinite),
  );
  // 审计 P8：当时下一号是 E000001，显式邮箱写的是下一号的下一个 E000002。
  const reserved = `E${String(max + 2).padStart(6, '0')}@staff.invalid`;
  const name = unique('Reserved');
  const attempted = await admin.fetch('/employees', {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify({
      name,
      username: name,
      email: reserved,
      hiredOn: '2026-01-05',
      password: PASSWORD,
    }),
  });
  const attemptedBody = (await attempted.json()) as { error?: { reason?: string } };
  expect(attempted.status).toBe(400);
  expect(attemptedBody.error?.reason).toBe('SYNTHETIC_EMAIL_RESERVED');
  expect(
    await connection.repository<Row>('user').findMany({ filter: { email: reserved } }),
  ).toEqual([]);

  // 号没有被占住：不带邮箱的下一次入职照常成功。
  await hire(admin);
});

test('[404] R-011 变动记录端点对不存在的账号与详情端点一致回 404', { timeout: 40_000 }, async ({
  testApp,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const missing = randomUUID();
  const detail = await admin.fetch(`/employees/${missing}`);
  expect(detail.status).toBe(404);
  const changes = await admin.fetch(`/employees/${missing}/changes`);
  expect(changes.status).toBe(404);
});

/**
 * 下面三条补的是 hire/link 路径的结构锁缺口：hire/link 原来只经 nextEmployeeNo 取工号锁，
 * 与字典停用、离职不在同一把锁上，交错时两个事务都成功，留下指向停用岗位/已离职上级的在职档案。
 * 第三条还守住 update 的结构锁必须在 requireActiveProfile 读档案状态之前：把锁挪到读之后，
 * 原有 9 条仍全绿，只有这条会红。
 */
test('[GAP-HIRE-POS] R-011 不变量6: 岗位停用与入职并发，入职被拒且没有档案指向停用岗位', { timeout: 40_000 }, async ({
  app,
  testApp,
  connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const actorId = String(admin.user.id);
  const position = `POS-${unique('X')}`;
  await addPosition(connection, position);
  const deps = resolveDeps(app);
  const name = unique('HirePos');

  const [first, second] = await race(
    deps,
    (mutations) => mutations.updatePosition(position, { active: false }),
    (mutations) =>
      mutations.hire(
        { name, username: name, hiredOn: '2026-01-05', password: PASSWORD, positionId: position },
        actorId,
      ),
  );

  expect(first.ok, `岗位停用应当成功：${String(first.ok === false ? first.error : '')}`).toBe(true);
  expect(ruleOf(second)).toBe('position-inactive');
  const row = await connection.repository<Row>('positions').findOne({ filter: { id: position } });
  expect(row?.active).toBe(false);
  // 被拒的入职不能建出档案，更不能留下指向停用岗位的在职档案。
  expect(
    await connection
      .repository<EmployeeRecord>('employees')
      .findMany({ filter: { positionId: position } }),
  ).toEqual([]);
});

test('[GAP-HIRE-BOSS] R-011 不变量3: 上级离职与带上级的入职并发，入职被拒且没有档案挂到已离职上级', { timeout: 40_000 }, async ({
  app,
  testApp,
  connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const actorId = String(admin.user.id);
  const manager = await hire(admin);
  const deps = resolveDeps(app);
  const name = unique('HireBoss');

  const [first, second] = await race(
    deps,
    (mutations) => mutations.leave(String(manager.userId), { leftOn: '2026-03-01' }, actorId),
    (mutations) =>
      mutations.hire(
        {
          name,
          username: name,
          hiredOn: '2026-01-05',
          password: PASSWORD,
          reportsToUserId: String(manager.userId),
        },
        actorId,
      ),
  );

  expect(first.ok, `上级离职应当成功：${String(first.ok === false ? first.error : '')}`).toBe(true);
  expect(ruleOf(second)).toBe('reports-to-not-active');
  const left = await profileOf(connection, String(manager.userId));
  expect(left?.status).toBe('left');
  expect(
    await connection
      .repository<EmployeeRecord>('employees')
      .findMany({ filter: { reportsToUserId: String(manager.userId) } }),
  ).toEqual([]);
});

test('[GAP-UPDATE-LEFT] R-011 不变量5: 本人离职与本人调岗并发，调岗被拒（结构锁在读档案状态之前）', { timeout: 40_000 }, async ({
  app,
  testApp,
  connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const actorId = String(admin.user.id);
  const position = `POS-${unique('X')}`;
  await addPosition(connection, position);
  const employee = await hire(admin);
  const deps = resolveDeps(app);

  const [first, second] = await race(
    deps,
    (mutations) => mutations.leave(String(employee.userId), { leftOn: '2026-03-01' }, actorId),
    (mutations) => mutations.update(String(employee.userId), { positionId: position }, actorId),
  );

  expect(first.ok, `离职应当成功：${String(first.ok === false ? first.error : '')}`).toBe(true);
  expect(ruleOf(second)).toBe('already-left');
  const after = await profileOf(connection, String(employee.userId));
  expect(after?.status).toBe('left');
  expect(after?.positionId).toBeNull();
  expect(await changeKinds(connection, String(employee.userId))).toEqual(['hired', 'left']);
});
