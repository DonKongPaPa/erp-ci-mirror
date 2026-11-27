// @vitest-environment node
import { randomUUID } from 'node:crypto';

import {
  DEFAULT_ADMIN_CREDENTIALS,
  signIn,
  type TestSession,
} from '@nocobase/app-plugin-authentication/testing';
import { authorizationToken } from '@nocobase/app-plugin-authorization';
import type { DatabaseConnection } from '@nocobase/db';
import { expect, vi } from 'vitest';

import {
  CUSTOMERS_RESOURCE,
  PARTNER_ACTIONS,
  PURCHASE_PERMISSION_SET,
  SALES_PERMISSION_SET,
  SUPPLIERS_RESOURCE,
  partnerGrant,
  upgradeR014,
} from '../../cli/authz/upgrade-r014.js';
import { createAppTest } from '../helpers/test-app.js';
import { createStandaloneServer } from '../../server/standalone.js';

/**
 * R-014 升级命令：已有环境里 seed 不会给销售/采购补客户/供应商授权。
 * 每个用例从 seed 形状出发，用 SQL 把两个角色的授权删掉，再跑命令；断言有效权限
 * `can()`、库里的形状、幂等与 revision。声明对不上时整条跳过、什么都不写。
 */
const test = createAppTest({
  scope: 'test',
  createServer: createStandaloneServer,
  config: {
    app: { publicOrigin: 'http://localhost' },
    auth: { secret: 'test-auth-secret-at-least-32-characters' },
  },
});

const PASSWORD = 'R014-upgrade-123!';
const unique = (prefix: string) =>
  `${prefix}${randomUUID().replaceAll('-', '').slice(0, 10)}`;

interface StoredGrant {
  resource: { type: string; id: string };
  actions: { action: string; policy?: unknown }[];
}
const grantsOf = (set: { grants: unknown }): StoredGrant[] =>
  JSON.parse(JSON.stringify(set.grants)) as StoredGrant[];
const isPartnerGrant = (grant: StoredGrant): boolean =>
  grant.resource.type === 'composite' &&
  [CUSTOMERS_RESOURCE, SUPPLIERS_RESOURCE].includes(grant.resource.id);

async function stripPartnerGrants(connection: DatabaseConnection): Promise<void> {
  for (const key of [SALES_PERMISSION_SET, PURCHASE_PERMISSION_SET]) {
    await connection.query
      .updateTable('authorizationPermissionSets')
      .set({ grants: '[]' })
      .where('key', '=', key)
      .execute();
  }
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
      list(): Promise<readonly { key: string; grants: unknown; revision?: string }[]>;
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
    for(input: { principal: { type: string; id: string } }): {
      can(request: {
        resource: { type: string; id: string };
        action: string;
      }): Promise<boolean>;
    };
  };
}

const makeUser = async (
  admin: TestSession,
  testApp: Parameters<typeof signIn>[0],
  prefix: string,
  roles: readonly string[],
): Promise<string> => {
  const username = unique(prefix);
  const created = await admin.fetch('/users', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: 'http://localhost',
      'Idempotency-Key': `${Date.now()}.${randomUUID()}`,
    },
    body: JSON.stringify({
      name: username,
      username,
      email: `${username}@example.test`,
      password: PASSWORD,
      roleScopes: { app: [...roles] },
    }),
  });
  expect(created.status).toBe(201);
  return String((await created.json()).data.id);
};

test('R-014 升级：旧环境的销售/采购拿到授权，其他角色不变，重跑不写', async ({
  app,
  testApp,
  connection,
}) => {
  await stripPartnerGrants(connection);
  const authz = resolveAuthz(app);
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const salesId = await makeUser(admin, testApp, 'r014sales', ['sales']);
  const purchaseId = await makeUser(admin, testApp, 'r014buy', ['purchase']);
  const can = (userId: string, resource: string, action: string) =>
    authz
      .for({ principal: { type: 'user', id: userId } })
      .can({ resource: { type: 'composite', id: resource }, action });

  // 前置条件：升级前两个角色都没有授权。
  expect(await can(salesId, CUSTOMERS_RESOURCE, 'view')).toBe(false);
  expect(await can(purchaseId, SUPPLIERS_RESOURCE, 'view')).toBe(false);

  const report = await upgradeR014({ authorization: authz }, { info: () => undefined });
  expect(report.changed).toEqual([SALES_PERMISSION_SET, PURCHASE_PERMISSION_SET]);
  expect(report.unchanged).toEqual([]);
  expect(await can(salesId, CUSTOMERS_RESOURCE, 'view')).toBe(true);
  expect(await can(salesId, CUSTOMERS_RESOURCE, 'create')).toBe(true);
  expect(await can(salesId, CUSTOMERS_RESOURCE, 'update')).toBe(true);
  expect(await can(salesId, SUPPLIERS_RESOURCE, 'view')).toBe(false);
  expect(await can(purchaseId, SUPPLIERS_RESOURCE, 'view')).toBe(true);
  expect(await can(purchaseId, CUSTOMERS_RESOURCE, 'view')).toBe(false);

  const salesAfter = await authz.permissionSets.get(SALES_PERMISSION_SET);
  expect(grantsOf(salesAfter!).filter(isPartnerGrant)).toEqual([
    partnerGrant(CUSTOMERS_RESOURCE, [...PARTNER_ACTIONS]),
  ]);

  const beforeRevision = salesAfter?.revision;
  const again = await upgradeR014({ authorization: authz }, { info: () => undefined });
  expect(again.unchanged).toEqual([SALES_PERMISSION_SET, PURCHASE_PERMISSION_SET]);
  expect(again.changed).toEqual([]);
  expect((await authz.permissionSets.get(SALES_PERMISSION_SET))?.revision).toBe(
    beforeRevision,
  );
});

test('R-014 升级：写入带读到的 revision，声明对不上整条跳过', async ({
  app,
  connection,
}) => {
  const authz = resolveAuthz(app);
  await stripPartnerGrants(connection);
  const before = await authz.permissionSets.get(SALES_PERMISSION_SET);
  expect(before?.revision, '前置条件：权限集有 revision').toBeDefined();

  const update = vi.spyOn(authz.permissionSets, 'update');
  try {
    await upgradeR014({ authorization: authz }, { info: () => undefined });
    expect(update).toHaveBeenCalledTimes(2);
    expect(update.mock.calls[0]?.[2]).toBe(before?.revision);
  } finally {
    update.mockRestore();
  }

  await stripPartnerGrants(connection);
  const action = vi
    .spyOn(authz.compositeResources, 'getAction')
    .mockReturnValue(undefined);
  try {
    const skip = await upgradeR014({ authorization: authz }, { info: () => undefined });
    expect(skip.invalid).toEqual([SALES_PERMISSION_SET, PURCHASE_PERMISSION_SET]);
    expect(skip.changed).toEqual([]);
    const after = await authz.permissionSets.get(SALES_PERMISSION_SET);
    expect(grantsOf(after!).filter(isPartnerGrant)).toEqual([]);
  } finally {
    action.mockRestore();
  }
});
