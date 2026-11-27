// @vitest-environment node
import { randomUUID } from 'node:crypto';

import {
  DEFAULT_ADMIN_CREDENTIALS,
  signIn,
} from '@nocobase/app-plugin-authentication/testing';
import { authorizationToken } from '@nocobase/app-plugin-authorization';
import type { DatabaseConnection } from '@nocobase/db';
import { expect, vi } from 'vitest';

import {
  SHIFTS_RESOURCE,
  shiftsViewGrant,
  upgradeR025,
} from '../../cli/authz/upgrade-r025.js';
import { createAppTest } from '../helpers/test-app.js';
import { createStandaloneServer } from '../../server/standalone.js';

/**
 * R-025 升级命令：已有环境里 seed 不会给 staff 补班次只读授权。
 *
 * 每个用例从 seed 的形状出发，直接用 SQL 把 `shifts.view` 从 staff 的权限集里删掉，
 * 再跑命令。断言有效权限 `can()` 与库里的形状，不只看命令返回的文字。
 */
const test = createAppTest({
  scope: 'test',
  createServer: createStandaloneServer,
  config: {
    app: { publicOrigin: 'http://localhost' },
    auth: { secret: 'test-auth-secret-at-least-32-characters' },
  },
});

const PASSWORD = 'R025-upgrade-123!';
const unique = (prefix: string) =>
  `${prefix}${randomUUID().replaceAll('-', '').slice(0, 10)}`;

interface StoredGrant {
  resource: { type: string; id: string };
  actions: { action: string; policy?: unknown }[];
}

const grantsOf = (set: { grants: unknown }): StoredGrant[] =>
  JSON.parse(JSON.stringify(set.grants)) as StoredGrant[];

const isShiftsGrant = (grant: StoredGrant): boolean =>
  grant.resource.type === 'composite' && grant.resource.id === SHIFTS_RESOURCE;

/** 造「升级之前」：旧环境里 staff 没有这一条授权，revision 故意不动。 */
async function stripShiftsView(
  connection: DatabaseConnection,
  authz: ReturnType<typeof resolveAuthz>,
): Promise<void> {
  const set = await authz.permissionSets.get('staff');
  if (!set) {
    throw new Error('staff permission set is missing');
  }
  const next = grantsOf(set).filter(
    (grant) =>
      !isShiftsGrant(grant) ||
      !grant.actions.some((action) => action.action === 'view'),
  );
  await connection.query
    .updateTable('authorizationPermissionSets')
    .set({ grants: JSON.stringify(next) })
    .where('key', '=', 'staff')
    .execute();
}

function resolveAuthz(app: {
  container: { resolve(token: typeof authorizationToken): unknown };
}) {
  return app.container.resolve(authorizationToken) as {
    permissionSets: {
      get(key: string): Promise<
        | { grants: unknown; revision?: string; key: string }
        | undefined
      >;
      list(): Promise<
        readonly { key: string; grants: unknown; revision?: string }[]
      >;
      update(
        key: string,
        input: { key: string; grants: unknown },
        revision: string,
      ): Promise<unknown>;
    };
    compositeResources: {
      getAction(resource: string, action: string): unknown;
      validateGrant(input: unknown): string | undefined;
    };
  };
}

const canShifts = (
  authz: ReturnType<typeof resolveAuthz> & {
    for(input: { principal: { type: string; id: string } }): {
      can(request: {
        resource: { type: string; id: string };
        action: string;
      }): Promise<boolean>;
    };
  },
  userId: string,
  action: string,
) =>
  authz
    .for({ principal: { type: 'user', id: userId } })
    .can({ resource: { type: 'composite', id: SHIFTS_RESOURCE }, action });

test('R-025 升级：旧环境的 staff 拿到只读，写与其他角色不变，重跑不写', async ({
  app,
  testApp,
  connection,
}) => {
  const authz = app.container.resolve(authorizationToken);
  await stripShiftsView(connection, authz);
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const created = await admin.fetch('/users', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: 'http://localhost',
      'Idempotency-Key': `${Date.now()}.${randomUUID()}`,
    },
    body: JSON.stringify({
      name: unique('r025up'),
      username: unique('r025up'),
      email: `${unique('r025up')}@example.test`,
      password: PASSWORD,
      roleScopes: { app: ['staff'] },
    }),
  });
  expect(created.status).toBe(201);
  const userId = String((await created.json()).data.id);
  const before = await authz.permissionSets.get('staff');
  const managerBefore = await authz.permissionSets.get('quality_manager');

  // 前置条件真的成立：升级前 staff 读不到班次。
  expect(await canShifts(authz, userId, 'view')).toBe(false);
  expect(await canShifts(authz, userId, 'manage')).toBe(false);

  const report = await upgradeR025({ authorization: authz }, {
    info: () => undefined,
  });
  expect(report.changed).toEqual(['staff']);
  expect(report.unchanged).toEqual([]);
  expect(await canShifts(authz, userId, 'view')).toBe(true);
  expect(await canShifts(authz, userId, 'manage')).toBe(false);

  const after = await authz.permissionSets.get('staff');
  expect(after?.revision).not.toBe(before?.revision);
  const added = grantsOf(after!).filter(isShiftsGrant);
  expect(added).toEqual([shiftsViewGrant()]);
  // 页面授权与写授权都没有被悄悄加上。
  expect(
    grantsOf(after!).filter(
      (grant) => grant.resource.type === 'page' && grant.resource.id === 'shifts',
    ),
  ).toEqual([]);
  expect(grantsOf(after!).some((grant) => isShiftsGrant(grant) && grant.actions.some((a) => a.action === 'manage'))).toBe(false);
  expect(await authz.permissionSets.get('quality_manager')).toEqual(
    managerBefore,
  );

  const again = await upgradeR025({ authorization: authz }, {
    info: () => undefined,
  });
  expect(again.unchanged).toEqual(['staff']);
  expect(again.changed).toEqual([]);
  expect((await authz.permissionSets.get('staff'))?.revision).toBe(
    after?.revision,
  );
});

test('R-025 升级：写入带读到的 revision，声明对不上时整条跳过', async ({
  app,
  connection,
}) => {
  const authz = app.container.resolve(authorizationToken);
  const client = resolveAuthz(app);
  await stripShiftsView(connection, authz);
  const set = await authz.permissionSets.get('staff');
  expect(set?.revision, '前置条件：权限集有 revision').toBeDefined();

  const update = vi.spyOn(client.permissionSets, 'update');
  try {
    await upgradeR025({ authorization: client }, { info: () => undefined });
    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0]?.[2]).toBe(set?.revision);
  } finally {
    update.mockRestore();
  }

  // 声明里没有 shifts.view 时，命令必须整条跳过、什么都不写。
  await stripShiftsView(connection, authz);
  const action = vi
    .spyOn(client.compositeResources, 'getAction')
    .mockReturnValue(undefined);
  try {
    const skip = await upgradeR025(
      { authorization: client },
      { info: () => undefined },
    );
    expect(skip.invalid).toEqual(['staff']);
    expect(skip.changed).toEqual([]);
    const after = await authz.permissionSets.get('staff');
    expect(
      grantsOf(after!).filter(isShiftsGrant),
      '声明对不上时不能留下授权',
    ).toEqual([]);
  } finally {
    action.mockRestore();
  }
});
