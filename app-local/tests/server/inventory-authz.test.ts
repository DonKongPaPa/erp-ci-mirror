// @vitest-environment node
import { randomUUID } from 'node:crypto';

import {
  DEFAULT_ADMIN_CREDENTIALS,
  signIn,
  type TestSession,
} from '@nocobase/app-plugin-authentication/testing';
import { expect } from 'vitest';

import { createAppTest } from '../helpers/test-app.js';
import { createItem } from '../helpers/inventory.js';
import { createOrder, createPartner, makeRoleUser } from '../helpers/orders.js';
import { createStandaloneServer } from '../../server/standalone.js';

/**
 * R-020 授权：仓管能读仓库、读写单据、读现存量与流水、过账作废，但不能建改仓库；
 * 别的角色这一片全 403；先授权后读内容（无授权者发非法请求先 403 而不是 422）。
 */
const test = createAppTest({
  createServer: createStandaloneServer,
  config: {
    app: { publicOrigin: 'http://localhost' },
    auth: { secret: 'test-auth-secret-at-least-32-characters' },
  },
});

const PASSWORD = 'R020-authz-123!';
const unique = (prefix: string) =>
  `${prefix}${randomUUID().replaceAll('-', '').slice(0, 10).toUpperCase()}`;
const write = (body: unknown = {}, method = 'POST'): RequestInit => ({
  method,
  headers: {
    'content-type': 'application/json',
    origin: 'http://localhost',
    'Idempotency-Key': `${Date.now()}.${randomUUID()}`,
  },
  body: JSON.stringify(body),
});
const get = (): RequestInit => ({ method: 'GET' });

interface Row {
  [key: string]: unknown;
}
const jsonOf = async (response: Response): Promise<Row & { error?: { reason: string } }> =>
  (await response.json()) as Row & { error?: { reason: string } };

async function makeUser(
  admin: TestSession,
  testApp: Parameters<typeof signIn>[0],
  name: string,
  roles: readonly string[],
): Promise<TestSession> {
  const username = unique(name);
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

test('仓管：单据读写、过账、作废、读现存量与流水都可用，但仓库只能读', async ({
  testApp,
  connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const keeper = await makeUser(admin, testApp, 'r020keeper', ['warehouse']);
  const warehouseResponse = await admin.fetch('/warehouses', write({
    code: unique('WH'), name: '授权仓',
  }));
  expect(warehouseResponse.status).toBe(201);
  const warehouseId = String((await jsonOf(warehouseResponse)).id);

  expect((await keeper.fetch('/warehouses', get())).status).toBe(200);
  expect((await keeper.fetch('/stock/balances', get())).status).toBe(200);
  expect((await keeper.fetch('/stock/transactions', get())).status).toBe(200);
  expect((await keeper.fetch('/stock-docs', get())).status).toBe(200);

  // 仓库的建与改只给 root：仓管 403，且先于内容校验。
  const createWarehouse = await keeper.fetch('/warehouses', write({ code: unique('X'), name: '新仓' }));
  expect(createWarehouse.status).toBe(403);
  expect((await jsonOf(createWarehouse)).error?.reason).not.toBe('WAREHOUSE_CODE_EXISTS');
  const patchWarehouse = await keeper.fetch(`/warehouses/${warehouseId}`, write({ name: '改名' }, 'PATCH'));
  expect(patchWarehouse.status).toBe(403);

  const itemId = await createItem(connection);
  const created = await keeper.fetch('/stock-docs', write({
    docType: 'in', reason: 'purchase_receipt',
    lines: [{ itemId, warehouseId, qty: 9 }],
  }));
  expect(created.status, `仓管建单失败：${await created.clone().text()}`).toBe(201);
  const docId = String((await jsonOf(created)).id);
  expect((await keeper.fetch(`/stock-docs/${docId}`, get())).status).toBe(200);
  const patched = await keeper.fetch(`/stock-docs/${docId}`, write({
    remark: '仓管改的', lines: [{ itemId, warehouseId, qty: 10 }],
  }, 'PATCH'));
  expect(patched.status, `仓管改草稿失败：${await patched.clone().text()}`).toBe(200);
  const posted = await keeper.fetch(`/stock-docs/${docId}/post`, write());
  expect(posted.status, `仓管过账失败：${await posted.clone().text()}`).toBe(200);

  const voidDoc = await keeper.fetch('/stock-docs', write({
    docType: 'in', reason: 'other_in',
    lines: [{ itemId, warehouseId, qty: 1 }],
  }));
  expect(voidDoc.status).toBe(201);
  const voidId = String((await jsonOf(voidDoc)).id);
  expect((await keeper.fetch(`/stock-docs/${voidId}/void`, write())).status).toBe(200);
});

test('其余角色与无角色用户：这一片全 403，且先授权后读内容', async ({ testApp, connection }) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const warehouseResponse = await admin.fetch('/warehouses', write({
    code: unique('WH'), name: '旁人仓',
  }));
  expect(warehouseResponse.status).toBe(201);
  const warehouseId = String((await jsonOf(warehouseResponse)).id);
  const itemId = await createItem(connection);
  const docResponse = await admin.fetch('/stock-docs', write({
    docType: 'in', reason: 'purchase_receipt',
    lines: [{ itemId, warehouseId, qty: 1 }],
  }));
  expect(docResponse.status).toBe(201);
  const docId = String((await jsonOf(docResponse)).id);

  const others = await Promise.all([
    makeUser(admin, testApp, 'r020staff', ['staff']),
    makeUser(admin, testApp, 'r020manager', ['quality_manager']),
    makeUser(admin, testApp, 'r020dept', ['dept_manager']),
    makeUser(admin, testApp, 'r020nobody', []),
  ]);
  for (const session of others) {
    for (const response of [
      await session.fetch('/warehouses', get()),
      await session.fetch('/stock/balances', get()),
      await session.fetch('/stock/transactions', get()),
      await session.fetch('/stock-docs', get()),
      await session.fetch(`/stock-docs/${docId}`, get()),
      await session.fetch('/warehouses', write({ code: unique('X'), name: 'x' })),
      await session.fetch('/stock-docs', write({
        docType: 'in', reason: 'purchase_receipt',
        lines: [{ itemId, warehouseId, qty: 1 }],
      })),
      await session.fetch(`/stock-docs/${docId}`, write({ remark: 'x' }, 'PATCH')),
      await session.fetch(`/stock-docs/${docId}/post`, write()),
      await session.fetch(`/stock-docs/${docId}/void`, write()),
    ]) {
      expect(response.status, '这一片不该给别的角色').toBe(403);
    }
  }

  // 先授权后读内容：无授权者即使发一个明细为空的请求，也先得到 403。
  const nobody = others[3]!;
  const invalid = await nobody.fetch('/stock-docs', write({
    docType: 'in', reason: 'purchase_receipt', lines: [],
  }));
  expect(invalid.status).toBe(403);
  expect((await jsonOf(invalid)).error?.reason).not.toBe('STOCK_LINE_INVALID');
});


test('只持 receive / ship 的仓管：窄形状没有价格、备注、经办人、项目；订单列表与提交 403', async ({
  testApp, connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const item = await createItem(connection);
  const warehouse = await jsonOf(await admin.fetch('/warehouses', write({
    code: unique('NARROW-WH'), name: '窄形状测试仓',
  })));
  const supplier = await createPartner(admin, { isSupplier: true });
  const customer = await createPartner(admin, { isCustomer: true });
  const purchase = await createOrder(admin, 'purchase', {
    supplierId: supplier.id,
    lines: [{ itemId: item, qty: 10, price: 113, taxRate: 13, deliveryDate: '2026-12-01' }],
  });
  const sales = await createOrder(admin, 'sales', {
    customerId: customer.id,
    lines: [{ itemId: item, qty: 8, price: 226, taxRate: 13 }],
  });
  for (const [kind, id] of [['purchase', purchase.id], ['sales', sales.id]] as const) {
    expect((await admin.fetch(`/${kind}-orders/${String(id)}/submit`, write())).status).toBe(200);
  }
  const { session: keeper } = await makeRoleUser(
    admin, testApp, 'r020narrow', [
      { resource: { type: 'composite', id: 'purchaseOrders' }, actions: [{ action: 'receive' }] },
      { resource: { type: 'composite', id: 'salesOrders' }, actions: [{ action: 'ship' }] },
    ],
  );

  const forbiddenKeys = ['price', 'remark', 'handler', 'projectCode', 'discountAmount', 'payableTotal'];
  for (const [path, partnerKey] of [
    ['/purchase-orders/receivable', 'supplier'],
    ['/sales-orders/shippable', 'customer'],
  ] as const) {
    const response = await keeper.fetch(path, get());
    expect(response.status, `窄形状清单应可读：${await response.clone().text()}`).toBe(200);
    const body = await jsonOf(response);
    expect(body.items?.length).toBeGreaterThan(0);
    for (const row of body.items!) {
      for (const key of forbiddenKeys) expect(Object.keys(row)).not.toContain(key);
      expect(row[partnerKey]).toBeDefined();
      for (const line of (row.lines ?? []) as Row[]) {
        for (const key of forbiddenKeys) expect(Object.keys(line)).not.toContain(key);
        expect(Object.keys(line)).toContain('remainingQty');
      }
    }
  }

  for (const [method, path, init] of [
    ['GET', '/purchase-orders', get()],
    ['GET', '/sales-orders', get()],
    ['POST', `/purchase-orders/${String(purchase.id)}/submit`, write()],
    ['POST', `/sales-orders/${String(sales.id)}/submit`, write()],
  ] as const) {
    const denied = await keeper.fetch(path, init);
    expect(denied.status, `${method} ${path} 应当 403`).toBe(403);
  }

  const generated = await keeper.fetch(`/purchase-orders/${String(purchase.id)}/create-receipt`, write({
    warehouseId: warehouse.id,
  }));
  expect(generated.status, `仓管生成入库草稿失败：${await generated.clone().text()}`).toBe(201);
  const doc = await jsonOf(generated);
  expect(doc.partner).toMatchObject({ id: supplier.id, code: supplier.code });
  expect(doc.contactName ?? null).toBe(null);
  expect(doc.lines?.[0]).toMatchObject({ taxIncludedPrice: 113, taxRate: 13 });
}, 30_000);
