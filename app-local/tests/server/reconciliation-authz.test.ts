// @vitest-environment node
import {
  DEFAULT_ADMIN_CREDENTIALS,
  signIn,
  type TestSession,
} from '@nocobase/app-plugin-authentication/testing';
import { expect } from 'vitest';

import { createAppTest } from '../helpers/test-app.js';
import { createItem } from '../helpers/inventory.js';
import {
  createOrder,
  get,
  jsonOf,
  makeRoleUser,
  write,
  type Row,
} from '../helpers/orders.js';
import { createStandaloneServer } from '../../server/standalone.js';

/**
 * R-065 复刻波 2 授权：四张财务单、两个 options 与销售窄读全只有 finance 与 root；
 * 先授权后读内容；finance 没有销售的 view。测试数据一律编造。
 */
const test = createAppTest({
  createServer: createStandaloneServer,
  config: {
    app: { publicOrigin: 'http://localhost' },
    auth: { secret: 'test-auth-secret-at-least-32-characters' },
  },
});
const TIMEOUT = 30_000;
const ACTIONS = ['view', 'create', 'update', 'confirm', 'void'];

const FINANCE_GRANTS = [
  ...['incomeRecords', 'saleInvoiceRecords', 'receivableRecons', 'payableRecons']
    .map((id) => ({ resource: { type: 'composite', id }, actions: ACTIONS.map((action) => ({ action })) })),
  { resource: { type: 'composite', id: 'salesOrders' }, actions: [{ action: 'financeView' }] },
];

async function makeUser(
  admin: TestSession, testApp: Parameters<typeof signIn>[0], prefix: string, roles: readonly string[],
): Promise<TestSession> {
  const username = `${prefix}${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
  const created = await admin.fetch('/users', write({
    name: username, username, email: `${username}@example.test`,
    password: 'R065-authz-123!', roleScopes: { app: [...roles] },
  }));
  expect(created.status, `建用户失败：${await created.clone().text()}`).toBe(201);
  return await signIn(testApp, { username, password: 'R065-authz-123!' });
}

const ENDPOINTS = [
  '/income-records', '/sale-invoice-records', '/receivable-recons', '/payable-recons',
  '/receivable-recons/options', '/payable-recons/options', '/sales-orders/receivable',
];

test('采购、销售、仓管、计划、无角色用户碰本片端点都是 403，先授权后读内容', async ({ testApp }) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const sessions = await Promise.all([
    makeUser(admin, testApp, 'r065rbuyer', ['purchase']),
    makeUser(admin, testApp, 'r065rseller', ['sales']),
    makeUser(admin, testApp, 'r065rkeeper', ['warehouse']),
    makeUser(admin, testApp, 'r065rplanner', ['planning']),
    makeUser(admin, testApp, 'r065rnobody', []),
  ]);
  for (const [index, session] of sessions.entries()) {
    const role = ['purchase', 'sales', 'warehouse', 'planning', 'none'][index]!;
    for (const path of ENDPOINTS) {
      const response = await session.fetch(path, get());
      expect(response.status, `${role} GET ${path} 应当 403`).toBe(403);
    }
    // 带非法内容的建单也必须先 403，不能先报 422 泄露校验信息。
    for (const path of [
      '/income-records', '/sale-invoice-records', '/receivable-recons', '/payable-recons',
    ]) {
      const invalid = await session.fetch(path, write({ totallyInvalid: true }));
      expect(invalid.status, `${role} POST ${path} 应当先 403`).toBe(403);
      expect((await jsonOf(invalid)).error?.reason, '不能先做内容校验').not.toMatch(
        /^(FINANCE_|RECON_)/u,
      );
    }
  }
}, TIMEOUT);

test('财务拿不到销售订单的列表与详情，窄读只有八列头与客户三列', async ({
  testApp, connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const { session: finance } = await makeRoleUser(
    admin, testApp, 'r065rnarrow', FINANCE_GRANTS,
  );
  const itemId = await createItem(connection);
  const order = await createOrder(admin, 'sales', {
    lines: [{ itemId, qty: 1, price: 10, taxRate: 13 }], remark: '不该被财务看到',
  });
  expect((await admin.fetch(`/sales-orders/${String(order.id)}/submit`, write())).status).toBe(200);
  expect((await finance.fetch('/sales-orders', get())).status, '没有 view').toBe(403);
  expect((await finance.fetch(`/sales-orders/${String(order.id)}`, get())).status).toBe(403);

  const response = await jsonOf(await finance.fetch('/sales-orders/receivable', get()));
  expect(response.total).toBeGreaterThan(0);
  const row: Row = response.items![0]!;
  for (const key of ['lines', 'remark', 'price', 'handler', 'handlerUserId', 'taxIncludedTotal']) {
    expect(Object.keys(row), `${key} 不该出现在窄读响应里`).not.toContain(key);
  }
  expect(Object.keys(row.customer as Row).sort()).toEqual(['code', 'id', 'name']);
  expect(Object.keys(row).sort()).toEqual([
    'customer', 'customerId', 'id', 'invoicedAmount', 'orderDate', 'orderNo',
    'payableTotal', 'receivedAmount', 'status',
  ]);

  for (const path of [
    '/income-records', '/sale-invoice-records', '/receivable-recons', '/payable-recons',
  ]) {
    const removed = await finance.fetch(`${path}/no-such`, {
      method: 'DELETE', headers: { origin: 'http://localhost' },
    });
    expect([403, 404, 405]).toContain(removed.status);
  }
}, TIMEOUT);
