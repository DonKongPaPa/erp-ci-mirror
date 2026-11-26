import { randomUUID } from 'node:crypto';

import { authenticationToken } from '@nocobase/app-plugin-authentication';
import {
  DEFAULT_ADMIN_CREDENTIALS,
  signIn,
  type TestSession,
} from '@nocobase/app-plugin-authentication/testing';
import { expect } from 'vitest';

import { createAppTest } from '../helpers/test-app.js';
import { createStandaloneServer } from '../../server/standalone.js';
import { employeeMutationsToken } from '../../server/providers/employees.js';

/**
 * R-011 验收 3/8 的 Postgres 部分：并发发号、离职后不复用、建账号中途回滚。
 * SQLite 单写者复现不出并发；R-056 后测试只连 Postgres，这些竞争一律真跑。
 */
const test = createAppTest({
  createServer: createStandaloneServer,
  config: {
    app: { publicOrigin: 'http://localhost' },
    auth: { secret: 'test-auth-secret-at-least-32-characters' },
  },
});

const PASSWORD = 'R011-concurrency-123!';
const json = (name: string) => ({
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    origin: 'http://localhost',
    'Idempotency-Key': `${Date.now()}.${randomUUID()}`,
  },
  body: JSON.stringify({ name, username: name, hiredOn: '2026-01-05', password: PASSWORD }),
});

interface Row {
  [key: string]: unknown;
}

const dataOf = async (response: Response): Promise<Row> => {
  const text = await response.text();
  expect(response.status).toBe(201);
  return ((JSON.parse(text) as { data: Row }).data);
};

const unique = (prefix: string): string =>
  `${prefix}${randomUUID().replaceAll('-', '').slice(0, 10)}`;

const hire = async (session: TestSession): Promise<Row> =>
  await dataOf(await session.fetch('/employees', json(unique('Hire'))));

test('R-011 验收3: concurrent hires on Postgres get distinct employee numbers', async ({
  testApp,
  connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const countBefore = await connection.repository<Row>('employees').count();

  const profiles = await Promise.all(Array.from({ length: 8 }, () => hire(admin)));
  const numbers = profiles.map((profile) => String(profile.employeeNo));

  expect(new Set(numbers).size).toBe(numbers.length);
  for (const number of numbers) {
    expect(number).toMatch(/^E\d{6}$/);
  }
  expect(await connection.repository<Row>('employees').count()).toBe(countBefore + 8);
  const stored = await connection.repository<Row>('employees').findMany();
  expect(new Set(stored.map((row) => String(row.employeeNo))).size).toBe(stored.length);
  await expect(
    connection.repository<Row>('employees').createOne({
      values: {
        id: randomUUID(),
        userId: unique('dup'),
        employeeNo: numbers[0] as string,
        hiredOn: '2026-01-05',
        status: 'active',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    }),
  ).rejects.toThrow();
});

test('R-011 验收3: a departure never recycles an employee number', async ({
  testApp,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const first = await hire(admin);
  const left = await admin.fetch(`/employees/${first.userId}/leave`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: 'http://localhost',
      'Idempotency-Key': randomUUID(),
    },
    body: JSON.stringify({ leftOn: '2026-03-01' }),
  });
  expect(left.status).toBe(201);
  const second = await hire(admin);
  const a = Number(String(first.employeeNo).slice(1));
  const b = Number(String(second.employeeNo).slice(1));
  expect(b).toBeGreaterThan(a);
});

test('R-011 验收8: a failure while creating the account leaves no account or profile behind', async ({
  testApp,
  app,
  connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const before = {
    users: await connection.repository<Row>('user').count(),
    profiles: await connection.repository<Row>('employees').count(),
    changes: await connection.repository<Row>('employeeChanges').count(),
  };
  const auth = app.container.resolve(authenticationToken);
  const removeInitializer = auth.addUserInitializer(async () => {
    throw new Error('account creation failed halfway');
  });
  try {
    const response = await admin.fetch('/employees', json(unique('Hire')));
    expect(response.status).toBe(500);
  } finally {
    removeInitializer();
  }
  expect(await connection.repository<Row>('user').count()).toBe(before.users);
  expect(await connection.repository<Row>('employees').count()).toBe(before.profiles);
  expect(await connection.repository<Row>('employeeChanges').count()).toBe(before.changes);
  // 号没有被吞掉：下一次入职拿到的仍是当前最大值加一。
  const next = await hire(admin);
  const stored = await connection.repository<Row>('employees').findMany();
  const max = Math.max(...stored.map((row) => Number(String(row.employeeNo).slice(1))));
  expect(Number(String(next.employeeNo).slice(1))).toBe(max);
  void app;
});


test('R-011 验收1: account and profile commit or fail together', async ({
  testApp,
  app,
  connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const mutations = app.container.resolve(employeeMutationsToken);
  const name = unique('FailAfter');
  const before = {
    users: await connection.repository<Row>('user').count(),
    profiles: await connection.repository<Row>('employees').count(),
  };
  mutations.setFailpointForTest('after-account');
  try {
    const response = await admin.fetch('/employees', {
      ...json(name),
      body: JSON.stringify({ name, username: name, hiredOn: '2026-01-05', password: PASSWORD }),
    });
    expect(response.status).toBe(500);
  } finally {
    mutations.setFailpointForTest(undefined);
  }
  expect(await connection.repository<Row>('user').count()).toBe(before.users);
  expect(await connection.repository<Row>('employees').count()).toBe(before.profiles);
  expect(await connection.repository<Row>('user').findMany({ filter: { username: name.toLowerCase() } })).toEqual([]);
});

test('R-011 验收3: the employee number sequence stops at E999999', async ({
  testApp,
  app,
  connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const now = new Date();
  await connection.repository<Row>('employees').createOne({
    values: {
      id: randomUUID(),
      userId: unique('limit'),
      employeeNo: 'E999999',
      hiredOn: '2026-01-05',
      status: 'active',
      createdAt: now,
      updatedAt: now,
    },
  });
  const name = unique('Hire');
  const response = await admin.fetch('/employees', {
    ...json(name),
    body: JSON.stringify({ name, username: name, hiredOn: '2026-01-05', password: PASSWORD }),
  });
  const text = await response.text();
  expect(response.status).toBe(409);
  const error = (JSON.parse(text) as { error: { reason: string } }).error;
  expect(error.reason).toBe('EMPLOYEE_NO_EXHAUSTED');
  const stored = await connection.repository<Row>('employees').findMany();
  expect(stored.every((row) => /^E\d{6}$/.test(String(row.employeeNo)))).toBe(true);
  expect(await connection.repository<Row>('user').findMany({ filter: { username: name.toLowerCase() } })).toEqual([]);
  void app;
});
