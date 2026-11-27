// @vitest-environment node
import { randomUUID } from 'node:crypto';

import {
  DEFAULT_ADMIN_CREDENTIALS,
  signIn,
  type TestSession,
} from '@nocobase/app-plugin-authentication/testing';
import { authorizationToken } from '@nocobase/app-plugin-authorization';
import { expect } from 'vitest';

import { createAppTest } from '../helpers/test-app.js';
import { createStandaloneServer } from '../../server/standalone.js';
import { shiftServiceToken } from '../../server/providers/shifts.js';

/**
 * R-025 S2 验收 8–18、20：六个端点的授权、形状、规则与暴露面。
 *
 * 每条断言都从真库读回写入结果；非 root 会话用真实权限集，不靠 root 绕过。
 * 所有请求都带 Origin 与操作键（写端点的框架前置条件）。
 */
const test = createAppTest({
  createServer: createStandaloneServer,
  config: {
    app: { publicOrigin: 'http://localhost' },
    auth: { secret: 'test-auth-secret-at-least-32-characters' },
  },
});

const PASSWORD = 'R025-api-123!';
const ORIGIN = 'http://localhost';
const unique = (prefix: string) =>
  `${prefix}${randomUUID().replaceAll('-', '').slice(0, 10).toUpperCase()}`;
const write = (body: unknown, method = 'POST'): RequestInit => ({
  method,
  headers: {
    'content-type': 'application/json',
    origin: ORIGIN,
    'Idempotency-Key': `${Date.now()}.${randomUUID()}`,
  },
  body: JSON.stringify(body),
});
const get = (): RequestInit => ({ method: 'GET' });

interface Row {
  [key: string]: unknown;
}

/** 班次端点按契约直接回一条班次或 `{ items, total, page, pageSize }`，不是 `{ data }`。 */
type JsonBody = Row & {
  data?: Row;
  items?: Row[];
  error?: { reason: string; code?: number };
};
const jsonOf = async (response: Response): Promise<JsonBody> =>
  (await response.json()) as JsonBody;

const create = async (session: TestSession, id: string, extra: Row = {}): Promise<Row> => {
  const response = await session.fetch('/shifts', write({
    id,
    title: '早班',
    startMinute: 480,
    endMinute: 1020,
    ...extra,
  }));
  if (response.status !== 201) {
    throw new Error(`建 ${id} 失败：${response.status} ${await response.text()}`);
  }
  return await jsonOf(response);
};

const makeUser = async (
  admin: TestSession,
  testApp: Parameters<typeof signIn>[0],
  name: string,
  roles: readonly string[],
  revokeStaff = false,
): Promise<TestSession> => {
  const username = unique(name);
  const created = await admin.fetch('/users', write({
    name: username,
    username,
    email: `${username.toLowerCase()}@example.test`,
    password: PASSWORD,
    roleScopes: { app: [...roles] },
  }));
  expect(created.status).toBe(201);
  const userId = String((await jsonOf(created)).data!.id);
  if (revokeStaff) {
    const authz = testApp.application.container.resolve(authorizationToken);
    for (const assignment of await authz.permissionSets.listAssignments('staff')) {
      if (assignment.subject.type === 'user' && assignment.subject.id === userId) {
        await authz.permissionSets.revoke(assignment.id);
      }
    }
  }
  return await signIn(testApp, { username, password: PASSWORD });
};

/** 递归收集响应 JSON 的全部键，抓的是字段名不是值。 */
const keysOf = (value: unknown): string[] => {
  if (Array.isArray(value)) {
    return value.flatMap(keysOf);
  }
  if (value !== null && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => [
      key,
      ...keysOf(child),
    ]);
  }
  return [];
};

const FORBIDDEN_KEYS = [
  'email',
  'phone',
  'mobile',
  'username',
  'userId',
  'employeeNo',
  'actorId',
  'departmentId',
];

test('R-025 验收8: staff 可读不可写；验收20: 无授权的人编码重复也先被 403 拦下', async ({
  testApp,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const staff = await makeUser(admin, testApp, 'r025staff', ['staff']);
  const outsider = await makeUser(admin, testApp, 'r025out', [], true);

  expect((await staff.fetch('/shifts', get())).status).toBe(200);
  const existing = await create(admin, unique('S'));
  const dup = {
    id: existing.id,
    title: '冒名',
    startMinute: 600,
    endMinute: 900,
  };
  const staffCreate = await staff.fetch('/shifts', write(dup));
  expect(staffCreate.status).toBe(403);
  for (const response of [
    await staff.fetch(`/shifts/${existing.id}`, write({ title: '改名' }, 'PATCH')),
    await staff.fetch(`/shifts/${existing.id}/deactivate`, write({})),
    await staff.fetch(`/shifts/${existing.id}/activate`, write({})),
    await outsider.fetch('/shifts', write(dup)),
    await outsider.fetch('/shifts', get()),
  ]) {
    expect(response.status).toBe(403);
  }
  // staff 的重复编码被 403 挡住，不是 409：没到内容校验那一步。
  expect((await jsonOf(staffCreate)).error?.reason).not.toBe('SHIFT_CODE_EXISTS');
  expect((await jsonOf(await outsider.fetch('/shifts', write(dup)))).error?.reason).not.toBe(
    'SHIFT_CODE_EXISTS',
  );
});

test('R-025 验收9/11: root 建改停用启用成功；编码停用后仍不复用', async ({
  testApp,
  connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const id = unique('S');
  const created = await create(admin, id, { sortOrder: 3 });
  expect(created).toMatchObject({ id, title: '早班', startMinute: 480, endMinute: 1020, active: true, sortOrder: 3 });

  const renamed = await admin.fetch(
    `/shifts/${id}`,
    write({ title: '新名称', sortOrder: 7 }, 'PATCH'),
  );
  expect(renamed.status).toBe(200);
  expect(await jsonOf(renamed)).toMatchObject({ title: '新名称', sortOrder: 7 });

  const deactivated = await admin.fetch(`/shifts/${id}/deactivate`, write({}));
  expect(deactivated.status).toBe(200);
  expect(await jsonOf(deactivated)).toMatchObject({ active: false });
  const activated = await admin.fetch(`/shifts/${id}/activate`, write({}));
  expect(activated.status).toBe(200);
  expect(await jsonOf(activated)).toMatchObject({ active: true });

  const duplicate = await admin.fetch('/shifts', write({ id, title: '再来', startMinute: 540, endMinute: 900 }));
  expect(duplicate.status).toBe(409);
  expect((await jsonOf(duplicate)).error?.reason).toBe('SHIFT_CODE_EXISTS');
  await admin.fetch(`/shifts/${id}/deactivate`, write({}));
  const afterDeactivate = await admin.fetch('/shifts', write({ id, title: '再来', startMinute: 540, endMinute: 900 }));
  expect(afterDeactivate.status).toBe(409);
  expect((await jsonOf(afterDeactivate)).error?.reason).toBe('SHIFT_CODE_EXISTS');
  expect(await connection.repository<Row>('shifts').count({ filter: { id } })).toBe(1);
});

test('R-025 验收12: 停用后不在默认列表与内部服务里，详情与含停用列表仍读得到', async ({
  testApp,
  app,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const active = await create(admin, unique('A'));
  const stopped = await create(admin, unique('B'));
  const deactivated = await admin.fetch(`/shifts/${stopped.id}/deactivate`, write({}));
  // 前置条件真的成立：停用成功，后面的列表断言才有意义。
  if (deactivated.status !== 200) {
    throw new Error(`停用失败：${deactivated.status} ${await deactivated.text()}`);
  }

  const list = await jsonOf(await admin.fetch('/shifts', get()));
  expect(list.items?.map((row) => String(row.id))).not.toContain(stopped.id);
  expect(list.items?.map((row) => String(row.id))).toContain(active.id);
  expect(list.items?.every((row) => row.active === true)).toBe(true);
  expect(list).toMatchObject({ page: 1, pageSize: 20 });
  const inactiveResponse = await admin.fetch('/shifts?includeInactive=true', get());
  if (inactiveResponse.status !== 200) {
    throw new Error(`含停用列表失败：${inactiveResponse.status} ${await inactiveResponse.text()}`);
  }
  const withInactive = await jsonOf(inactiveResponse);
  expect(withInactive.items?.map((row) => String(row.id))).toContain(stopped.id);

  const detail = await admin.fetch(`/shifts/${stopped.id}`, get());
  expect(detail.status).toBe(200);
  expect(await jsonOf(detail)).toMatchObject({ id: stopped.id, active: false });

  const service = app.container.resolve(shiftServiceToken);
  const activeIds = (await service.listActiveShifts()).map((row) => row.id);
  expect(activeIds).toContain(active.id);
  expect(activeIds).not.toContain(stopped.id);
});

test('R-025 验收13: PATCH 带不可改的键一律 422，库里的行一个字节没变', async ({
  testApp,
  connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const id = unique('S');
  await create(admin, id, {
    breakStartMinute: 720,
    breakEndMinute: 750,
  });
  const before = await connection
    .repository<Row>('shifts')
    .findOne({ filter: { id } });
  expect(before).toBeDefined();

  for (const [key, value] of Object.entries({
    id: unique('X'),
    startMinute: 540,
    endMinute: 1080,
    breakStartMinute: 600,
    breakEndMinute: 630,
    active: false,
  })) {
    const response = await admin.fetch(
      `/shifts/${id}`,
      write({ title: '试图改', [key]: value }, 'PATCH'),
    );
    expect(response.status, `${key} 应当被拒`).toBe(422);
    expect((await jsonOf(response)).error?.reason).toBe('SHIFT_FIELD_IMMUTABLE');
  }
  const after = await connection
    .repository<Row>('shifts')
    .findOne({ filter: { id } });
  expect(after).toEqual(before);

  // 改时间 = 建新的一条 + 停用旧的；旧那条的起止与休息段仍是当初的值。
  const freshId = unique('N');
  const fresh = await create(admin, freshId, {
    startMinute: 1320,
    endMinute: 360,
    breakStartMinute: 1380,
    breakEndMinute: 1410,
  });
  expect(fresh).toMatchObject({
    startMinute: 1320,
    endMinute: 360,
    breakStartMinute: 1380,
    breakEndMinute: 1410,
  });
  await admin.fetch(`/shifts/${id}/deactivate`, write({}));
  const old = await jsonOf(await admin.fetch(`/shifts/${id}`, get()));
  expect(old).toMatchObject({
    startMinute: 480,
    endMinute: 1020,
    breakStartMinute: 720,
    breakEndMinute: 750,
    active: false,
  });
});

test('R-025 验收14/15/16: 跨天、当天、起止相同与休息段越界', async ({ testApp }) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const cross = await create(admin, unique('X'), {
    startMinute: 1320,
    endMinute: 360,
  });
  expect(cross).toMatchObject({ startMinute: 1320, endMinute: 360 });
  const day = await create(admin, unique('D'), {
    startMinute: 480,
    endMinute: 1020,
  });
  expect(day).toMatchObject({ startMinute: 480, endMinute: 1020 });

  const rejected = async (body: Row, reason: string): Promise<void> => {
    const response = await admin.fetch('/shifts', write({
      id: unique('R'),
      title: '测试',
      ...body,
    }));
    expect(response.status, `${reason}: ${await response.clone().text()}`).toBe(422);
    expect((await jsonOf(response)).error?.reason).toBe(reason);
  };
  await rejected({ startMinute: 480, endMinute: 480 }, 'SHIFT_EMPTY_RANGE');
  for (const breakRange of [
    { breakStartMinute: 1020, breakEndMinute: 1050 },
    { breakStartMinute: 420, breakEndMinute: 480 },
    { breakStartMinute: 720, breakEndMinute: 660 },
  ]) {
    await rejected(
      { startMinute: 480, endMinute: 1020, ...breakRange },
      'SHIFT_BREAK_OUT_OF_RANGE',
    );
  }
  for (const breakRange of [
    { breakStartMinute: 1380, breakEndMinute: 1410 },
    { breakStartMinute: 120, breakEndMinute: 150 },
  ]) {
    const ok = await create(admin, unique('X'), {
      startMinute: 1320,
      endMinute: 360,
      ...breakRange,
    });
    expect(ok).toMatchObject({ active: true, ...breakRange });
  }
  await rejected(
    { startMinute: 1320, endMinute: 360, breakStartMinute: 360, breakEndMinute: 420 },
    'SHIFT_BREAK_OUT_OF_RANGE',
  );
  const halfBreak = await admin.fetch('/shifts', write({
    id: unique('H'),
    title: '测试',
    startMinute: 480,
    endMinute: 1020,
    breakStartMinute: 720,
  }));
  expect([400, 422]).toContain(halfBreak.status);
});

test('R-025 验收17/18: 没有删除，返回的任何一层都没有人员信息', async ({ testApp }) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const id = unique('S');
  const created = await create(admin, id);
  const responses = [
    await jsonOf(await admin.fetch('/shifts', get())),
    await jsonOf(await admin.fetch(`/shifts/${id}`, get())),
    created,
    await jsonOf(await admin.fetch(`/shifts/${id}`, write({ sortOrder: 2 }, 'PATCH'))),
  ];
  const keys = keysOf(responses);
  expect(keys).toContain('startMinute');
  for (const forbidden of FORBIDDEN_KEYS) {
    expect(keys, `${forbidden} 不该出现在任何响应里`).not.toContain(forbidden);
  }
  const text = JSON.stringify(responses);
  for (const secret of [
    DEFAULT_ADMIN_CREDENTIALS.username,
    DEFAULT_ADMIN_CREDENTIALS.email,
  ]) {
    expect(text.includes(secret), `${secret} 不该出现在响应里`).toBe(false);
  }

  const removed = await admin.fetch(`/shifts/${id}`, {
    method: 'DELETE',
    headers: { origin: ORIGIN },
  });
  expect([404, 405]).toContain(removed.status);
  expect((await admin.fetch(`/shifts/${id}`, get())).status).toBe(200);
});

test('R-025 验收8 的前提: 缺 Origin 的写请求被 403 拒绝', async ({ testApp }) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const response = await admin.fetch('/shifts', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      id: unique('S'),
      title: '早班',
      startMinute: 480,
      endMinute: 1020,
    }),
  });
  expect(response.status).toBe(403);
});
