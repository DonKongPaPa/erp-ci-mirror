// @vitest-environment node
import {
  DEFAULT_ADMIN_CREDENTIALS,
  signIn,
} from '@nocobase/app-plugin-authentication/testing';
import { userAdministrationServiceToken } from '@nocobase/app-plugin-authentication/server';
import { authorizationToken } from '@nocobase/app-plugin-authorization/server';
import type { DatabaseConnection } from '@nocobase/db';
import { randomUUID } from 'node:crypto';
import { expect, vi } from 'vitest';

import { createAppTest } from '../helpers/test-app.js';
import { createStandaloneServer } from '../../server/standalone.js';
import {
  assignStaffBaseline,
  STAFF_PERMISSION_SET,
} from '../../server/providers/staff-baseline.js';

/**
 * R-026：`staff` 是提交反馈的基线角色，建人时自动指派。
 *
 * 覆盖新建「人」的三条路（管理员建人、自助注册、邀请接受由 member-role 的既有用例
 * 间接走过）、服务账号不指派、已有指派不重复、失败不阻塞建人（另一份文件）。
 * 「管理员建人」按设置界面实际发的东西测：界面把角色选择器的默认值 `member` 一并提交，
 * 所以 `roleScopes: { app: ['member'] }` 必须在建完之后仍有 `staff`。
 */

const PASSWORD = 'Staff-baseline-test-123!';

const test = createAppTest({
  createServer: createStandaloneServer,
  config: {
    app: { publicOrigin: 'http://localhost' },
    auth: { secret: 'test-auth-secret-at-least-32-characters' },
  },
});

const createOperationKey = () => `${Date.now()}.${randomUUID()}`;

const json = (body: unknown, method = 'POST') => ({
  method,
  headers: {
    'content-type': 'application/json',
    origin: 'http://localhost',
    'Idempotency-Key': createOperationKey(),
  },
  body: JSON.stringify(body),
});

/** 这个用户直接持有的权限集（不含 authenticated 的公共授予），按 key 排序。 */
const permissionSetsOf = async (
  connection: DatabaseConnection,
  userId: string,
): Promise<string[]> =>
  (
    await connection.query
      .selectFrom('authorizationPermissionSetAssignments')
      .select('permissionSetKey')
      .where('subjectType', '=', 'user')
      .where('subjectId', '=', userId)
      .orderBy('permissionSetKey')
      .execute()
  ).map((row) => String(row.permissionSetKey));

const createUser = async (
  admin: Awaited<ReturnType<typeof signIn>>,
  name: string,
  roleScopes?: Record<string, string[]>,
): Promise<{ id: string }> => {
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
  return (await response.json()).data as { id: string };
};

test('R-026: an admin-created person gets staff, whichever roles the form submits', async ({
  testApp,
  connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);

  // 不传 roleScopes：框架给 member，基线给 staff。
  const omitted = await createUser(admin, 'r026staffomitted');
  expect(await permissionSetsOf(connection, omitted.id)).toEqual([
    'member',
    STAFF_PERMISSION_SET,
  ]);

  // 设置界面的默认提交：角色选择器把 member 一起发上来。建人服务会在建完之后
  // 用这份清单整体替换直接角色，事务里的指派会被它抹掉 —— 基线要在替换之后重新成立。
  const defaultForm = await createUser(admin, 'r026staffform', {
    app: ['member'],
  });
  expect(await permissionSetsOf(connection, defaultForm.id)).toEqual([
    'member',
    STAFF_PERMISSION_SET,
  ]);

  // 显式清空角色也不会清掉基线：R-026 定的是「凡是新建的人都有 staff」，没有退出项。
  const explicitEmpty = await createUser(admin, 'r026staffempty', { app: [] });
  expect(await permissionSetsOf(connection, explicitEmpty.id)).toEqual([
    STAFF_PERMISSION_SET,
  ]);

  // 服务账号不是「人」：一个权限集都不给。
  const service = await testApp.application.container
    .resolve(userAdministrationServiceToken)
    .createServiceAccount({ name: 'R-026 staff baseline service' });
  expect(await permissionSetsOf(connection, service.id)).toEqual([]);
});

test('R-026: self-registration gets the staff baseline', async ({
  testApp,
  connection,
}) => {
  // 应用默认配置里注册是开着的（`server/config/auth.ts` 的 emailAndPassword.enabled）；
  // 这里没有为测试单独打开它。
  const response = await testApp.request(
    '/auth/sign-up/email',
    json({
      name: 'R026 Signup',
      email: 'r026staffsignup@example.test',
      password: PASSWORD,
    }),
  );
  expect(response.status).toBe(200);
  const registered = (await response.json()).user as { id: string };
  expect(await permissionSetsOf(connection, registered.id)).toEqual([
    'member',
    STAFF_PERMISSION_SET,
  ]);
});

test('R-026: an existing staff assignment is not duplicated', async ({
  testApp,
  app,
  connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const created = await createUser(admin, 'r026staffidempotent', {
    app: ['member'],
  });
  const authz = app.container.resolve(authorizationToken);
  await authz.permissionSets.revoke(`user:${created.id}:${STAFF_PERMISSION_SET}`);
  expect(await permissionSetsOf(connection, created.id)).toEqual(['member']);

  const logger = { error: vi.fn() };
  expect(await assignStaffBaseline(authz, created.id, logger)).toBe(true);
  // 第二次看到已有的那一行就返回，不写库、也不把它当成失败记一条 error。
  expect(await assignStaffBaseline(authz, created.id, logger)).toBe(false);
  expect(logger.error).not.toHaveBeenCalled();
  expect(await permissionSetsOf(connection, created.id)).toEqual([
    'member',
    STAFF_PERMISSION_SET,
  ]);
});
