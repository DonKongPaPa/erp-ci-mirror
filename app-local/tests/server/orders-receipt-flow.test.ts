// @vitest-environment node
import {
  DEFAULT_ADMIN_CREDENTIALS,
  signIn,
} from '@nocobase/app-plugin-authentication/testing';
import { expect } from 'vitest';

import { createAppTest } from '../helpers/test-app.js';
import { createItem } from '../helpers/inventory.js';
import {
  createOrder,
  createPartner,
  createWarehouse,
  get,
  jsonOf,
  write,
  type Row,
} from '../helpers/orders.js';
import { createStandaloneServer } from '../../server/standalone.js';
import { stockMutationsToken } from '../../server/providers/inventory.js';

/**
 * R-021/R-022 的闭环：订单生成草稿库存单据 → 用 R-020 的过账服务在同一个事务里过账
 * → 订单行的 receivedQty / shippedQty 与订单状态由 order-progress 回写。
 */
const test = createAppTest({
  createServer: createStandaloneServer,
  config: {
    app: { publicOrigin: 'http://localhost' },
    auth: { secret: 'test-auth-secret-at-least-32-characters' },
  },
});

const TIMEOUT = 30_000;

test('采购：部分入库过账回写 partially_received，全部入库过账回写 received', async ({
  testApp, app, connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const itemA = await createItem(connection);
  const itemB = await createItem(connection);
  const warehouse = await createWarehouse(admin);
  const order = await createOrder(admin, 'purchase', {
    lines: [{ itemId: itemA, qty: 10 }, { itemId: itemB, qty: 5 }],
  });
  const id = String(order.id);
  expect((await admin.fetch(`/purchase-orders/${id}/submit`, write())).status).toBe(200);
  const lines = (await jsonOf(await admin.fetch(`/purchase-orders/${id}`, get()))).lines!;
  const lineA = lines.find((line) => line.itemId === itemA)!;
  expect(lineA, '测试前置：应当找得到 itemA 对应的订单行').toBeDefined();
  const mutations = app.container.resolve(stockMutationsToken);

  const first = await admin.fetch(`/purchase-orders/${id}/create-receipt`, write({
    warehouseId: warehouse.id,
    lines: [{ lineId: lineA.id, qty: 4 }],
  }));
  expect(first.status, `生成入库单失败：${await first.clone().text()}`).toBe(201);
  const doc = await jsonOf(first);
  expect(doc.status).toBe('draft');
  await mutations.post(String(doc.id), 'flow-test');

  const partial = await jsonOf(await admin.fetch(`/purchase-orders/${id}`, get()));
  expect(partial.status).toBe('partially_received');
  const progress = (body: typeof partial, field: 'receivedQty' | 'remainingQty', itemId: string) =>
    Number(body.lines?.find((line) => line.itemId === itemId)?.[field]);
  expect(progress(partial, 'receivedQty', itemA)).toBe(4);
  expect(progress(partial, 'receivedQty', itemB)).toBe(0);
  expect(progress(partial, 'remainingQty', itemA)).toBe(6);
  expect(progress(partial, 'remainingQty', itemB)).toBe(5);
  const stored = await connection.repository<Row>('purchaseOrderLines').findMany({
    filter: { orderId: id },
  });
  expect(stored.find((line) => line.itemId === itemA)?.receivedQty).toBeDefined();
  expect(Number(stored.find((line) => line.itemId === itemA)?.receivedQty)).toBe(4);
  expect(Number(stored.find((line) => line.itemId === itemB)?.receivedQty)).toBe(0);

  const rest = await admin.fetch(`/purchase-orders/${id}/create-receipt`, write({
    warehouseId: warehouse.id,
  }));
  expect(rest.status, `生成剩余入库单失败：${await rest.clone().text()}`).toBe(201);
  await mutations.post(String((await jsonOf(rest)).id), 'flow-test');

  const done = await jsonOf(await admin.fetch(`/purchase-orders/${id}`, get()));
  expect(done.status).toBe('received');
  // 列表行与详情必须给出同一个状态值：列表状态列靠它显示「已到货」。
  const listed = await jsonOf(
    await admin.fetch('/purchase-orders?page=1&pageSize=20', get()),
  );
  expect(
    listed.items?.find((row) => row.id === id)?.status,
    '列表行应带出已到货状态',
  ).toBe('received');
  expect(progress(done, 'receivedQty', itemA)).toBe(10);
  expect(progress(done, 'receivedQty', itemB)).toBe(5);
  expect(progress(done, 'remainingQty', itemA)).toBe(0);
  expect(progress(done, 'remainingQty', itemB)).toBe(0);
}, TIMEOUT);

test('销售：先备货，部分出库过账回写 partially_shipped，全部出库过账回写 shipped', async ({
  testApp, app, connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const itemA = await createItem(connection);
  const itemB = await createItem(connection);
  const warehouse = await createWarehouse(admin);
  const mutations = app.container.resolve(stockMutationsToken);
  const stock = await admin.fetch('/stock-docs', write({
    docType: 'in',
    reason: 'other_in',
    lines: [
      { itemId: itemA, warehouseId: warehouse.id, qty: 100 },
      { itemId: itemB, warehouseId: warehouse.id, qty: 100 },
    ],
  }));
  expect(stock.status).toBe(201);
  await mutations.post(String((await jsonOf(stock)).id), 'flow-test');

  const order = await createOrder(admin, 'sales', {
    lines: [{ itemId: itemA, qty: 10 }, { itemId: itemB, qty: 5 }],
  });
  const id = String(order.id);
  expect((await admin.fetch(`/sales-orders/${id}/submit`, write())).status).toBe(200);
  const lines = (await jsonOf(await admin.fetch(`/sales-orders/${id}`, get()))).lines!;
  const lineA = lines.find((line) => line.itemId === itemA)!;
  expect(lineA, '测试前置：应当找得到 itemA 对应的订单行').toBeDefined();

  const first = await admin.fetch(`/sales-orders/${id}/create-issue`, write({
    warehouseId: warehouse.id,
    lines: [{ lineId: lineA.id, qty: 4 }],
  }));
  expect(first.status, `生成出库单失败：${await first.clone().text()}`).toBe(201);
  const doc = await jsonOf(first);
  expect(doc).toMatchObject({ docType: 'out', reason: 'sales_issue', status: 'draft' });
  await mutations.post(String(doc.id), 'flow-test');

  const partial = await jsonOf(await admin.fetch(`/sales-orders/${id}`, get()));
  expect(partial.status).toBe('partially_shipped');
  const progress = (body: typeof partial, field: 'shippedQty' | 'remainingQty', itemId: string) =>
    Number(body.lines?.find((line) => line.itemId === itemId)?.[field]);
  expect(progress(partial, 'shippedQty', itemA)).toBe(4);
  expect(progress(partial, 'shippedQty', itemB)).toBe(0);
  expect(progress(partial, 'remainingQty', itemA)).toBe(6);
  expect(progress(partial, 'remainingQty', itemB)).toBe(5);

  const rest = await admin.fetch(`/sales-orders/${id}/create-issue`, write({
    warehouseId: warehouse.id,
  }));
  expect(rest.status, `生成剩余出库单失败：${await rest.clone().text()}`).toBe(201);
  await mutations.post(String((await jsonOf(rest)).id), 'flow-test');

  const done = await jsonOf(await admin.fetch(`/sales-orders/${id}`, get()));
  expect(done.status).toBe('shipped');
  // 列表行与详情必须给出同一个状态值：列表状态列靠它显示「已发货」。
  const listed = await jsonOf(
    await admin.fetch('/sales-orders?page=1&pageSize=20', get()),
  );
  expect(
    listed.items?.find((row) => row.id === id)?.status,
    '列表行应带出已发货状态',
  ).toBe('shipped');
  expect(progress(done, 'shippedQty', itemA)).toBe(10);
  expect(progress(done, 'shippedQty', itemB)).toBe(5);
  expect(progress(done, 'remainingQty', itemA)).toBe(0);
  expect(progress(done, 'remainingQty', itemB)).toBe(0);
  const stored = await connection.repository<Row>('salesOrderLines').findMany({
    filter: { orderId: id },
  });
  expect(Number(stored.find((line) => line.itemId === itemA)?.shippedQty)).toBe(10);
  expect(Number(stored.find((line) => line.itemId === itemB)?.shippedQty)).toBe(5);
}, TIMEOUT);


test('加片风险：带来源按订单生成的草稿带价格，过账照旧回写；来源物料或数量不合法建不了', async ({
  testApp, app, connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const item = await createItem(connection);
  const outsideItem = await createItem(connection);
  const warehouse = await createWarehouse(admin);
  const supplier = await createPartner(admin, { isSupplier: true });
  const order = await createOrder(admin, 'purchase', {
    supplierId: supplier.id,
    lines: [{ itemId: item, qty: 10, price: 113, taxRate: 13, deliveryDate: '2026-12-01' }],
  });
  expect((await admin.fetch(`/purchase-orders/${String(order.id)}/submit`, write())).status).toBe(200);

  // 来源合法但物料不在订单里 / 超量：建草稿就被 R2 拦住。
  for (const [line, reason] of [
    [{ itemId: outsideItem, warehouseId: warehouse.id, qty: 1 }, 'STOCK_SOURCE_LINE_INVALID'],
    [{ itemId: item, warehouseId: warehouse.id, qty: 11 }, 'STOCK_SOURCE_QTY_EXCEEDS'],
  ] as const) {
    const refused = await admin.fetch('/stock-docs', write({
      docType: 'in', reason: 'purchase_receipt',
      sourceType: 'purchase_order', sourceId: String(order.id), lines: [line],
    }));
    expect(refused.status, `${reason}: ${await refused.clone().text()}`).toBe(422);
    expect((await jsonOf(refused)).error?.reason).toBe(reason);
  }

  const generated = await jsonOf(await admin.fetch(
    `/purchase-orders/${String(order.id)}/create-receipt`,
    write({ warehouseId: warehouse.id }),
  ));
  expect(generated.partner).toMatchObject({ id: supplier.id });
  expect(generated.lines?.[0]).toMatchObject({ taxIncludedPrice: 113, taxRate: 13 });
  expect(String(generated.docDate)).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
  const mutations = app.container.resolve(stockMutationsToken);
  expect((await mutations.post(String(generated.id), 'receipt-flow-test')).status).toBe('posted');
  const after = await jsonOf(await admin.fetch(`/purchase-orders/${String(order.id)}`, get()));
  expect(after.lines?.[0]?.receivedQty).toBe(10);
  expect(after.status).toBe('received');
}, TIMEOUT);
