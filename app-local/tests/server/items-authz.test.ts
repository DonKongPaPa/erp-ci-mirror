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

/**
 * R-019 MVP 验收 6：非 root 对物料这一片全部 403，且先授权后读内容。
 *
 * 非 root 用真实权限集，不靠 root 绕过；撞码请求也要先被 403 拦下，
 * 才算「先授权后读内容」而不是「没授权也能试内容」。root 的正面证据另列。
 */
const test = createAppTest({
  createServer: createStandaloneServer,
  config: {
    app: { publicOrigin: 'http://localhost' },
    auth: { secret: 'test-auth-secret-at-least-32-characters' },
  },
});

const PASSWORD = 'R019-authz-123!';
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

const makeUser = async (
  admin: TestSession,
  testApp: Parameters<typeof signIn>[0],
  roles: readonly string[],
  revokeStaff = false,
): Promise<TestSession> => {
  const username = unique('r019user');
  const created = await admin.fetch('/users', write({
    name: username,
    username,
    email: `${username.toLowerCase()}@example.test`,
    password: PASSWORD,
    roleScopes: { app: [...roles] },
  }));
  expect(created.status).toBe(201);
  const userId = String((await (await created.json()) as { data: { id: string } }).data.id);
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

test('R-019 验收6: staff 与无角色用户读、写这一片全部 403', async ({
  testApp,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const staff = await makeUser(admin, testApp, ['staff']);
  const outsider = await makeUser(admin, testApp, [], true);

  // 前置：root 先建一条真数据，非 root 的请求才有内容可以试。
  const unitCode = unique('U');
  const createdUnit = await admin.fetch('/units', write({ code: unitCode, name: '单位' }));
  expect(createdUnit.status).toBe(201);
  const createdItem = await admin.fetch('/items', write({
    name: '物料',
    itemType: 'material',
    unitCode,
  }));
  expect(createdItem.status).toBe(201);
  const item = await (await createdItem.json()) as { id: string; code: string };

  const categoryCreated = await admin.fetch('/item-categories', write({
    id: randomUUID(),
    code: unique('C'),
    name: '分类',
  }));
  expect(categoryCreated.status).toBe(201);
  const category = await (await categoryCreated.json()) as { id: string };

  for (const session of [staff, outsider]) {
    for (const response of [
      await session.fetch('/items', get()),
      await session.fetch(`/items/${item.id}`, get()),
      await session.fetch('/items', write({
        name: '冒名',
        itemType: 'material',
        unitCode,
      })),
      await session.fetch(`/items/${item.id}`, write({ name: '冒名' }, 'PATCH')),
      await session.fetch('/units', get()),
      await session.fetch(`/units/${unitCode}`, get()),
      await session.fetch('/units', write({ code: unique('U'), name: '冒名' })),
      await session.fetch(`/units/${unitCode}`, write({ name: '冒名' }, 'PATCH')),
      await session.fetch('/item-categories', get()),
      await session.fetch(`/item-categories/${category.id}`, get()),
      await session.fetch('/item-categories', write({
        id: randomUUID(),
        code: unique('C'),
        name: '冒名',
      })),
      await session.fetch(`/item-categories/${category.id}`, write({ name: '冒名' }, 'PATCH')),
    ]) {
      expect(response.status).toBe(403);
    }
  }
});

test('R-019 验收6: 无授权者发撞码请求先得 403，不是 409', async ({
  testApp,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const staff = await makeUser(admin, testApp, ['staff']);
  const unitCode = unique('U');
  expect((await admin.fetch('/units', write({ code: unitCode, name: '单位' }))).status).toBe(201);
  const created = await admin.fetch('/items', write({
    name: '物料',
    itemType: 'material',
    unitCode,
  }));
  expect(created.status).toBe(201);
  const item = await (await created.json()) as { id: string; code: string };

  const duplicate = await staff.fetch('/items', write({
    name: '冒名',
    itemType: 'material',
    unitCode,
    code: item.code,
  }));
  expect(duplicate.status).toBe(403);
  const body = await (await duplicate.json()) as {
    error?: { reason?: string };
  };
  expect(body.error?.reason).not.toBe('ITEM_CODE_TAKEN');
});

test('R-019 验收6: 资源声明只登记读/建/改，不登记删除；业务角色没有授权', async ({
  app,
  testApp,
}) => {
  const authz = app.container.resolve(authorizationToken);
  const collections = authz.database.collections.list() as readonly {
    name: string;
    actions: readonly string[];
  }[];
  for (const name of ['items', 'units', 'itemCategories']) {
    expect(authz.database.collections.has(name)).toBe(true);
    const definition = collections.find((entry) => entry.name === name);
    expect(definition?.actions).toEqual(['read', 'create', 'update']);
    expect(
      authz.compositeResources.getAction('items', 'delete'),
    ).toBeUndefined();
  }
  for (const action of ['view', 'manage'] as const) {
    expect(authz.compositeResources.getAction('items', action)).toBeDefined();
  }
  expect(authz.ui.placementOf({ type: 'composite', id: 'items' })).toEqual({
    section: 'materials',
  });

  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const staffId = (await makeUser(admin, testApp, ['staff'])).user.id;
  const can = (userId: string, action: string) =>
    authz
      .for({ principal: { type: 'user', id: userId } })
      .can({ resource: { type: 'composite', id: 'items' }, action });
  expect(await can(String(staffId), 'view')).toBe(false);
  expect(await can(String(staffId), 'manage')).toBe(false);
  expect(await can(String(admin.user.id), 'view')).toBe(true);
  expect(await can(String(admin.user.id), 'manage')).toBe(true);

  for (const key of ['staff', 'member', 'dept_manager', 'quality_manager', 'quality_inspector'] as const) {
    const set = await authz.permissionSets.get(key);
    expect(set, `${key} 权限集不存在`).toBeDefined();
    const grants = JSON.parse(JSON.stringify(set!.grants)) as {
      resource: { type: string; id: string };
    }[];
    expect(
      grants.filter(
        (grant) => grant.resource.type === 'composite' && grant.resource.id === 'items',
      ),
      `${key} 不该持有 items 的任何动作`,
    ).toEqual([]);
  }
});
