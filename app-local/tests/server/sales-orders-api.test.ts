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
  unique,
  write,
  type Row,
} from '../helpers/orders.js';
import { createStandaloneServer } from '../../server/standalone.js';

/**
 * R-022 端点：建单自动取号、草稿整单替换、提交/取消、生成出库单的部分与全量，
 * 以及规则码。每条断言都从真库读回写入结果。
 */
const test = createAppTest({
  createServer: createStandaloneServer,
  config: {
    app: { publicOrigin: 'http://localhost' },
    auth: { secret: 'test-auth-secret-at-least-32-characters' },
  },
});

const TIMEOUT = 30_000;
const PATH = '/sales-orders';

test('建单自动取号：SO 前缀、客户摘要、明细整单写入，服务端列不收', async ({
  testApp, connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const customer = await createPartner(admin, { isCustomer: true });
  const item = await createItem(connection);
  const response = await admin.fetch(PATH, write({
    customerId: customer.id,
    orderDate: '2026-11-26',
    remark: '首张销售单',
    orderNo: '伪造的号',
    status: 'shipped',
    lines: [{ itemId: item, qty: 8, price: 12, shippedQty: 999 }],
  }));
  expect(response.status, `建单失败：${await response.clone().text()}`).toBe(201);
  const order = await jsonOf(response);
  expect(String(order.orderNo)).toMatch(/^SO-\d{8}-\d{4,}$/u);
  expect(order).toMatchObject({
    customerId: customer.id, orderDate: '2026-11-26', status: 'draft',
    remark: '首张销售单', submittedAt: null,
  });
  expect(order.customer).toMatchObject({ id: customer.id, code: customer.code, name: customer.name });
  expect(Object.keys(order.customer ?? {})).not.toContain('email');
  expect(Object.keys(order)).not.toContain('createdById');
  expect(order.lines?.[0]).toMatchObject({
    itemId: item, qty: 8, price: 12, shippedQty: 0, remainingQty: 8,
  });
  const stored = await connection.repository<Row>('salesOrders').findOne({ filter: { id: order.id } });
  expect(stored?.orderNo).toBe(order.orderNo);
  expect(stored?.status).toBe('draft');
}, TIMEOUT);

test('草稿整单替换、提交写 submittedAt、取消与没有删除', async ({ testApp, connection }) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const itemA = await createItem(connection);
  const itemB = await createItem(connection);
  const order = await createOrder(admin, 'sales', { lines: [{ itemId: itemA, qty: 2 }] });
  const id = String(order.id);

  const patched = await admin.fetch(`${PATH}/${id}`, write({
    remark: '换掉明细',
    lines: [{ itemId: itemB, qty: 6, price: 9 }],
  }, 'PATCH'));
  expect(patched.status, `改草稿失败：${await patched.clone().text()}`).toBe(200);
  const body = await jsonOf(patched);
  expect(body.orderNo).toBe(order.orderNo);
  expect(body.lines?.[0]).toMatchObject({ itemId: itemB, qty: 6, remainingQty: 6 });
  expect(
    await connection.repository<Row>('salesOrderLines').findMany({ filter: { orderId: id } }),
  ).toHaveLength(1);

  const submitted = await admin.fetch(`${PATH}/${id}/submit`, write());
  expect(submitted.status).toBe(200);
  const submittedBody = await jsonOf(submitted);
  expect(submittedBody.status).toBe('ordered');
  expect(submittedBody.submittedAt).not.toBeNull();

  const refused = await admin.fetch(`${PATH}/${id}`, write({ remark: '还想改' }, 'PATCH'));
  expect(refused.status).toBe(422);
  expect((await jsonOf(refused)).error?.reason).toBe('ORDER_NOT_DRAFT');

  const cancelled = await admin.fetch(`${PATH}/${id}/cancel`, write());
  expect(cancelled.status, `取消失败：${await cancelled.clone().text()}`).toBe(200);
  expect((await jsonOf(cancelled)).status).toBe('cancelled');
  const removed = await admin.fetch(`${PATH}/${id}`, { method: 'DELETE', headers: { origin: 'http://localhost' } });
  expect([404, 405]).toContain(removed.status);
}, TIMEOUT);

test('规则码：往来单位与物料校验、重复物料、空明细、空 PATCH、不存在的订单', async ({
  testApp, connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const item = await createItem(connection);
  const inactiveItem = await createItem(connection, 'inactive');
  const supplier = await createPartner(admin, { isSupplier: true });
  const customer = await createPartner(admin, { isCustomer: true });
  const inactiveCustomer = await createPartner(admin, { isCustomer: true });
  expect((await admin.fetch(`/partners/${String(inactiveCustomer.id)}`, write(
    { status: 'inactive' }, 'PATCH',
  ))).status).toBe(200);

  const reject = async (body: unknown, reason: string, status = 422): Promise<void> => {
    const response = await admin.fetch(PATH, write(body));
    expect(response.status, `${reason}: ${await response.clone().text()}`).toBe(status);
    expect((await jsonOf(response)).error?.reason).toBe(reason);
  };
  const base = (customerId: unknown, lines: unknown) => ({
    customerId, orderDate: '2026-11-27', lines,
  });
  await reject(base(unique('NO-CUSTOMER'), [{ itemId: item, qty: 1 }]), 'PARTNER_NOT_FOUND', 404);
  await reject(base(supplier.id, [{ itemId: item, qty: 1 }]), 'PARTNER_NOT_CUSTOMER');
  await reject(base(inactiveCustomer.id, [{ itemId: item, qty: 1 }]), 'PARTNER_INACTIVE');
  await reject(base(customer.id, []), 'ORDER_LINE_INVALID');
  await reject(base(customer.id, [{ itemId: item, qty: -1 }]), 'ORDER_LINE_INVALID');
  await reject(base(customer.id, [{ itemId: item, qty: 1 }, { itemId: item, qty: 2 }]), 'ORDER_LINE_DUPLICATED');
  await reject(base(customer.id, [{ itemId: unique('NO-ITEM'), qty: 1 }]), 'ITEM_NOT_FOUND', 404);
  await reject(base(customer.id, [{ itemId: inactiveItem, qty: 1 }]), 'ITEM_INACTIVE');

  const order = await createOrder(admin, 'sales', { lines: [{ itemId: item, qty: 1 }] });
  const empty = await admin.fetch(`${PATH}/${String(order.id)}`, write({}, 'PATCH'));
  expect(empty.status).toBe(422);
  expect((await jsonOf(empty)).error?.reason).toBe('ORDER_EMPTY_PATCH');
  const missing = await admin.fetch(`${PATH}/${unique('NO-ORDER')}`, get());
  expect(missing.status).toBe(404);
  expect((await jsonOf(missing)).error?.reason).toBe('ORDER_NOT_FOUND');
}, TIMEOUT);

test('列表过滤与详情形状：列表不带明细与客户，详情带', async ({ testApp, connection }) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const item = await createItem(connection);
  const customer = await createPartner(admin, { isCustomer: true });
  const order = await createOrder(admin, 'sales', {
    customerId: customer.id, lines: [{ itemId: item, qty: 3 }],
  });
  const list = await jsonOf(await admin.fetch(
    `${PATH}?status=draft&customerId=${String(customer.id)}&q=订单测试&page=1&pageSize=5`
    + `&from=2020-01-01T00:00:00Z&to=2099-01-01T00:00:00Z`, get(),
  ));
  expect(list.items?.map((row) => String(row.id))).toContain(String(order.id));
  expect(list).toMatchObject({ page: 1, pageSize: 5 });
  expect(list.items?.some((row) => 'lines' in row || 'customer' in row)).toBe(false);
  const detail = await jsonOf(await admin.fetch(`${PATH}/${String(order.id)}`, get()));
  expect(detail.lines).toHaveLength(1);
  expect(detail.customer).toMatchObject({ id: customer.id });
}, TIMEOUT);

test('生成出库单：默认全量、指定行/部分行、超额与重复生成被拒，取消被单据挡住', async ({
  testApp, connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const itemA = await createItem(connection);
  const itemB = await createItem(connection);
  const warehouse = await createWarehouse(admin);
  const draft = await createOrder(admin, 'sales', {
    lines: [{ itemId: itemA, qty: 10 }, { itemId: itemB, qty: 5 }],
  });
  const beforeSubmit = await admin.fetch(`${PATH}/${String(draft.id)}/create-issue`, write({
    warehouseId: warehouse.id,
  }));
  expect(beforeSubmit.status).toBe(422);
  expect((await jsonOf(beforeSubmit)).error?.reason).toBe('ORDER_NOT_ISSUABLE');

  const order = await createOrder(admin, 'sales', {
    lines: [{ itemId: itemA, qty: 10 }, { itemId: itemB, qty: 5 }],
  });
  const id = String(order.id);
  expect((await admin.fetch(`${PATH}/${id}/submit`, write())).status).toBe(200);
  const orderLines = (await jsonOf(await admin.fetch(`${PATH}/${id}`, get()))).lines!;
  const lineA = orderLines.find((line) => line.itemId === itemA)!;
  expect(lineA, '测试前置：应当找得到 itemA 对应的订单行').toBeDefined();

  const partial = await admin.fetch(`${PATH}/${id}/create-issue`, write({
    warehouseId: warehouse.id,
    lines: [{ lineId: lineA.id, qty: 4 }],
  }));
  expect(partial.status, `生成出库单失败：${await partial.clone().text()}`).toBe(201);
  const doc = await jsonOf(partial);
  expect(doc).toMatchObject({
    docType: 'out',
    reason: 'sales_issue',
    status: 'draft',
    sourceType: 'sales_order',
    sourceId: id,
  });
  expect(doc.lines?.[0]).toMatchObject({
    itemId: itemA, warehouseId: warehouse.id, qty: 4, batchNo: '',
  });
  const afterPartial = await jsonOf(await admin.fetch(`${PATH}/${id}`, get()));
  expect(afterPartial.lines?.find((line) => line.itemId === itemA)).toMatchObject({
    shippedQty: 0, remainingQty: 6,
  });

  const tooMuch = await admin.fetch(`${PATH}/${id}/create-issue`, write({
    warehouseId: warehouse.id,
    lines: [{ lineId: lineA.id, qty: 7 }],
  }));
  expect(tooMuch.status).toBe(422);
  expect((await jsonOf(tooMuch)).error?.reason).toBe('ORDER_QTY_EXCEEDS_REMAINING');
  const cancel = await admin.fetch(`${PATH}/${id}/cancel`, write());
  expect(cancel.status).toBe(422);
  expect((await jsonOf(cancel)).error?.reason).toBe('ORDER_NOT_CANCELLABLE');

  const rest = await admin.fetch(`${PATH}/${id}/create-issue`, write({ warehouseId: warehouse.id }));
  expect(rest.status, `按剩余全量生成失败：${await rest.clone().text()}`).toBe(201);
  const restDoc = await jsonOf(rest);
  expect(restDoc.lines?.map((line) => Number(line.qty)).sort()).toEqual([5, 6]);
  const afterAll = await jsonOf(await admin.fetch(`${PATH}/${id}`, get()));
  expect(afterAll.lines?.every((line) => Number(line.remainingQty) === 0)).toBe(true);
  const again = await admin.fetch(`${PATH}/${id}/create-issue`, write({ warehouseId: warehouse.id }));
  expect(again.status).toBe(422);
  expect((await jsonOf(again)).error?.reason).toBe('ORDER_LINES_ALREADY_ISSUED');
  expect(
    await connection.repository<Row>('stockDocs').findMany({
      filter: { sourceType: 'sales_order', sourceId: id },
    }),
  ).toHaveLength(2);
}, TIMEOUT);
