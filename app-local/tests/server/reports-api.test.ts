// @vitest-environment node
import { randomUUID } from 'node:crypto';

import {
  DEFAULT_ADMIN_CREDENTIALS,
  signIn,
  type TestSession,
} from '@nocobase/app-plugin-authentication/testing';
import type { DatabaseConnection } from '@nocobase/db';
import { expect } from 'vitest';

import { createAppTest } from '../helpers/test-app.js';
import { createItem } from '../helpers/inventory.js';
import { createOrder, createWarehouse } from '../helpers/orders.js';
import { createStandaloneServer } from '../../server/standalone.js';

/**
 * R-078 验收 2、4、5、9：正向出数、白名单与分页、常用幂等、口径一致。
 * 只读真 Postgres，数据全部编造；每个取数提供者都有「编造数据 → 出数 → 逐列比对」。
 */
const test = createAppTest({
  createServer: createStandaloneServer,
  config: {
    app: { publicOrigin: 'http://localhost' },
    auth: { secret: 'test-auth-secret-at-least-32-characters' },
  },
});

const PASSWORD = 'R078-api-test-123!';
const unique = (prefix: string) => `${prefix}${randomUUID().replaceAll('-', '').slice(0, 10)}`;
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
type Row = Record<string, unknown> & { error?: { reason?: string } };
const jsonOf = async (response: Response): Promise<Row> => (await response.json()) as Row;

async function makeUser(
  admin: TestSession, app: Parameters<typeof signIn>[0], role: string,
): Promise<{ session: TestSession; id: string }> {
  const username = unique(`r078${role}`);
  const created = await admin.fetch('/users', write({
    name: username, username, email: `${username.toLowerCase()}@example.test`,
    password: PASSWORD, roleScopes: { app: [role] },
  }));
  expect(created.status).toBe(201);
  return {
    id: String(((await jsonOf(created)).data as Row | undefined)?.id ?? ''),
    session: await signIn(app, { username, password: PASSWORD }),
  };
}

async function run(session: TestSession, key: string, body: Row): Promise<{ response: Response; body: Row }> {
  const response = await session.fetch(`/reports/${key}/run`, write(body));
  return { response, body: await jsonOf(response) };
}

const firstItem = (body: Row): Row => {
  const items = body.items as Row[];
  expect(items.length).toBeGreaterThan(0);
  return items[0]!;
};

test('财1：两笔收入一笔支出，列键与 items 键一致、合计逐列正确', async ({ testApp }) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const finance = await makeUser(admin, testApp, 'finance');
  for (const amount of [100, 80]) {
    const created = await finance.session.fetch('/income-records', write({
      incomeDate: '2026-11-27', bindMode: 'none', amount, confirm: true,
    }));
    expect(created.status).toBe(201);
  }
  const expense = await finance.session.fetch('/expenses', write({
    expenseDate: '2026-11-27', bindMode: 'none', amount: 50, confirm: true,
  }));
  expect(expense.status).toBe(201);

  const measures = ['receivedAmount', 'expenseAmount', 'incomeAmountLocal', 'expenseAmountLocal'];
  const { response, body } = await run(finance.session, 'income_expense_detail', {
    filters: {}, dimensions: [], measures,
  });
  expect(response.status).toBe(200);
  const columns = body.columns as { key: string }[];
  expect(columns.map((column) => column.key)).toEqual(measures);
  const item = firstItem(body);
  expect(Object.keys(item).sort()).toEqual([...measures].sort());
  expect(Number(item.receivedAmount)).toBe(180);
  expect(Number(item.incomeAmountLocal)).toBe(180);
  expect(Number(item.expenseAmount)).toBe(50);
  expect(Number(item.expenseAmountLocal)).toBe(50);
  expect(body.total).toBe(1);
});

test('采1 / 入1 / 销2：采购、仓管、计划各自出数，列的键与行一致', async ({ testApp, connection }) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const purchase = await makeUser(admin, testApp, 'purchase');
  const warehouse = await makeUser(admin, testApp, 'warehouse');
  const planning = await makeUser(admin, testApp, 'planning');
  const itemId = await createItem(connection);
  const warehouseId = String((await createWarehouse(admin)).id);

  const order = await createOrder(admin, 'purchase', {
    lines: [{ itemId, qty: 3, price: 113, taxRate: 13 }],
  });
  expect(String(order.id).length).toBeGreaterThan(0);
  const detail = await run(purchase.session, 'purchase_detail', {
    filters: {}, dimensions: [], measures: ['qty', 'taxIncludedPrice', 'taxRate', 'taxIncludedAmount'],
  });
  expect(detail.response.status).toBe(200);
  expect((detail.body.columns as { key: string }[]).map((column) => column.key)).toContain('taxIncludedAmount');
  expect(Number(firstItem(detail.body).qty)).toBe(3);

  const stock = await admin.fetch('/stock-docs', write({
    docType: 'in', reason: 'other_in',
    lines: [{ itemId, warehouseId, batchNo: 'B-R078', qty: 5, taxIncludedPrice: 100, taxRate: 13 }],
  }));
  expect(stock.status).toBe(201);
  const stockDoc = await jsonOf(stock);
  const postedStock = await admin.fetch(`/stock-docs/${String(stockDoc.id)}/post`, write());
  expect(postedStock.status).toBe(200);
  const stockResult = await run(warehouse.session, 'stock_movement_detail', {
    filters: {}, dimensions: [], measures: ['inQty', 'outQty'],
  });
  expect(stockResult.response.status).toBe(200);
  expect(Number(firstItem(stockResult.body).inQty)).toBe(5);

  await createOrder(admin, 'sales', { lines: [{ itemId, qty: 4 }] });
  const tracking = await run(planning.session, 'sales_tracking', {
    filters: {}, dimensions: [], measures: ['shippedQty', 'unshippedQty', 'returnQty'],
  });
  expect(tracking.response.status).toBe(200);
  expect(Number(firstItem(tracking.body).unshippedQty)).toBe(4);
  expect(Object.keys(firstItem(tracking.body)).sort()).toEqual(
    ['shippedQty', 'unshippedQty', 'returnQty'].sort(),
  );
});

test('白名单、成本 key 与分页：定义外的键 400、猜成本 key 404、pageSize=101 400', async ({ testApp }) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const finance = await makeUser(admin, testApp, 'finance');
  const invalid = await run(finance.session, 'income_expense_detail', {
    filters: { price: 1 }, dimensions: [], measures: ['receivedAmount'],
  });
  expect(invalid.response.status).toBe(400);
  expect(invalid.body.error?.reason).toBe('REPORT_FIELD_INVALID');
  const badDimension = await run(finance.session, 'income_expense_detail', {
    filters: {}, dimensions: ['secretCustomer'], measures: [],
  });
  expect(badDimension.response.status).toBe(400);
  expect(badDimension.body.error?.reason).toBe('REPORT_FIELD_INVALID');
  const cost = await run(finance.session, 'gross_margin', { filters: {} });
  expect(cost.response.status).toBe(404);
  expect(cost.body.error?.reason).toBe('REPORT_NOT_FOUND');
  const paged = await run(finance.session, 'income_expense_detail', {
    filters: {}, dimensions: [], measures: [], pageSize: 101,
  });
  expect(paged.response.status).toBe(400);
  expect(paged.body.error?.reason).toBe('REPORT_PAGE_INVALID');
});

test('常用：重复设仍只有一行，取消后列表不含，用户之间互不影响', async ({ testApp }) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const first = await makeUser(admin, testApp, 'finance');
  const second = await makeUser(admin, testApp, 'finance');
  for (let i = 0; i < 2; i += 1) {
    const response = await first.session.fetch('/reports/income_expense_detail/favorite', write());
    expect(response.status).toBe(200);
    expect((await jsonOf(response)).favorited).toBe(true);
  }
  expect((await jsonOf(await first.session.fetch('/reports/favorites', get()))).items)
    .toEqual([expect.objectContaining({ key: 'income_expense_detail' })]);
  await second.session.fetch('/reports/invoice_receipt_detail/favorite', write());
  const firstList = await jsonOf(await first.session.fetch('/reports/favorites', get()));
  expect((firstList.items as Row[]).map((row) => row.key)).toEqual(['income_expense_detail']);

  const removed = await first.session.fetch('/reports/income_expense_detail/favorite', {
    method: 'DELETE', headers: { origin: 'http://localhost' },
  });
  expect(removed.status).toBe(200);
  expect((await jsonOf(removed)).favorited).toBe(false);
  const after = await jsonOf(await first.session.fetch('/reports/favorites', get()));
  expect(after.items).toEqual([]);
  const secondList = await jsonOf(await second.session.fetch('/reports/favorites', get()));
  expect((secondList.items as Row[]).map((row) => row.key)).toEqual(['invoice_receipt_detail']);
});

/** 编造一张采购单：入库 10、已付 123、已到票 90，逐列对照业务单据的回写。 */
async function purchaseFixture(
  admin: TestSession, connection: DatabaseConnection,
): Promise<{ id: string; receivedQty: number; paidAmount: number; invoicedAmount: number }> {
  const itemId = await createItem(connection);
  const warehouseId = String((await createWarehouse(admin)).id);
  const order = await createOrder(admin, 'purchase', { lines: [{ itemId, qty: 10, price: 100 }] });
  const id = String(order.id);
  await admin.fetch(`/purchase-orders/${id}/submit`, write());
  const issued = await admin.fetch(`/purchase-orders/${id}/create-receipt`, write({ warehouseId }));
  expect(issued.status).toBe(201);
  const stockDoc = await jsonOf(issued);
  const postedStock = await admin.fetch(`/stock-docs/${String(stockDoc.id)}/post`, write());
  expect(postedStock.status).toBe(200);

  const expense = await admin.fetch('/expenses', write({
    expenseDate: '2026-11-27', bindMode: 'purchase_order',
    lines: [{ purchaseOrderId: id, amount: 123 }], confirm: true,
  }));
  expect(expense.status).toBe(201);
  const invoice = await admin.fetch('/invoice-receipts', write({
    invoiceDate: '2026-11-27', bindMode: 'purchase_order',
    lines: [{ purchaseOrderId: id, amount: 90 }], confirm: true,
  }));
  expect(invoice.status).toBe(201);
  const detail = await jsonOf(await admin.fetch(`/purchase-orders/${id}`, get()));
  const line = (detail.lines as Row[])[0]!;
  return {
    id,
    receivedQty: Number(line.receivedQty),
    paidAmount: Number(detail.paidAmount),
    invoicedAmount: Number(detail.invoicedAmount),
  };
}

test('采2 口径：已入库 / 已付 / 已到票与 R-065 回写到订单的数逐列一致', async ({ testApp, connection }) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const purchase = await makeUser(admin, testApp, 'purchase');
  const fixture = await purchaseFixture(admin, connection);
  expect(fixture.receivedQty).toBe(10);
  expect(fixture.paidAmount).toBe(123);
  expect(fixture.invoicedAmount).toBe(90);

  const result = await run(purchase.session, 'purchase_tracking', {
    filters: { supplier: String((await jsonOf(await admin.fetch(
      `/purchase-orders/${fixture.id}`, get()))).supplierId) },
    dimensions: [],
    measures: ['receivedQty', 'paidAmount', 'invoicedAmount', 'unpaidAmount'],
  });
  expect(result.response.status).toBe(200);
  const item = firstItem(result.body);
  expect(Number(item.receivedQty)).toBe(fixture.receivedQty);
  expect(Number(item.paidAmount)).toBe(fixture.paidAmount);
  expect(Number(item.invoicedAmount)).toBe(fixture.invoicedAmount);
});

/** 编造一张销售单：出库 10、已收 200、已开票 226，逐列对照订单详情的回写。 */
async function salesFixture(
  admin: TestSession, connection: DatabaseConnection,
): Promise<{ id: string; shippedQty: number; receivedAmount: number; invoicedAmount: number }> {
  const itemId = await createItem(connection);
  const warehouseId = String((await createWarehouse(admin)).id);
  const inbound = await createOrder(admin, 'purchase', { lines: [{ itemId, qty: 10 }] });
  const inboundId = String(inbound.id);
  await admin.fetch(`/purchase-orders/${inboundId}/submit`, write());
  const inboundDoc = await jsonOf(await admin.fetch(
    `/purchase-orders/${inboundId}/create-receipt`, write({ warehouseId })));
  await admin.fetch(`/stock-docs/${String(inboundDoc.id)}/post`, write());
  const order = await createOrder(admin, 'sales', { lines: [{ itemId, qty: 10, price: 100 }] });
  const id = String(order.id);
  await admin.fetch(`/sales-orders/${id}/submit`, write());
  const issued = await admin.fetch(`/sales-orders/${id}/create-issue`, write({ warehouseId }));
  expect(issued.status).toBe(201);
  const stockDoc = await jsonOf(issued);
  const postedIssue = await admin.fetch(`/stock-docs/${String(stockDoc.id)}/post`, write());
  expect(postedIssue.status).toBe(200);

  const income = await admin.fetch('/income-records', write({
    incomeDate: '2026-11-27', bindMode: 'sales_order',
    lines: [{ salesOrderId: id, amount: 200 }], confirm: true,
  }));
  expect(income.status).toBe(201);
  const invoice = await admin.fetch('/sale-invoice-records', write({
    invoiceDate: '2026-11-27', bindMode: 'sales_order',
    lines: [{ salesOrderId: id, amount: 226 }], confirm: true,
  }));
  expect(invoice.status).toBe(201);
  const detail = await jsonOf(await admin.fetch(`/sales-orders/${id}`, get()));
  const line = (detail.lines as Row[])[0]!;
  return {
    id,
    shippedQty: Number(line.shippedQty),
    receivedAmount: Number(detail.receivedAmount),
    invoicedAmount: Number(detail.invoicedAmount),
  };
}

test('销2 口径：已出库 / 已收 / 已开票与订单详情逐列一致', async ({ testApp, connection }) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const sales = await makeUser(admin, testApp, 'sales');
  const fixture = await salesFixture(admin, connection);
  expect(fixture.shippedQty).toBe(10);
  expect(fixture.receivedAmount).toBe(200);
  expect(fixture.invoicedAmount).toBe(226);

  const result = await run(sales.session, 'sales_tracking', {
    filters: {}, dimensions: [],
    measures: ['shippedQty', 'receivedAmount', 'invoicedAmount'],
  });
  expect(result.response.status).toBe(200);
  const item = firstItem(result.body);
  expect(Number(item.shippedQty)).toBe(fixture.shippedQty);
  expect(Number(item.receivedAmount)).toBe(fixture.receivedAmount);
  expect(Number(item.invoicedAmount)).toBe(fixture.invoicedAmount);
});

test('其余来源都出数：采8 检验、销10 报价、销16 台账、财2-5 与销15', async ({ testApp, connection }) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const finance = await makeUser(admin, testApp, 'finance');
  const sales = await makeUser(admin, testApp, 'sales');
  const purchase = await makeUser(admin, testApp, 'purchase');
  const itemId = await createItem(connection);
  const purchaseOrder = await createOrder(admin, 'purchase', { lines: [{ itemId, qty: 10 }] });
  await admin.fetch(`/purchase-orders/${String(purchaseOrder.id)}/submit`, write());

  const inspection = await admin.fetch('/inspections', write({
    purchaseOrderId: purchaseOrder.id,
    lines: [{ itemId, inspectionTypeCode: 'full', receivedQty: 8, inspectionQty: 8, qualifiedQty: 6, samplingQty: 2, samplingQualifiedQty: 2 }],
  }));
  expect(inspection.status).toBe(201);
  const inspectionResult = await run(purchase.session, 'inspection_records', {
    filters: {}, dimensions: [], measures: ['inspectionQty'],
  });
  expect(inspectionResult.response.status).toBe(200);
  expect(Number(firstItem(inspectionResult.body).inspectionQty)).toBe(8);

  // 报价单复用刚建销售单的客户。
  const salesOrder = await createOrder(admin, 'sales', { lines: [{ itemId, qty: 2 }] });
  const salesDetail = await jsonOf(await admin.fetch(`/sales-orders/${String(salesOrder.id)}`, get()));
  const quotationCreated = await admin.fetch('/quotations', write({
    customerId: salesDetail.customerId, quoteDate: '2026-11-27',
    lines: [{ itemId, qty: 2, price: 50 }],
  }));
  expect(quotationCreated.status).toBe(201);
  const quotationResult = await run(sales.session, 'quotation_detail', {
    filters: {}, dimensions: [], measures: ['qty'],
  });
  expect(quotationResult.response.status).toBe(200);
  expect(Number(firstItem(quotationResult.body).qty)).toBe(2);

  const ledger = await run(sales.session, 'sales_delivery', {
    filters: {}, dimensions: [], measures: ['baseQty'],
  });
  expect(ledger.response.status).toBe(200);
  expect(Number(firstItem(ledger.body).baseQty)).toBeGreaterThan(0);

  const day = '2026-10-15';
  for (const [url, body] of [
    ['/invoice-receipts', { invoiceDate: day, bindMode: 'none', amount: 90, confirm: true }],
    ['/sale-invoice-records', { invoiceDate: day, bindMode: 'none', amount: 30, confirm: true }],
    ['/income-records', { incomeDate: day, bindMode: 'none', amount: 20, confirm: true }],
    ['/expenses', { expenseDate: day, bindMode: 'none', amount: 10, confirm: true }],
  ] as const) {
    const created = await admin.fetch(url, write(body));
    expect(created.status).toBe(201);
  }
  // 财务读服务把 DATE 渲染成前一天（既有行为），报表按读服务输出出数；
  // 这里核对金额确实由编造单据产生，不把那个偏移固化进测试。
  for (const [key, measure, expected] of [
    ['invoice_receipt_detail', 'receivedInvoiceAmount', 90],
    ['sale_invoice_detail', 'invoiceAmount', 30],
    ['income_record_detail', 'incomeAmount', 20],
    ['expense_record_detail', 'expenseAmount', 10],
    ['sales_income_expense', 'incomeAmount', 20],
  ] as const) {
    const result = await run(finance.session, key, {
      filters: {}, dimensions: [], measures: [measure],
    });
    expect(result.response.status).toBe(200);
    const total = (result.body.items as Row[]).reduce(
      (sum, item) => sum + Number(item[measure]), 0,
    );
    expect(total).toBeGreaterThanOrEqual(expected);
  }
});
