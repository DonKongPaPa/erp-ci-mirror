// @vitest-environment node
import {
  DEFAULT_ADMIN_CREDENTIALS,
  signIn,
  type TestSession,
} from '@nocobase/app-plugin-authentication/testing';
import { authorizationToken } from '@nocobase/app-plugin-authorization';
import { expect } from 'vitest';

import { createAppTest } from '../helpers/test-app.js';
import { createItem } from '../helpers/inventory.js';
import {
  createOrder,
  createPartner,
  get,
  jsonOf,
  write,
} from '../helpers/orders.js';
import { createStandaloneServer } from '../../server/standalone.js';

/**
 * R-020 波 2 加片二的授权反向断言：采购 / 销售只发起、仓库只过账并用 postView 窄读待过账单、
 * 财务只读销售退货。先授权后读内容：无授权的人发内容非法的请求仍先得 403。
 */
const test = createAppTest({
  createServer: createStandaloneServer,
  config: {
    app: { publicOrigin: 'http://localhost' },
    auth: { secret: 'test-auth-secret-at-least-32-characters' },
  },
});

const PASSWORD = 'R020-returns-authz-123!';

async function userWithRole(
  admin: TestSession,
  testApp: Parameters<typeof signIn>[0],
  name: string,
  role: string,
): Promise<TestSession> {
  const username = `r020${name}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  const created = await admin.fetch('/users', write({
    name: username,
    username,
    email: `${username.toLowerCase()}@example.test`,
    password: PASSWORD,
    roleScopes: { app: role === '' ? [] : [role] },
  }));
  expect(created.status, `建 ${role || '无角色'} 用户失败：${await created.clone().text()}`).toBe(201);
  return await signIn(testApp, { username, password: PASSWORD });
}

interface Sources {
  purchaseDocId: string;
  salesDocId: string;
  purchaseLineId: string;
  salesLineId: string;
}

async function sources(
  admin: TestSession,
  itemId: string,
  warehouseId: string,
): Promise<Sources> {
  const supplier = await createPartner(admin, { isSupplier: true });
  const customer = await createPartner(admin, { isCustomer: true });
  // 采购入库 20、销售出库 10，留 10 现存量供仓管过账采购退货。
  const purchase = await createOrder(admin, 'purchase', {
    supplierId: supplier.id, lines: [{ itemId, qty: 20 }],
  });
  const sales = await createOrder(admin, 'sales', {
    customerId: customer.id, lines: [{ itemId, qty: 10 }],
  });
  const result: Partial<Sources> = {};
  for (const [kind, order] of [['purchase', purchase], ['sales', sales]] as const) {
    const orderId = String(order.id);
    expect((await admin.fetch(`/${kind}-orders/${orderId}/submit`, write())).status).toBe(200);
    const generated = await admin.fetch(`/${kind}-orders/${orderId}/${kind === 'purchase' ? 'create-receipt' : 'create-issue'}`, write({ warehouseId }));
    expect(generated.status).toBe(201);
    const doc = await jsonOf(generated);
    const docId = String(doc.id);
    expect((await admin.fetch(`/stock-docs/${docId}/post`, write())).status).toBe(200);
    const detail = await jsonOf(await admin.fetch(`/stock-docs/${docId}`, get()));
    const lineId = String(((detail.lines ?? []) as Record<string, unknown>[])[0]?.id);
    if (kind === 'purchase') {
      result.purchaseDocId = docId;
      result.purchaseLineId = lineId;
    } else {
      result.salesDocId = docId;
      result.salesLineId = lineId;
    }
  }
  return result as Sources;
}

test('采购只发起采购退货、销售只发起销售退货；过账只有仓管', async ({
  testApp, connection, app,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const buyer = await userWithRole(admin, testApp, 'buyer', 'purchase');
  const seller = await userWithRole(admin, testApp, 'seller', 'sales');
  const keeper = await userWithRole(admin, testApp, 'keeper', 'warehouse');
  const finance = await userWithRole(admin, testApp, 'finance', 'finance');
  const warehouseId = String((await jsonOf(await admin.fetch('/warehouses', write({
    name: '授权退货仓', code: `R020A${Date.now().toString(36).toUpperCase()}`,
  })))).id);
  const item = await createItem(connection);
  const src = await sources(admin, item, warehouseId);
  const purchaseBody = { sourceType: 'stock_doc', sourceId: src.purchaseDocId, lines: [{ sourceLineId: src.purchaseLineId, returnQty: 1 }] };
  const salesBody = { sourceType: 'stock_doc', sourceId: src.salesDocId, lines: [{ sourceLineId: src.salesLineId, returnQty: 1 }] };

  const purchaseCreated = await buyer.fetch('/purchase-returns', write(purchaseBody));
  expect(purchaseCreated.status, `采购发起退货失败：${await purchaseCreated.clone().text()}`).toBe(201);
  const purchaseReturnId = String((await jsonOf(purchaseCreated)).id);
  const salesCreated = await seller.fetch('/sales-returns', write(salesBody));
  expect(salesCreated.status, `销售发起退货失败：${await salesCreated.clone().text()}`).toBe(201);
  const salesReturnId = String((await jsonOf(salesCreated)).id);

  for (const [session, path, body] of [
    [buyer, '/sales-returns', salesBody],
    [seller, '/purchase-returns', purchaseBody],
    [keeper, '/purchase-returns', purchaseBody],
    [keeper, '/sales-returns', salesBody],
  ] as const) {
    const denied = await session.fetch(path, write(body));
    expect(denied.status, `${path} 不该给这个角色`).toBe(403);
  }
  for (const [session, path, id] of [
    [buyer, '/purchase-returns', purchaseReturnId],
    [seller, '/sales-returns', salesReturnId],
  ] as const) {
    expect((await session.fetch(path, get())).status).toBe(200);
    expect((await session.fetch(`${path}/${id}`, get())).status).toBe(200);
    expect((await session.fetch(`${path}/${id}`, write({ remark: '改' }, 'PATCH'))).status).toBe(200);
  }
  for (const [path, id] of [
    ['/purchase-returns', purchaseReturnId], ['/sales-returns', salesReturnId],
  ] as const) {
    for (const session of [buyer, seller]) {
      const denied = await session.fetch(`${path}/${id}/post`, write());
      expect(denied.status, `${path}/post 不该给发起角色`).toBe(403);
    }
  }
  // 仓管靠 postView 列草稿、读详情；响应里没有价格类键，也不回 createdById / storageKey。
  for (const path of ['/purchase-returns', '/sales-returns'] as const) {
    const listed = await keeper.fetch(`${path}?status=draft`, get());
    expect(listed.status, `${path} 待过账列表应可读：${await listed.clone().text()}`).toBe(200);
    const rows = ((await jsonOf(listed)).items ?? []) as Record<string, unknown>[];
    expect(rows.length).toBeGreaterThan(0);
    for (const key of ['price', 'taxIncludedPrice', 'taxExcludedPrice', 'createdById', 'storageKey']) {
      for (const row of rows) expect(Object.keys(row)).not.toContain(key);
    }
  }
  for (const [path, id] of [
    ['/purchase-returns', purchaseReturnId], ['/sales-returns', salesReturnId],
  ] as const) {
    const detailResponse = await keeper.fetch(`${path}/${id}`, get());
    expect(detailResponse.status, `${path}/${id} 应可读`).toBe(200);
    const detail = await jsonOf(detailResponse);
    for (const key of ['price', 'taxIncludedPrice', 'taxExcludedPrice', 'storageKey']) {
      expect(Object.keys(detail)).not.toContain(key);
    }
  }
  // 写动作仍只认各自动作：仓管建、改、作废都是 403。
  expect((await keeper.fetch('/purchase-returns', write(purchaseBody))).status).toBe(403);
  expect((await keeper.fetch(`/sales-returns/${salesReturnId}`, write({ remark: '改' }, 'PATCH'))).status).toBe(403);
  expect((await keeper.fetch(`/purchase-returns/${purchaseReturnId}/void`, write())).status).toBe(403);
  for (const [path, id] of [
    ['/purchase-returns', purchaseReturnId], ['/sales-returns', salesReturnId],
  ] as const) {
    expect((await keeper.fetch(`${path}/${id}/post`, write())).status).toBe(200);
  }
  // postView 只给仓管：采购与销售走 view，不拿 postView。
  const sets = await app.container.resolve(authorizationToken).permissionSets.list();
  const actionsOf = (key: string, resource: string): string[] =>
    (sets.find((set) => set.key === key)?.grants as { resource: { id: string }; actions: { action: string }[] }[])
      .filter((grant) => grant.resource.id === resource)
      .flatMap((grant) => grant.actions.map((action) => action.action));
  for (const [key, resource] of [
    ['purchase', 'purchaseReturns'], ['sales', 'salesReturns'],
  ] as const) {
    expect(actionsOf(key, resource)).not.toContain('postView');
  }
  for (const resource of ['purchaseReturns', 'salesReturns']) {
    expect(actionsOf('warehouse', resource)).toContain('postView');
  }
  // 财务只有销售退货的窄读，详情与采购退货都 403。
  expect((await finance.fetch(`/sales-returns/${salesReturnId}`, get())).status).toBe(403);
  expect((await finance.fetch('/purchase-returns/finance-options', get())).status).toBe(403);
  const narrow = await finance.fetch('/sales-returns/finance-options', get());
  expect(narrow.status).toBe(200);
  const narrowBody = await jsonOf(narrow);
  for (const row of (narrowBody.items ?? []) as Record<string, unknown>[]) {
    for (const key of ['remark', 'price', 'handler', 'createdById', 'storageKey']) {
      expect(Object.keys(row)).not.toContain(key);
    }
  }
}, 60_000);

test('别的角色全 403；无授权者发非法内容先 403，不读内容', async ({ testApp, connection }) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const staff = await userWithRole(admin, testApp, 'staff', 'staff');
  const quality = await userWithRole(admin, testApp, 'quality', 'quality_manager');
  const nobody = await userWithRole(admin, testApp, 'nobody', '');
  const warehouseId = String((await jsonOf(await admin.fetch('/warehouses', write({
    name: '旁人仓', code: `R020B${Date.now().toString(36).toUpperCase()}`,
  })))).id);
  const item = await createItem(connection);
  const src = await sources(admin, item, warehouseId);
  const body = { sourceType: 'stock_doc', sourceId: src.purchaseDocId, lines: [{ sourceLineId: src.purchaseLineId, returnQty: 1 }] };
  for (const session of [staff, quality, nobody]) {
    for (const response of [
      await session.fetch('/purchase-returns', get()),
      await session.fetch('/sales-returns', get()),
      await session.fetch('/purchase-returns', write(body)),
      await session.fetch('/sales-returns', write(body)),
      await session.fetch('/purchase-returns/source-options', get()),
      await session.fetch('/sales-returns/finance-options', get()),
    ]) {
      expect(response.status, '别的角色不该进退货端点').toBe(403);
    }
  }
  const invalid = await nobody.fetch('/purchase-returns', write({
    sourceType: 'stock_doc', sourceId: 'not-a-real-id', lines: [],
  }));
  expect(invalid.status).toBe(403);
  expect((await jsonOf(invalid)).error?.reason).not.toBe('RETURN_SOURCE_INVALID');
  const absent = await nobody.fetch('/purchase-returns/does-not-exist', get());
  expect(absent.status).toBe(403);
}, 60_000);
