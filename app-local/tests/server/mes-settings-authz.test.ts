// @vitest-environment node
import { randomUUID } from 'node:crypto';

import {
  DEFAULT_ADMIN_CREDENTIALS,
  signIn,
  type TestSession,
} from '@nocobase/app-plugin-authentication/testing';
import { authorizationToken } from '@nocobase/app-plugin-authorization';
import type { PermissionGrant } from '@nocobase/authorization/core';
import { expect } from 'vitest';

import { createAppTest } from '../helpers/test-app.js';
import { get, jsonOf, unique, write } from '../helpers/orders.js';
import { createStandaloneServer } from '../../server/standalone.js';

/**
 * R-023 W3-1 授权：mesSettings 只注册三个动作；view 给五个角色，priceView 只给财务，
 * maintain 只给 root。端点反向断言：无授权角色先 403、响应不含 items；
 * 车间能读设置但拿不到 unitPrice 键。
 */
const test = createAppTest({
  createServer: createStandaloneServer,
  config: {
    app: { publicOrigin: 'http://localhost' },
    auth: { secret: 'test-auth-secret-at-least-32-characters' },
  },
});

const PASSWORD = 'R023-mes-authz-123!';
type Row = Record<string, unknown>;

async function makeRoleUser(
  admin: TestSession,
  testApp: Parameters<typeof signIn>[0],
  prefix: string,
  role: string,
): Promise<TestSession> {
  const username = unique(prefix);
  const created = await admin.fetch('/users', write({
    name: username,
    username,
    email: `${username.toLowerCase()}@example.test`,
    password: PASSWORD,
    roleScopes: { app: [role] },
  }));
  expect(created.status, `建用户失败：${await created.clone().text()}`).toBe(201);
  return await signIn(testApp, { username, password: PASSWORD });
}

const actionsOf = (
  grants: readonly PermissionGrant[],
  resourceId: string,
): readonly string[] =>
  grants
    .filter((grant) => grant.resource.type === 'composite' && grant.resource.id === resourceId)
    .flatMap((grant) => grant.actions.map((action) => action.action))
    .sort();

test('R-023 W3-1: 七张表只登记读建改；mesSettings 三个动作，不做页面目录', async ({ app }) => {
  const authz = app.container.resolve(authorizationToken);
  for (const name of [
    'workCenters', 'operations', 'processRoutes', 'processRouteSteps',
    'defectItems', 'reportRules', 'operationPrices',
  ]) {
    const definition = authz.database.collections.list().find((entry) => entry.name === name);
    expect(definition, `${name} 没有登记`).toBeDefined();
    expect(definition?.actions, `${name} 不该登记删除`).toEqual(['read', 'create', 'update']);
  }
  expect(
    authz.compositeResources.list().find((entry) => entry.name === 'mesSettings')
      ?.actions.map((action) => action.name).sort(),
  ).toEqual(['maintain', 'priceView', 'view']);
  expect(
    authz.ui.placementOf({ type: 'composite', id: 'mesSettings' }),
    '本片没有页面，不该进角色编辑器',
  ).toBeUndefined();
});

test('R-023 W3-1: 授权逐条在、禁止的逐条不在', async ({ app }) => {
  const authz = app.container.resolve(authorizationToken);
  const sets = await authz.permissionSets.list();
  const byRole = new Map(sets.map((set) => [set.key, set]));
  const mesActions = (role: string) =>
    actionsOf((byRole.get(role)?.grants ?? []) as PermissionGrant[], 'mesSettings');

  expect(mesActions('craft')).toEqual(['view']);
  expect(mesActions('planning')).toEqual(['view']);
  expect(mesActions('production')).toEqual(['view']);
  expect(mesActions('warehouse')).toEqual(['view']);
  expect(mesActions('quality_inspector')).toEqual(['view']);
  expect(mesActions('finance')).toEqual(['priceView']);
  for (const role of ['purchase', 'sales', 'staff', 'dept_manager', 'quality_manager']) {
    expect(mesActions(role), `${role} 不该拿到 mesSettings`).toEqual([]);
  }
  // maintain 只给 root：任何业务角色都不该拿到，root 直通、不写进权限集。
  for (const set of sets) {
    expect(
      actionsOf(set.grants as PermissionGrant[], 'mesSettings'),
      `${set.key} 不该拿到 maintain`,
    ).not.toContain('maintain');
  }
});

test('R-023 W3-1: 端点反向——无授权先 403 且无 items，车间看不到 unitPrice', async ({
  testApp, app,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const authz = app.container.resolve(authorizationToken);
  expect((await authz.for({ principal: { type: 'user', id: String(admin.user.id) } })
    .authorize({ resource: { type: 'composite', id: 'mesSettings' }, action: 'maintain' })).effect)
    .not.toBe('deny');

  const purchase = await makeRoleUser(admin, testApp, 'r023purchase', 'purchase');
  const sales = await makeRoleUser(admin, testApp, 'r023sales', 'sales');
  const production = await makeRoleUser(admin, testApp, 'r023shop', 'production');
  const quality = await makeRoleUser(admin, testApp, 'r023quality', 'quality_inspector');
  const finance = await makeRoleUser(admin, testApp, 'r023finance', 'finance');

  const itemId = randomUUID();
  const operationId = randomUUID();
  const priced = await admin.fetch('/operation-prices', write({
    itemId, operationId, unitPrice: 88.88, note: '编造的工价',
  }));
  expect(priced.status).toBe(201);

  const forbidden: [TestSession, string, RequestInit][] = [
    [purchase, '/work-centers', get()],
    [purchase, '/operations', get()],
    [purchase, '/process-routes', get()],
    [purchase, '/defect-items', get()],
    [purchase, '/report-rules', get()],
    [purchase, '/operation-prices', get()],
    [sales, '/work-centers', get()],
    [sales, '/operation-prices', get()],
    [purchase, '/operation-prices', write({ itemId, operationId })],
    [production, '/work-centers', write({ code: unique('WC'), name: '车间不该建' })],
    [quality, '/operations', write({ code: unique('OP'), name: '质量不该建' })],
    [finance, '/work-centers', write({ code: unique('WC'), name: '财务不该建' })],
    [production, '/report-rules/autoReport', write({ value: 'yes' }, 'PATCH')],
  ];
  for (const [session, path, init] of forbidden) {
    const response = await session.fetch(path, init);
    expect(response.status, `${String(init.method ?? 'GET')} ${path} 应当 403`).toBe(403);
    const body = await jsonOf(response);
    expect(Object.prototype.hasOwnProperty.call(body, 'items'), `${path} 的 403 不该带 items`).toBe(false);
  }

  for (const path of ['/work-centers', '/operations', '/process-routes', '/defect-items', '/report-rules']) {
    expect((await production.fetch(path, get())).status, `${path} 车间应可读`).toBe(200);
    expect((await quality.fetch(path, get())).status, `${path} 质量应可读`).toBe(200);
  }

  const shopPrices = await production.fetch('/operation-prices', get());
  expect(shopPrices.status).toBe(200);
  const shopBody = await jsonOf(shopPrices);
  expect(Object.prototype.hasOwnProperty.call(
    (shopBody.items as Row[])[0]!, 'unitPrice',
  )).toBe(false);

  const financePrices = await finance.fetch('/operation-prices', get());
  expect(financePrices.status).toBe(200);
  expect((await jsonOf(financePrices)).items).toHaveLength(1);
  expect(((await jsonOf(await finance.fetch('/operation-prices', get()))).items as Row[])[0]?.unitPrice)
    .toBe(88.88);
});
