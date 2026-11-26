import { randomUUID } from 'node:crypto';

import type { Application } from '@nocobase/app-server/application';
import {
  DEFAULT_ADMIN_CREDENTIALS,
  signIn,
  type TestSession,
} from '@nocobase/app-plugin-authentication/testing';
import { authorizationToken } from '@nocobase/app-plugin-authorization/server';
import { expect } from 'vitest';

import { createAppTest } from '../helpers/test-app.js';
import { createStandaloneServer } from '../../server/standalone.js';

/**
 * R-011 全端点授权矩阵（15 个端点，一行一个）。
 *
 * 每个端点两条断言：无角色会话 403，持全部所需授权的非 root 会话按契约放行。
 * 用非 root 的授权用户而不是 root：root 绕过逐端点检查，删掉某一行的授权也照样绿。
 * 只在真 Postgres 上跑；每个端点的变异结果见交付。
 */
const pgOnly = process.env.NOCOBASE_TEST_DB_DIALECT === 'postgres';
const test = createAppTest({
  createServer: createStandaloneServer,
  config: {
    app: { publicOrigin: 'http://localhost' },
    auth: { secret: 'test-auth-secret-at-least-32-characters' },
  },
});

const PASSWORD = 'R011-authz-123!';
const json = (body: unknown, method = 'POST'): RequestInit => ({
  method,
  headers: {
    'content-type': 'application/json',
    origin: 'http://localhost',
    'Idempotency-Key': `${Date.now()}.${randomUUID()}`,
  },
  body: JSON.stringify(body),
});
const get = (): RequestInit => ({ method: 'GET' });
const unique = (prefix: string): string =>
  `${prefix}${randomUUID().replaceAll('-', '').slice(0, 10)}`;

interface Row { [key: string]: unknown }

const dataOf = async (response: Response, status: number): Promise<Row> => {
  expect(response.status).toBe(status);
  return ((await response.json()) as { data: Row }).data;
};

interface Fixtures {
  readonly admin: TestSession;
  readonly outsider: TestSession;
  readonly allowed: TestSession;
  readonly activeId: string;
  readonly positionId: string;
  readonly gradeId: string;
}

let cached: { readonly app: Application; readonly value: Fixtures } | undefined;

const makeUser = async (
  admin: TestSession,
  testApp: Parameters<typeof signIn>[0],
): Promise<{ id: string; session: TestSession }> => {
  const username = unique('r011auth');
  const created = await dataOf(await admin.fetch('/users', json({
    name: username,
    username,
    email: `${username}@example.test`,
    password: PASSWORD,
    roleScopes: { app: [] },
  })), 201);
  return {
    id: String(created.id),
    session: await signIn(testApp, { username, password: PASSWORD }),
  };
};

const fixtures = async (
  testApp: Parameters<typeof signIn>[0],
  app: Application,
): Promise<Fixtures> => {
  if (cached?.app === app) {
    return cached.value;
  }
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const outsider = await makeUser(admin, testApp);
  const allowedUser = await makeUser(admin, testApp);
  const sets = app.container.resolve(authorizationToken).permissionSets;
  // 无关角色持所有「额外」授权（用户动作与管理部门），唯独不持 employees 的两个动作。
  // 这样删掉任一端点的 employees 授权时，它不会因为别的授权缺失而继续 403。
  const extraKey = unique('r011extra');
  await sets.create({
    key: extraKey,
    grants: [
      {
        resource: { type: 'composite', id: 'departments' },
        actions: [{
          action: 'manage',
          policy: {
            type: 'composite',
            scopes: {
              departments: 'allRecords',
              departmentMembers: 'allRecords',
              departmentMemberHistory: 'allRecords',
            },
          },
        }],
      },
      {
        resource: { type: 'user', id: '*' },
        actions: ['create', 'assign-role', 'disable', 'enable'].map((action) => ({ action })),
      },
    ],
  });
  await sets.assign({ subject: { type: 'user', id: outsider.id }, permissionSet: extraKey });

  const key = unique('r011all');
  await sets.create({
    key,
    grants: [
      {
        resource: { type: 'composite', id: 'employees' },
        actions: ['view', 'manage'].map((action) => ({
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
      },
      {
        resource: { type: 'composite', id: 'departments' },
        actions: [{
          action: 'manage',
          policy: {
            type: 'composite',
            scopes: {
              departments: 'allRecords',
              departmentMembers: 'allRecords',
              departmentMemberHistory: 'allRecords',
            },
          },
        }],
      },
      {
        resource: { type: 'user', id: '*' },
        actions: ['create', 'assign-role', 'disable', 'enable'].map((action) => ({ action })),
      },
    ],
  });
  await sets.assign({ subject: { type: 'user', id: allowedUser.id }, permissionSet: key });

  const active = unique('Hire');
  const profile = await dataOf(await admin.fetch('/employees', json({
    name: active, username: active, hiredOn: '2026-01-05', password: PASSWORD,
  })), 201);
  const position = await dataOf(await admin.fetch('/positions', json({
    id: unique('P'), title: 'Engineer',
  })), 201);
  const grade = await dataOf(await admin.fetch('/job-grades', json({
    id: unique('G'), title: 'P5', rank: 5,
  })), 201);
  const value: Fixtures = {
    admin,
    outsider: outsider.session,
    allowed: allowedUser.session,
    activeId: String(profile.userId),
    positionId: String(position.id),
    gradeId: String(grade.id),
  };
  cached = { app, value };
  return value;
};

const hireOnce = async (admin: TestSession): Promise<string> => {
  const name = unique('Hire');
  const profile = await dataOf(await admin.fetch('/employees', json({
    name, username: name, hiredOn: '2026-01-05', password: PASSWORD,
  })), 201);
  return String(profile.userId);
};

/** 一条用例：名字里的序号对应交付里逐端点变异的编号。 */
interface Case {
  readonly name: string;
  readonly status: number;
  readonly request: (f: Fixtures) => Promise<{ path: string; init: RequestInit }>;
}

const plain = (path: string, init: RequestInit) => async () => ({ path, init });

const CASES: readonly Case[] = [
  { name: 'auth-01 GET /employees', status: 200,
    request: plain('/employees', get()) },
  { name: 'auth-02 GET /employees/:userId', status: 200,
    request: async (f) => ({ path: `/employees/${f.activeId}`, init: get() }) },
  { name: 'auth-03 GET /employees/:userId/changes', status: 200,
    request: async (f) => ({ path: `/employees/${f.activeId}/changes`, init: get() }) },
  { name: 'auth-04 GET /employees/candidates', status: 200,
    request: plain('/employees/candidates?q=Hire', get()) },
  { name: 'auth-05 POST /employees', status: 201,
    request: async () => {
      const name = unique('Hire');
      return { path: '/employees', init: json({ name, username: name, hiredOn: '2026-01-05' }) };
    } },
  { name: 'auth-06 POST /employees/link', status: 201,
    request: async (f) => {
      const name = unique('Link');
      const user = await dataOf(await f.admin.fetch('/users', json({
        name, username: name, email: `${name}@example.test`, password: PASSWORD,
        roleScopes: { app: [] },
      })), 201);
      return { path: '/employees/link', init: json({ userId: user.id, hiredOn: '2026-01-05' }) };
    } },
  { name: 'auth-07 PATCH /employees/:userId', status: 200,
    request: async (f) => ({ path: `/employees/${f.activeId}`, init: json({ positionId: null }, 'PATCH') }) },
  { name: 'auth-08 POST /employees/:userId/leave', status: 201,
    request: async (f) => {
      const userId = await hireOnce(f.admin);
      return { path: `/employees/${userId}/leave`, init: json({ leftOn: '2026-03-01' }) };
    } },
  { name: 'auth-09 POST /employees/:userId/rehire', status: 201,
    request: async (f) => {
      const userId = await hireOnce(f.admin);
      expect((await f.admin.fetch(`/employees/${userId}/leave`, json({ leftOn: '2026-03-01' }))).status).toBe(201);
      return { path: `/employees/${userId}/rehire`, init: json({ hiredOn: '2026-04-01' }) };
    } },
  { name: 'auth-10 GET /positions', status: 200,
    request: plain('/positions', get()) },
  { name: 'auth-11 POST /positions', status: 201,
    request: async () => ({ path: '/positions', init: json({ id: unique('P'), title: 'Tech' }) }) },
  { name: 'auth-12 PATCH /positions/:id', status: 200,
    request: async (f) => ({ path: `/positions/${f.positionId}`, init: json({ title: 'Engineer 2' }, 'PATCH') }) },
  { name: 'auth-13 GET /job-grades', status: 200,
    request: plain('/job-grades', get()) },
  { name: 'auth-14 POST /job-grades', status: 201,
    request: async () => ({ path: '/job-grades', init: json({ id: unique('G'), title: 'P6', rank: 6 }) }) },
  { name: 'auth-15 PATCH /job-grades/:id', status: 200,
    request: async (f) => ({ path: `/job-grades/${f.gradeId}`, init: json({ title: 'P5+' }, 'PATCH') }) },
];

for (const item of CASES) {
  test(item.name, { skip: !pgOnly }, async ({ testApp, app }) => {
    const f = await fixtures(testApp, app);
    const request = await item.request(f);
    const denied = await f.outsider.fetch(request.path, request.init);
    expect(denied.status, `${item.name}: 无角色应当 403`).toBe(403);
    const allowed = await f.allowed.fetch(request.path, request.init);
    expect(allowed.status, `${item.name}: 有授权应当 ${item.status}`).toBe(item.status);
  });
}
