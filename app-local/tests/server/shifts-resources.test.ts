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
 * R-025 S1 验收 4–7：资源声明、默认授权、页面授权与不预置班次。
 *
 * 授权没有字段这一层，所以逐列断言注册产物；动作清单写全才不会登记删除。
 * 业务角色的默认授权查 seed 写进权限集表的产物（不只查内存常量），
 * 有效权限再拿非 root 会话的 `can()` 验一次：root 绕过一切检查，不能拿它当正面证据。
 */
const test = createAppTest({
  createServer: createStandaloneServer,
  config: {
    app: { publicOrigin: 'http://localhost' },
    auth: { secret: 'test-auth-secret-at-least-32-characters' },
  },
});

const PASSWORD = 'R025-resources-123!';
const json = (body: unknown) => ({
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    origin: 'http://localhost',
    'Idempotency-Key': `${Date.now()}.${randomUUID()}`,
  },
  body: JSON.stringify(body),
});
const unique = (prefix: string) =>
  `${prefix}${randomUUID().replaceAll('-', '').slice(0, 10)}`;

const READ_FIELDS = [
  'active',
  'breakEndMinute',
  'breakStartMinute',
  'createdAt',
  'endMinute',
  'id',
  'sortOrder',
  'startMinute',
  'title',
  'updatedAt',
];
const CREATE_FIELDS = [
  'breakEndMinute',
  'breakStartMinute',
  'endMinute',
  'id',
  'sortOrder',
  'startMinute',
  'title',
];
const UPDATE_FIELDS = ['active', 'sortOrder', 'title'];
const BUSINESS_ROLES = [
  'dept_manager',
  'quality_manager',
  'quality_inspector',
  'member',
] as const;

type RegisteredGrant = {
  resource: { type: string; id: string };
  actions: {
    action: string;
    policy: { type: string; fields: '*' | readonly string[] };
  }[];
};
type RegisteredAction = { grants: RegisteredGrant[] };

/** 从注册模型取「表 → 操作 → 列」；声明放宽成 '*' 时原样返回。 */
const registeredFields = (app: {
  container: { resolve(token: typeof authorizationToken): unknown };
}): Readonly<Record<string, '*' | readonly string[]>> => {
  const authz = app.container.resolve(authorizationToken) as {
    compositeResources: {
      getAction(resource: string, name: string): unknown;
    };
  };
  const fields: Record<string, '*' | readonly string[]> = {};
  for (const action of ['view', 'manage'] as const) {
    const definition = authz.compositeResources.getAction(
      'shifts',
      action,
    ) as RegisteredAction | undefined;
    expect(definition, `shifts.${action} 没有注册`).toBeDefined();
    for (const grant of definition!.grants) {
      for (const registered of grant.actions) {
        fields[`${action}:${registered.action}`] = registered.policy.fields;
      }
    }
  }
  return fields;
};

const createUser = async (
  admin: TestSession,
  name: string,
  roleScopes?: Record<string, string[]>,
): Promise<string> => {
  const response = await admin.fetch(
    '/users',
    json({
      name,
      username: name,
      email: `${name}@example.test`,
      password: PASSWORD,
      ...(roleScopes === undefined ? {} : { roleScopes }),
    }),
  );
  expect(response.status).toBe(201);
  return String((await response.json()).data.id);
};

interface StoredGrant {
  resource: { type: string; id: string };
  actions: { action: string; policy?: unknown }[];
}

const grantsOf = (set: { grants: unknown }): StoredGrant[] =>
  JSON.parse(JSON.stringify(set.grants)) as StoredGrant[];

test('R-025 验收4: shifts 资源只登记 view/manage，一张表、没有删除', async ({
  app,
}) => {
  const authz = app.container.resolve(authorizationToken);
  expect(authz.database.collections.has('shifts')).toBe(true);
  const definition = authz.database.collections
    .list()
    .find((collection) => collection.name === 'shifts');
  // 动作清单写全，没有 delete：否则管理员能经接口给角色写一条「可以删班次」。
  expect(definition?.actions).toEqual(['read', 'create', 'update']);
  for (const action of ['view', 'manage'] as const) {
    expect(authz.compositeResources.getAction('shifts', action)).toBeDefined();
  }
  expect(
    authz.compositeResources.getAction('shifts', 'delete'),
  ).toBeUndefined();
  expect(authz.compositeResources.getAction('shifts', 'view')?.title).toEqual({
    key: 'authorization.shifts.actions.view',
    ns: 'app-local',
  });
  expect(authz.ui.placementOf({ type: 'composite', id: 'shifts' })).toEqual({
    section: 'organization',
  });
  expect(
    authz.ui.placementOf({ type: 'database.collection', id: 'shifts' }),
  ).toBeUndefined();

  const fields = registeredFields(app);
  expect(Object.keys(fields).sort()).toEqual([
    'manage:create',
    'manage:read',
    'manage:update',
    'view:read',
  ]);
  for (const [key, expected] of Object.entries({
    'view:read': READ_FIELDS,
    'manage:read': READ_FIELDS,
    'manage:create': CREATE_FIELDS,
    'manage:update': UPDATE_FIELDS,
  })) {
    expect(fields[key], `${key} 被放宽或列不对`).not.toBe('*');
    expect([...(fields[key] as readonly string[])].sort()).toEqual([
      ...expected,
    ].sort());
  }
  // PATCH 写不到编码与起止：写权限里没有它们。
  expect(UPDATE_FIELDS).not.toContain('id');
  expect(UPDATE_FIELDS).not.toContain('startMinute');
});

test('R-025 验收5/6/7: seed 给 staff 读、root 读写，其余角色没有授权，不预置班次', async ({
  app,
  testApp,
  connection,
}) => {
  const authz = app.container.resolve(authorizationToken);
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const staffId = await createUser(admin, unique('r025staff'), {
    app: ['staff'],
  });
  const can = (userId: string, action: string) =>
    authz
      .for({ principal: { type: 'user', id: userId } })
      .can({ resource: { type: 'composite', id: 'shifts' }, action });

  expect(await can(staffId, 'view')).toBe(true);
  expect(await can(staffId, 'manage')).toBe(false);
  expect(await can(String(admin.user.id), 'view')).toBe(true);
  expect(await can(String(admin.user.id), 'manage')).toBe(true);

  for (const key of BUSINESS_ROLES) {
    const set = await authz.permissionSets.get(key);
    expect(set, `${key} 权限集不存在`).toBeDefined();
    expect(
      grantsOf(set!).filter(
        (grant) =>
          grant.resource.type === 'composite' && grant.resource.id === 'shifts',
      ),
      `${key} 不该持有 shifts 的任何动作`,
    ).toEqual([]);
    // 页面授权默认只有 root：管理页不写进任何业务角色的权限集。
    expect(
      grantsOf(set!).filter(
        (grant) => grant.resource.type === 'page' && grant.resource.id === 'shifts',
      ),
      `${key} 不该持有班次页授权`,
    ).toEqual([]);
  }
  expect(
    await connection.repository<Record<string, unknown>>('shifts').count(),
  ).toBe(0);
});
