// @vitest-environment node
import {
  DEFAULT_ADMIN_CREDENTIALS,
  signIn,
  type TestSession,
} from '@nocobase/app-plugin-authentication/testing';
import { authorizationToken } from '@nocobase/app-plugin-authorization';
import type { PermissionGrant } from '@nocobase/authorization/core';
import { expect } from 'vitest';

import { createAppTest } from '../helpers/test-app.js';
import { createItem } from '../helpers/inventory.js';
import {
  createEmployee,
  createOrder,
  jsonOf,
  unique,
  write,
} from '../helpers/orders.js';
import { createStandaloneServer } from '../../server/standalone.js';

/**
 * R-070 IQC 授权：资源与六个动作逐项注册；建改完成、作废、查看、窄读分别只给设计里的角色。
 * 只断言本片的授权条目，不拿整份角色授权做 toEqual —— 整份清单由 business-permission-sets 钉。
 */
const test = createAppTest({
  createServer: createStandaloneServer,
  config: {
    app: { publicOrigin: 'http://localhost' },
    auth: { secret: 'test-auth-secret-at-least-32-characters' },
  },
});

const PASSWORD = 'R070-iqc-authz-123!';
type Row = Record<string, unknown>;

async function makeRoleUser(
  admin: TestSession,
  testApp: Parameters<typeof signIn>[0],
  prefix: string,
  role: string,
): Promise<{ session: TestSession; id: string }> {
  const username = unique(prefix);
  const created = await admin.fetch('/users', write({
    name: username,
    username,
    email: `${username.toLowerCase()}@example.test`,
    password: PASSWORD,
    roleScopes: { app: [role] },
  }));
  expect(created.status, `建用户失败：${await created.clone().text()}`).toBe(201);
  const id = String(((await jsonOf(created)).data as Row | undefined)?.id ?? '');
  return { session: await signIn(testApp, { username, password: PASSWORD }), id };
}

const actionsOf = (
  grants: readonly PermissionGrant[],
  resourceId: string,
): readonly string[] =>
  grants
    .filter((grant) => grant.resource.type === 'composite' && grant.resource.id === resourceId)
    .flatMap((grant) => grant.actions.map((action) => action.action))
    .sort();

test('IQC 资源注册：两张表不登记删除，六个动作齐全且不做页面目录', async ({ app }) => {
  const authz = app.container.resolve(authorizationToken);
  const definition = authz.database.collections.list()
    .find((entry) => entry.name === 'inspectionOrders');
  expect(definition, 'inspectionOrders 没有登记').toBeDefined();
  expect(definition?.actions).toEqual(['read', 'create', 'update']);
  const lineDefinition = authz.database.collections.list()
    .find((entry) => entry.name === 'inspectionLines');
  expect(lineDefinition, 'inspectionLines 没有登记').toBeDefined();
  expect(lineDefinition?.actions).toEqual(['read', 'create', 'update']);
  expect(
    authz.compositeResources.list().find((entry) => entry.name === 'inspectionOrders')
      ?.actions.map((action) => action.name).sort(),
  ).toEqual(['complete', 'create', 'receiveView', 'update', 'view', 'void']);
  expect(
    authz.ui.placementOf({ type: 'composite', id: 'inspectionOrders' }),
    '本片没有页面，不该进角色编辑器',
  ).toBeUndefined();
});

test('IQC 授权逐条在、禁止的逐条不在，别的角色没有本片资源', async ({ app }) => {
  const authz = app.container.resolve(authorizationToken);
  const sets = await authz.permissionSets.list();
  const byRole = new Map(sets.map((set) => [set.key, set]));
  const iqcActions = (role: string) =>
    actionsOf((byRole.get(role)?.grants ?? []) as PermissionGrant[], 'inspectionOrders');

  expect(iqcActions('quality_inspector')).toEqual([
    'complete', 'create', 'update', 'view',
  ]);
  expect(iqcActions('quality_manager')).toEqual(['view', 'void']);
  expect(iqcActions('purchase')).toEqual(['view']);
  expect(iqcActions('warehouse')).toEqual(['receiveView']);
  for (const role of ['sales', 'finance', 'staff', 'dept_manager', 'planning']) {
    expect(iqcActions(role), `${role} 不该拿到检验资源`).toEqual([]);
  }
  // root 直通，不写进任何权限集；上面逐角色断言已经把禁止的动作排除了。
});

test('IQC 端点反向断言：无授权的角色先被 403，不会先回 422/404', async ({
  testApp, app, connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const authz = app.container.resolve(authorizationToken);
  const rootId = String(admin.user.id);
  expect((await authz.for({ principal: { type: 'user', id: rootId } })
    .authorize({ resource: { type: 'composite', id: 'inspectionOrders' }, action: 'complete' })).effect)
    .not.toBe('deny');

  const inspector = await makeRoleUser(admin, testApp, 'iqcok', 'quality_inspector');
  await createEmployee(connection, inspector.id);
  const itemId = await createItem(connection);
  const order = await createOrder(admin, 'purchase', { lines: [{ itemId, qty: 10 }] });
  expect(
    (await admin.fetch(`/purchase-orders/${String(order.id)}/submit`, write())).status,
  ).toBe(200);
  const created = await inspector.session.fetch('/inspections', write({
    purchaseOrderId: order.id,
    lines: [{
      itemId, inspectionTypeCode: 'full', receivedQty: 10, inspectionQty: 8,
      qualifiedQty: 7, samplingQty: 2, samplingQualifiedQty: 2,
    }],
  }));
  expect(created.status).toBe(201);
  const id = String((await jsonOf(created)).id);

  const purchase = await makeRoleUser(admin, testApp, 'iqcpurchase', 'purchase');
  const manager = await makeRoleUser(admin, testApp, 'iqcmanager', 'quality_manager');
  const keeper = await makeRoleUser(admin, testApp, 'iqckeeper', 'warehouse');
  const sales = await makeRoleUser(admin, testApp, 'iqcsales', 'sales');

  const forbidden: [TestSession, string, string, RequestInit][] = [
    // 采购建单即使带空 body 也是 403，不是 422。
    [purchase.session, '/inspections', 'POST', write({})],
    [purchase.session, `/inspections/${id}/complete`, 'POST', write()],
    [purchase.session, `/inspections/${id}/void`, 'POST', write()],
    [purchase.session, '/inspections/receivable-options', 'GET', { method: 'GET' }],
    [manager.session, '/inspections', 'POST', write({})],
    [manager.session, `inspections/${id}/complete`, 'POST', write()],
    [keeper.session, '/inspections', 'POST', write({})],
    [keeper.session, `/inspections/${id}`, 'GET', { method: 'GET' }],
    [keeper.session, `/inspections/${id}/complete`, 'POST', write()],
    [sales.session, '/inspections', 'GET', { method: 'GET' }],
    [sales.session, `/inspections/${id}`, 'GET', { method: 'GET' }],
    [sales.session, '/inspections/receivable-options', 'GET', { method: 'GET' }],
  ];
  for (const [session, path, method, init] of forbidden) {
    const target = path.startsWith('/') ? path : `/${path}`;
    const response = await session.fetch(target, init);
    expect(response.status, `${method} ${target} 应当 403`).toBe(403);
  }

  // 两个质量角色与采购都能 view；仓管只能拿窄读。
  for (const session of [inspector.session, manager.session, purchase.session]) {
    expect((await session.fetch(`/inspections/${id}`, { method: 'GET' })).status).toBe(200);
  }
  expect((await keeper.session.fetch('/inspections/receivable-options', { method: 'GET' })).status)
    .toBe(200);
});
