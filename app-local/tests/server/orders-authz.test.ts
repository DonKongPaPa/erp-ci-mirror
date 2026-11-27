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
  createWarehouse,
  get,
  jsonOf,
  unique,
  write,
} from '../helpers/orders.js';
import { createStandaloneServer } from '../../server/standalone.js';

/**
 * R-021/R-022 授权：采购碰不了销售订单、销售碰不了采购订单，别的角色两边全 403；
 * 先授权后读内容；不提供删除。
 */
const test = createAppTest({
  createServer: createStandaloneServer,
  config: {
    app: { publicOrigin: 'http://localhost' },
    auth: { secret: 'test-auth-secret-at-least-32-characters' },
  },
});

const TIMEOUT = 30_000;
const PASSWORD = 'R021-authz-123!';

async function makeUser(
  admin: TestSession,
  testApp: Parameters<typeof signIn>[0],
  prefix: string,
  roles: readonly string[],
): Promise<TestSession> {
  const username = unique(prefix);
  const created = await admin.fetch('/users', write({
    name: username,
    username,
    email: `${username.toLowerCase()}@example.test`,
    password: PASSWORD,
    roleScopes: { app: [...roles] },
  }));
  expect(created.status).toBe(201);
  return await signIn(testApp, { username, password: PASSWORD });
}

test('采购角色：采购订单七个端点可用，物料/单位/分类/仓库只读', async ({ testApp, connection }) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const buyer = await makeUser(admin, testApp, 'r021buyer', ['purchase']);
  const item = await createItem(connection);
  const warehouse = await createWarehouse(admin);
  const supplier = await jsonOf(await admin.fetch('/partners', write({
    name: unique('供应商'), isSupplier: true,
  })));

  for (const path of ['/items', '/units', '/item-categories', '/warehouses']) {
    expect((await buyer.fetch(path, get())).status, `${path} 应当只读`).toBe(200);
  }
  const created = await buyer.fetch('/purchase-orders', write({
    supplierId: supplier.id,
    orderDate: '2026-11-27',
    lines: [{ itemId: item, qty: 3 }],
  }));
  expect(created.status, `采购建单失败：${await created.clone().text()}`).toBe(201);
  const id = String((await jsonOf(created)).id);
  expect((await buyer.fetch('/purchase-orders', get())).status).toBe(200);
  expect((await buyer.fetch(`/purchase-orders/${id}`, get())).status).toBe(200);
  expect((await buyer.fetch(`/purchase-orders/${id}`, write({
    remark: '采购改的', lines: [{ itemId: item, qty: 4 }],
  }, 'PATCH'))).status).toBe(200);
  expect((await buyer.fetch(`/purchase-orders/${id}/submit`, write())).status).toBe(200);
  const issued = await buyer.fetch(`/purchase-orders/${id}/create-receipt`, write({
    warehouseId: warehouse.id,
  }));
  expect(issued.status, `采购生成入库单失败：${await issued.clone().text()}`).toBe(201);
  const cancelled = await createOrder(buyer, 'purchase', { lines: [{ itemId: item, qty: 1 }] });
  expect((await buyer.fetch(`/purchase-orders/${String(cancelled.id)}/cancel`, write())).status).toBe(200);
  const removed = await buyer.fetch(`/purchase-orders/${id}`, {
    method: 'DELETE', headers: { origin: 'http://localhost' },
  });
  expect([404, 405]).toContain(removed.status);
}, TIMEOUT);

test('销售角色：销售订单七个端点可用，物料/单位/仓库只读', async ({ testApp, connection }) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const seller = await makeUser(admin, testApp, 'r022seller', ['sales']);
  const item = await createItem(connection);
  const warehouse = await createWarehouse(admin);
  const customer = await jsonOf(await admin.fetch('/partners', write({
    name: unique('客户'), isCustomer: true,
  })));

  for (const path of ['/items', '/units', '/warehouses']) {
    expect((await seller.fetch(path, get())).status, `${path} 应当只读`).toBe(200);
  }
  const created = await seller.fetch('/sales-orders', write({
    customerId: customer.id,
    orderDate: '2026-11-27',
    lines: [{ itemId: item, qty: 3 }],
  }));
  expect(created.status, `销售建单失败：${await created.clone().text()}`).toBe(201);
  const id = String((await jsonOf(created)).id);
  expect((await seller.fetch('/sales-orders', get())).status).toBe(200);
  expect((await seller.fetch(`/sales-orders/${id}`, get())).status).toBe(200);
  expect((await seller.fetch(`/sales-orders/${id}`, write({
    remark: '销售改的', lines: [{ itemId: item, qty: 4 }],
  }, 'PATCH'))).status).toBe(200);
  expect((await seller.fetch(`/sales-orders/${id}/submit`, write())).status).toBe(200);
  const issued = await seller.fetch(`/sales-orders/${id}/create-issue`, write({
    warehouseId: warehouse.id,
  }));
  expect(issued.status, `销售生成出库单失败：${await issued.clone().text()}`).toBe(201);
  const cancelled = await createOrder(seller, 'sales', { lines: [{ itemId: item, qty: 1 }] });
  expect((await seller.fetch(`/sales-orders/${String(cancelled.id)}/cancel`, write())).status).toBe(200);
}, TIMEOUT);

test('采购碰销售订单 403，销售碰采购订单 403，别的角色两边全 403，先授权后读内容', async ({
  testApp, connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const item = await createItem(connection);
  const warehouse = await createWarehouse(admin);
  const purchase = await createOrder(admin, 'purchase', { lines: [{ itemId: item, qty: 1 }] });
  const sales = await createOrder(admin, 'sales', { lines: [{ itemId: item, qty: 1 }] });
  const buyer = await makeUser(admin, testApp, 'r021xbuyer', ['purchase']);
  const seller = await makeUser(admin, testApp, 'r022xseller', ['sales']);
  const others = await Promise.all([
    makeUser(admin, testApp, 'r021staff', ['staff']),
    makeUser(admin, testApp, 'r021warehouse', ['warehouse']),
    makeUser(admin, testApp, 'r021manager', ['quality_manager']),
    makeUser(admin, testApp, 'r021nobody', []),
  ]);

  const salesCalls = (): RequestInit[] => [
    get(),
    get(),
    write({ customerId: 'x', orderDate: '2026-11-27', lines: [] }),
    write({ remark: 'x' }, 'PATCH'),
    write(),
    write(),
    write({ warehouseId: String(warehouse.id) }),
  ];
  const salesPaths = (id: string): string[] => [
    '/sales-orders',
    `/sales-orders/${id}`,
    '/sales-orders',
    `/sales-orders/${id}`,
    `/sales-orders/${id}/submit`,
    `/sales-orders/${id}/cancel`,
    `/sales-orders/${id}/create-issue`,
  ];
  for (let i = 0; i < salesPaths(String(sales.id)).length; i += 1) {
    const response = await buyer.fetch(salesPaths(String(sales.id))[i]!, salesCalls()[i]!);
    expect(response.status, '采购不该碰销售订单').toBe(403);
  }

  const purchasePaths = (id: string): string[] => [
    '/purchase-orders',
    `/purchase-orders/${id}`,
    '/purchase-orders',
    `/purchase-orders/${id}`,
    `/purchase-orders/${id}/submit`,
    `/purchase-orders/${id}/cancel`,
    `/purchase-orders/${id}/create-receipt`,
  ];
  const purchaseCalls = (): RequestInit[] => [
    get(),
    get(),
    write({ supplierId: 'x', orderDate: '2026-11-27', lines: [] }),
    write({ remark: 'x' }, 'PATCH'),
    write(),
    write(),
    write({ warehouseId: String(warehouse.id) }),
  ];
  for (let i = 0; i < purchasePaths(String(purchase.id)).length; i += 1) {
    const response = await seller.fetch(purchasePaths(String(purchase.id))[i]!, purchaseCalls()[i]!);
    expect(response.status, '销售不该碰采购订单').toBe(403);
  }

  for (const session of [...others, buyer, seller]) {
    // buyer 对采购、seller 对销售是有权的：这里只检查他们碰不到的那一边。
    const targets: readonly [TestSession, string, RequestInit][] = session === buyer
      ? [[session, '/sales-orders', get()], [session, `/sales-orders/${String(sales.id)}`, get()]]
      : session === seller
        ? [[session, '/purchase-orders', get()], [session, `/purchase-orders/${String(purchase.id)}`, get()]]
        : [
          [session, '/purchase-orders', get()],
          [session, `/purchase-orders/${String(purchase.id)}`, get()],
          [session, '/sales-orders', get()],
          [session, `/sales-orders/${String(sales.id)}`, get()],
          [session, '/purchase-orders', write({ supplierId: 'x', orderDate: '2026-11-27', lines: [] })],
          [session, '/sales-orders', write({ customerId: 'x', orderDate: '2026-11-27', lines: [] })],
        ];
    for (const [who, path, init] of targets) {
      expect((await who.fetch(path, init)).status, `${path} 不该给这个角色`).toBe(403);
    }
  }

  // 先授权后读内容：无授权者发内容非法的请求，先拿 403 而不是 422/404。
  const invalid = await others[3]!.fetch('/purchase-orders', write({
    supplierId: unique('NO-SUPPLIER'),
    orderDate: '2026-11-27',
    lines: [],
  }));
  expect(invalid.status).toBe(403);
  expect((await jsonOf(invalid)).error?.reason).not.toBe('ORDER_LINE_INVALID');
}, TIMEOUT);
