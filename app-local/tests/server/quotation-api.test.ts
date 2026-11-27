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
  createDictEntry,
  createEmployee,
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
 * R-022 复刻波 1 报价单端点：建草稿 → 确定 → 转销售订单；规则码；反向断言。
 * 全部在真 Postgres 上跑，写回结果一律从库里再读一遍。
 */
const test = createAppTest({
  createServer: createStandaloneServer,
  config: {
    app: { publicOrigin: 'http://localhost' },
    auth: { secret: 'test-auth-secret-at-least-32-characters' },
  },
});

const TIMEOUT = 30_000;
const PATH = '/quotations';
const PRICE_TABLE_KEYS = ['customerPriceList', 'priceLevel', 'discountRate', 'basePurchasePrice', 'baseSalesPrice'];

interface Fixtures {
  readonly seller: TestSession;
  readonly sellerId: string;
  readonly customer: Row;
  readonly warehouse: Row;
  readonly items: readonly string[];
  readonly projectCode: string;
  readonly settlementCode: string;
}

async function fixtures(testApp: Parameters<typeof signIn>[0], connection: Parameters<typeof createItem>[0]): Promise<Fixtures> {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const username = unique('r022quote');
  const password = 'R022-quote-123!';
  const created = await admin.fetch('/users', write({
    name: username, username, email: `${username.toLowerCase()}@example.test`,
    password, roleScopes: { app: ['sales'] },
  }));
  expect(created.status, `前置：建销售账号失败 ${await created.clone().text()}`).toBe(201);
  const sellerId = String((await jsonOf(created)).data?.id);
  expect(sellerId, '前置：销售账号 id').toBeTruthy();
  // 转单复用销售订单的建单校验：经办人要是在职员工。
  await createEmployee(connection, sellerId);
  const seller = await signIn(testApp, { username, password });
  const customer = await createPartner(admin, { isCustomer: true });
  const warehouse = await createWarehouse(admin);
  const items = [await createItem(connection), await createItem(connection)];
  const projectCode = unique('QPROJ');
  const settlementCode = unique('QSET');
  await createDictEntry(connection, 'project', projectCode);
  await createDictEntry(connection, 'settlement', settlementCode);
  return { seller, sellerId, customer, warehouse, items, projectCode, settlementCode };
}

const upload = (session: TestSession): Promise<Response> => {
  const form = new FormData();
  form.append('file', new File(['附件测试内容'], 'quote.pdf', { type: 'application/pdf' }));
  return session.fetch('/doc-files', {
    method: 'POST', headers: { origin: 'http://localhost' }, body: form,
  });
};

function twoLines(items: readonly string[]): Row[] {
  return [
    { itemId: items[0], qty: 5, price: 226, taxRate: 13, deliveryDate: '2026-12-02' },
    { itemId: items[1], qty: 5, price: 226, taxRate: 13, deliveryDate: '2026-12-06' },
  ];
}

test('正向：建草稿 → 确定 → 转一张草稿销售订单，行、合计与 quotationId 一致', async ({
  testApp, connection,
}) => {
  const { seller, sellerId, customer, warehouse, items, projectCode, settlementCode } =
    await fixtures(testApp, connection);
  const uploaded = await upload(seller);
  expect(uploaded.status, `上传附件失败：${await uploaded.clone().text()}`).toBe(201);
  const file = await jsonOf(uploaded);
  const created = await seller.fetch(PATH, write({
    fileIds: [String(file.id)],
    customerId: customer.id,
    quoteDate: '2026-11-27',
    validUntil: '2026-12-27',
    warehouseId: warehouse.id,
    contactName: '报价联系人',
    contactPhone: '000-0000',
    deliveryAddress: '报价交货地址',
    projectCode,
    settlementCode,
    customerOrderNo: 'Q-CUST-1',
    lines: twoLines(items),
  }));
  expect(created.status, `建报价单失败：${await created.clone().text()}`).toBe(201);
  const quote = await jsonOf(created);
  expect(String(quote.docNo), '单号走发号器 QT 前缀').toMatch(/^QT-\d{8}-\d{4,}$/u);
  expect(quote).toMatchObject({
    quoteDate: '2026-11-27', validUntil: '2026-12-27', status: 'draft', expired: false,
    customerOrderNo: 'Q-CUST-1',
    totalQty: 10, taxIncludedTotal: 2260, taxExcludedTotal: 2000, taxTotal: 260,
    discountAmount: 0, payableTotal: 2260,
    convertedOrderId: null,
  });
  expect(Object.keys(quote)).not.toContain('createdById');
  for (const key of PRICE_TABLE_KEYS) expect(Object.keys(quote)).not.toContain(key);
  expect(Object.keys(quote.customer as Row).sort()).toEqual(['code', 'id', 'name']);
  expect(Object.keys(quote.handler as Row).sort()).toEqual(['name', 'userId']);
  expect((quote.handler as Row).userId).toBe(sellerId);
  expect(quote.warehouse).toMatchObject({ id: warehouse.id });
  expect(quote.projectCode).toBe(projectCode);
  expect(quote.settlementCode).toBe(settlementCode);
  expect(quote.lines).toHaveLength(2);
  for (const line of quote.lines!) {
    expect(line).toMatchObject({
      taxExcludedPrice: 200, taxExcludedAmount: 1000, taxAmount: 130, taxIncludedAmount: 1130,
    });
    expect(Object.keys(line.item as Row).sort()).toEqual(['code', 'id', 'name', 'spec', 'unitCode']);
    for (const key of ['basePurchasePrice', 'baseSalesPrice']) {
      expect(Object.keys(line.item as Row)).not.toContain(key);
    }
  }
  expect(quote.files, '前置：详情必须真的带回刚绑定的附件').toHaveLength(1);
  expect(quote.files![0]).toEqual({
    id: file.id, name: 'quote.pdf', contentType: 'application/pdf', size: 18,
  });
  for (const attached of quote.files as Row[]) {
    expect(Object.keys(attached).sort()).toEqual(['contentType', 'id', 'name', 'size']);
    expect(Object.keys(attached)).not.toContain('storageKey');
    expect(Object.keys(attached)).not.toContain('createdById');
  }

  const id = String(quote.id);
  const confirmed = await seller.fetch(`${PATH}/${id}/confirm`, write());
  expect(confirmed.status, `确定失败：${await confirmed.clone().text()}`).toBe(200);
  expect((await jsonOf(confirmed)).status).toBe('confirmed');

  const converted = await seller.fetch(`${PATH}/${id}/create-sales-order`, write());
  expect(converted.status, `转销售订单失败：${await converted.clone().text()}`).toBe(200);
  const body = await jsonOf(converted);
  expect(String(body.salesOrderId)).toBeTruthy();
  expect((body.quotation as Row).status).toBe('converted');
  expect((body.quotation as Row).convertedOrderId).toBe(body.salesOrderId);

  const order = await jsonOf(await seller.fetch(`/sales-orders/${String(body.salesOrderId)}`, get()));
  expect(order).toMatchObject({
    status: 'draft', quotationId: id,
    warehouseId: warehouse.id, projectCode, settlementCode,
    customerOrderNo: 'Q-CUST-1', totalQty: 10,
    taxIncludedTotal: 2260, taxExcludedTotal: 2000, taxTotal: 260, payableTotal: 2260,
  });
  expect(order.customer).toMatchObject({ id: customer.id });
  expect(order.lines).toHaveLength(2);
  const lineOrders = order.lines!.map((line) => ({
    itemId: String(line.itemId), qty: Number(line.qty), price: Number(line.price),
    taxRate: Number(line.taxRate), deliveryDate: line.deliveryDate,
  })).sort((a, b) => String(a.itemId).localeCompare(String(b.itemId)));
  const lineQuotes = quote.lines!.map((line) => ({
    itemId: String(line.itemId), qty: Number(line.qty), price: Number(line.price),
    taxRate: Number(line.taxRate), deliveryDate: line.deliveryDate,
  })).sort((a, b) => String(a.itemId).localeCompare(String(b.itemId)));
  expect(lineOrders).toEqual(lineQuotes);
  const stored = await connection.repository<Row>('salesOrders').findOne({ filter: { id: String(body.salesOrderId) } });
  expect(stored?.quotationId).toBe(id);
  const storedQuote = await connection.repository<Row>('quotations').findOne({ filter: { id } });
  expect(storedQuote?.status).toBe('converted');
  expect(storedQuote?.convertedOrderId).toBe(String(body.salesOrderId));
}, TIMEOUT);

test('反向断言：未确定/已转都转不了；一张报价恰好一张订单；价格表键不出现；合计由服务端算', async ({
  testApp, connection,
}) => {
  const { seller, customer, warehouse, items } = await fixtures(testApp, connection);
  const base = {
    customerId: customer.id, quoteDate: '2026-11-27', validUntil: '2026-12-27',
    warehouseId: warehouse.id,
    // 六个合计的伪造值：服务端必须忽略并自己算。
    totalQty: 999, taxIncludedTotal: 1, taxExcludedTotal: 2, taxTotal: 3,
    discountAmount: 0, payableTotal: 4,
  };
  const created = await seller.fetch(PATH, write({
    ...base, lines: twoLines(items),
  }));
  expect(created.status, `建报价单失败：${await created.clone().text()}`).toBe(201);
  const quote = await jsonOf(created);
  expect(quote).toMatchObject({
    totalQty: 10, taxIncludedTotal: 2260, taxExcludedTotal: 2000, taxTotal: 260, payableTotal: 2260,
  });
  const id = String(quote.id);

  const tooEarly = await seller.fetch(`${PATH}/${id}/create-sales-order`, write());
  expect(tooEarly.status, '草稿不能转销售订单').toBe(422);
  expect((await jsonOf(tooEarly)).error?.reason).toBe('QUOTATION_NOT_CONFIRMED');
  expect(await connection.repository<Row>('salesOrders').count({
    filter: { quotationId: id },
  })).toBe(0);

  expect((await seller.fetch(`${PATH}/${id}/confirm`, write())).status).toBe(200);
  const first = await seller.fetch(`${PATH}/${id}/create-sales-order`, write());
  expect(first.status, `转单失败：${await first.clone().text()}`).toBe(200);
  const again = await seller.fetch(`${PATH}/${id}/create-sales-order`, write());
  expect(again.status, '已转的不能再转').toBe(422);
  expect((await jsonOf(again)).error?.reason).toBe('QUOTATION_CONVERTED');
  const count = await connection.repository<Row>('salesOrders').count({ filter: { quotationId: id } });
  expect(count, '一张报价转出的销售订单恰好一张').toBe(1);

  for (const response of [
    await seller.fetch(`${PATH}/${id}`, get()),
    await seller.fetch(PATH, get()),
  ]) {
    expect(response.status).toBe(200);
    const body = await jsonOf(response);
    for (const row of (body.items ?? [body]) as Row[]) {
      for (const key of [...PRICE_TABLE_KEYS, 'createdById']) expect(Object.keys(row)).not.toContain(key);
      expect(Object.keys(row)).not.toContain('customerPriceList');
    }
  }
  const list = await jsonOf(await seller.fetch(PATH, get()));
  expect(list.items?.every((row) => !('lines' in row))).toBe(true);
  expect(list.items?.some((row) => String(row.id) === id)).toBe(true);
}, TIMEOUT);

test('并发转单：同时两次只有一次成功，库里仍只有一张销售订单', async ({ testApp, connection }) => {
  const { seller, customer, warehouse, items } = await fixtures(testApp, connection);
  const created = await seller.fetch(PATH, write({
    customerId: customer.id, quoteDate: '2026-11-27',
    warehouseId: warehouse.id, lines: twoLines(items),
  }));
  expect(created.status).toBe(201);
  const id = String((await jsonOf(created)).id);
  expect((await seller.fetch(`${PATH}/${id}/confirm`, write())).status).toBe(200);
  const results = await Promise.all([
    seller.fetch(`${PATH}/${id}/create-sales-order`, write()),
    seller.fetch(`${PATH}/${id}/create-sales-order`, write()),
  ]);
  expect(results.map((response) => response.status).sort()).toEqual([200, 422]);
  expect(await connection.repository<Row>('salesOrders').count({ filter: { quotationId: id } })).toBe(1);
}, TIMEOUT);

test('拒绝路径：有效期、优惠、只给未税单价、空明细确定、非草稿改、作废后转单、没有删除', async ({
  testApp, connection,
}) => {
  const { seller, customer, warehouse, items } = await fixtures(testApp, connection);
  const base = { customerId: customer.id, quoteDate: '2026-11-27', warehouseId: warehouse.id };
  const reject = async (body: Row, reason: string, status = 422): Promise<void> => {
    const response = await seller.fetch(PATH, write({ ...base, lines: twoLines(items), ...body }));
    expect(response.status, `${reason}: ${await response.clone().text()}`).toBe(status);
    expect((await jsonOf(response)).error?.reason).toBe(reason);
  };
  await reject({ validUntil: '2026-11-26' }, 'QUOTATION_VALIDITY_INVALID');
  await reject({ lines: twoLines(items), discountAmount: 3000 }, 'QUOTATION_DISCOUNT_INVALID');
  await reject({ lines: [{ itemId: items[0], qty: 5, taxExcludedPrice: 100 }] }, 'QUOTATION_LINE_INVALID');

  const empty = await seller.fetch(PATH, write({ ...base, lines: [], docNo: 'X' }));
  expect(empty.status).toBe(201);
  const emptyId = String((await jsonOf(empty)).id);
  const confirmEmpty = await seller.fetch(`${PATH}/${emptyId}/confirm`, write());
  expect(confirmEmpty.status).toBe(422);
  expect((await jsonOf(confirmEmpty)).error?.reason).toBe('QUOTATION_EMPTY');

  const quote = await jsonOf(await seller.fetch(PATH, write({ ...base, lines: twoLines(items) })));
  const id = String(quote.id);
  const patched = await seller.fetch(`${PATH}/${id}`, write({ contactName: '草稿联系人' }, 'PATCH'));
  expect(patched.status).toBe(200);
  expect((await seller.fetch(`${PATH}/${id}/confirm`, write())).status).toBe(200);
  const notDraft = await seller.fetch(`${PATH}/${id}`, write({ contactName: '又改' }, 'PATCH'));
  expect(notDraft.status).toBe(422);
  expect((await jsonOf(notDraft)).error?.reason).toBe('QUOTATION_NOT_DRAFT');

  const voided = await seller.fetch(`${PATH}/${id}/void`, write());
  expect(voided.status, `作废失败：${await voided.clone().text()}`).toBe(200);
  expect((await jsonOf(voided)).status).toBe('void');
  const afterVoid = await seller.fetch(`${PATH}/${id}/create-sales-order`, write());
  expect(afterVoid.status).toBe(422);
  expect((await jsonOf(afterVoid)).error?.reason).toBe('QUOTATION_NOT_CONFIRMED');

  const removed = await seller.fetch(`${PATH}/${id}`, {
    method: 'DELETE', headers: { origin: 'http://localhost' },
  });
  expect([404, 405]).toContain(removed.status);
  const missing = await seller.fetch(`${PATH}/${unique('NO-QUOTE')}`, get());
  expect(missing.status).toBe(404);
  expect((await jsonOf(missing)).error?.reason).toBe('QUOTATION_NOT_FOUND');
}, TIMEOUT);

test('有效期已过不拦，只回 expired；列表按状态/客户/项目/有效期/q 过滤', async ({ testApp, connection }) => {
  const { seller, customer, warehouse, items } = await fixtures(testApp, connection);
  await createDictEntry(connection, 'project', 'Q-FILTER');
  const expired = await seller.fetch(PATH, write({
    customerId: customer.id, quoteDate: '2026-01-01', validUntil: '2026-01-02',
    warehouseId: warehouse.id, projectCode: 'Q-FILTER',
    customerOrderNo: 'Q-UNIQUE-42', lines: twoLines(items),
  }));
  expect(expired.status, `过期报价单应当可建：${await expired.clone().text()}`).toBe(201);
  const quote = await jsonOf(expired);
  expect(quote.expired).toBe(true);

  const list = await jsonOf(await seller.fetch(
    `${PATH}?status=draft&customerId=${String(customer.id)}&projectCode=Q-FILTER`
    + '&validFrom=2026-01-01&validTo=2026-01-02&q=Q-UNIQUE-42&page=1&pageSize=5', get(),
  ));
  expect(list.items?.map((row) => String(row.id))).toContain(String(quote.id));
  expect(list).toMatchObject({ page: 1, pageSize: 5 });
  const none = await jsonOf(await seller.fetch(`${PATH}?status=converted`, get()));
  expect(none.items?.some((row) => String(row.id) === String(quote.id))).toBe(false);
}, TIMEOUT);
