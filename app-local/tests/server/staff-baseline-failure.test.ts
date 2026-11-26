// @vitest-environment node
import {
  DEFAULT_ADMIN_CREDENTIALS,
  signIn,
} from '@nocobase/app-plugin-authentication/testing';
import { authorizationToken } from '@nocobase/app-plugin-authorization/server';
import { loggingToken } from '@nocobase/app-server/logging';
import type { DatabaseConnection } from '@nocobase/db';
import { randomUUID } from 'node:crypto';
import { expect, vi } from 'vitest';

import { createAppTest } from '../helpers/test-app.js';
import { createStandaloneServer } from '../../server/standalone.js';

/**
 * R-026：基线指派失败不阻塞建人。
 *
 * 用「staff 权限集不存在」造出真实的失败（`permissionSets.assign` 自己会抛
 * `PermissionSetNotFoundError`），而不是替换一个假的 assign。断言三件事：账号仍然
 * 建成、没有留下半条指派、日志里有一条带用户标识的 error，且不带口令。
 */

const PASSWORD = 'Staff-failure-test-123!';

const test = createAppTest({
  createServer: createStandaloneServer,
  config: {
    app: { publicOrigin: 'http://localhost' },
    auth: { secret: 'test-auth-secret-at-least-32-characters' },
  },
});

const json = (body: unknown) => ({
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    origin: 'http://localhost',
    'Idempotency-Key': `${Date.now()}.${randomUUID()}`,
  },
  body: JSON.stringify(body),
});

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

test('R-026: the account is created even when the staff assignment fails, and one error is logged', async ({
  testApp,
  app,
  connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const authz = app.container.resolve(authorizationToken);
  // 让指派真的失败：目标权限集不在库里。assign 会抛 PermissionSetNotFoundError。
  await authz.permissionSets.delete('staff');

  const logError = vi.spyOn(
    app.container.resolve(loggingToken).getLogger('app'),
    'error',
  );
  const response = await admin.fetch(
    '/users',
    json({
      name: 'r026stafffailed',
      username: 'r026stafffailed',
      email: 'r026stafffailed@example.test',
      password: PASSWORD,
      roleScopes: { app: ['member'] },
    }),
  );

  // 账号建成了：201，框架的 member 仍在，基线没有留下半条脏指派。
  expect(response.status).toBe(201);
  const created = (await response.json()).data as { id: string };
  expect(await permissionSetsOf(connection, created.id)).toEqual(['member']);

  // 恰好一条 error，带用户标识；不记口令。
  const calls = logError.mock.calls.filter(
    ([bindings]) =>
      (bindings as { userId?: unknown } | undefined)?.userId === created.id,
  );
  expect(calls).toHaveLength(1);
  const [bindings, message] = calls[0]!;
  expect(String(message)).toContain('staff');
  expect(JSON.stringify(bindings)).not.toContain(PASSWORD);
  expect(JSON.stringify(bindings)).not.toContain('password');
});
