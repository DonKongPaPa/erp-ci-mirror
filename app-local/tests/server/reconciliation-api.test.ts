// @vitest-environment node
import { randomUUID } from 'node:crypto';

import {
  DEFAULT_ADMIN_CREDENTIALS,
  signIn,
  type TestSession,
} from '@nocobase/app-plugin-authentication/testing';
import { expect } from 'vitest';
import type { DatabaseConnection } from '@nocobase/db';

import { createAppTest } from '../helpers/test-app.js';
import { createItem } from '../helpers/inventory.js';
import {
  createDictEntry,
  createOrder,
  createPartner,
  createWarehouse,
  get,
  jsonOf,
  makeRoleUser,
  unique,
  write,
  type Row,
} from '../helpers/orders.js';
import { createStandaloneServer } from '../../server/standalone.js';
import {
  reconciliationMutationsToken,
  stateOfRecon,
} from '../../server/providers/reconciliation.js';

/**
 * R-065 复刻波 2：收入、开票、两张对账单与核销的正向、拒绝、重算、并发与窄读。
 * 真 Postgres，测试数据一律编造；客户/供应商的邮箱只作「不外泄」的诱饵。
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
  ...['incomeRecords', 'saleInvoiceRecords', 'receivableRecons', 'payableRecons', 'expenses', 'invoiceReceipts']
    .map((id) => ({ resource: { type: 'composite', id }, actions: ACTIONS.map((action) => ({ action })) })),
  { resource: { type: 'composite', id: 'salesOrders' }, actions: [{ action: 'financeView' }] },
  { resource: { type: 'composite', id: 'purchaseOrders' }, actions: [{ action: 'financeView' }] },
];

async function financeUser(admin: TestSession, testApp: Parameters<typeof signIn>[0]): Promise<TestSession> {
  const { session } = await makeRoleUser(admin, testApp, 'r065rfinance', FINANCE_GRANTS);
  return session;
}

async function expectStatus(response: Response, status: number): Promise<Row> {
  const text = await response.clone().text();
  expect(response.status, `期望 ${status}，实际 ${response.status}：${text}`).toBe(status);
  return await jsonOf(response);
}

async function postedDoc(
  connection: DatabaseConnection, admin: TestSession, docType: 'in' | 'out', lines: number,
): Promise<{ id: string; itemId: string }> {
  const itemId = await createItem(connection);
  await createWarehouse(admin);
  const id = `doc-${randomUUID()}`;
  const now = new Date();
  await connection.query.insertInto('stock_docs').values({
    id, docNo: `${docType === 'in' ? 'RK' : 'CK'}-${unique('DOC')}`,
    docType, reason: docType === 'in' ? 'purchase_in' : 'sale_out',
    status: 'posted', remark: '', createdById: 'recon-test',
    createdAt: now, updatedAt: now, postedAt: now,
  }).execute();
  const warehouseRow = await connection.query
    .selectFrom('warehouses').select('id').limit(1).executeTakeFirstOrThrow();
  for (let index = 0; index < lines; index += 1) {
    await connection.query.insertInto('stock_doc_lines').values({
      id: `dl-${randomUUID()}`, docId: id, itemId,
      warehouseId: warehouseRow.id, batchNo: '', qty: 5,
      taxIncludedPrice: 20, taxRate: 13, taxIncludedAmount: 100, note: null,
    }).execute();
  }
  return { id, itemId };
}

async function saleOrder(admin: TestSession, connection: DatabaseConnection, customerId?: string): Promise<Row> {
  const item = await createItem(connection);
  const order = await createOrder(admin, 'sales', {
    ...(customerId === undefined ? {} : { customerId }),
    lines: [{ itemId: item, qty: 10, price: 100, taxRate: 13 }],
  });
  expect((await admin.fetch(`/sales-orders/${String(order.id)}/submit`, write())).status).toBe(200);
  return order;
}

test('收入：绑两张销售订单，确认回写已收金额，作废回退；confirm:true 一步登记', async ({
  testApp, connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const finance = await financeUser(admin, testApp);
  const customer = await createPartner(admin, { isCustomer: true });
  const first = await saleOrder(admin, connection, String(customer.id));
  const second = await saleOrder(admin, connection, String(customer.id));

  const created = await expectStatus(await finance.fetch('/income-records', write({
    incomeDate: '2026-11-28', bindMode: 'sales_order',
    lines: [
      { salesOrderId: first.id, amount: 60 },
      { salesOrderId: second.id, amount: 40 },
    ],
  })), 201);
  expect(created.status).toBe('draft');
  expect(created.totalAmount).toBe(100);
  expect(created.lines).toHaveLength(2);
  expect(String(created.docNo)).toMatch(/^INCM-\d{8}-\d{4,}$/u);

  const confirmed = await expectStatus(
    await finance.fetch(`/income-records/${String(created.id)}/confirm`, write()), 200,
  );
  expect(confirmed.status).toBe('confirmed');
  expect(confirmed.confirmedAt).not.toBeNull();
  for (const [order, amount] of [[first, 60], [second, 40]] as const) {
    const detail = await jsonOf(await admin.fetch(`/sales-orders/${String(order.id)}`, get()));
    expect(detail.receivedAmount).toBe(amount);
  }
  const voided = await expectStatus(
    await finance.fetch(`/income-records/${String(created.id)}/void`, write()), 200,
  );
  expect(voided.status).toBe('void');
  for (const order of [first, second]) {
    const detail = await jsonOf(await admin.fetch(`/sales-orders/${String(order.id)}`, get()));
    expect(detail.receivedAmount).toBe(0);
  }

  const direct = await expectStatus(await finance.fetch('/income-records', write({
    incomeDate: '2026-11-28', bindMode: 'none', amount: 8, confirm: true,
  })), 201);
  expect(direct.status).toBe('confirmed');
  expect(direct.totalAmount).toBe(8);
}, TIMEOUT);

test('开票：回写销售订单已开票金额，同订单两笔是之和，作废一笔回到另一笔', async ({
  testApp, connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const finance = await financeUser(admin, testApp);
  const customer = await createPartner(admin, { isCustomer: true });
  const order = await saleOrder(admin, connection, String(customer.id));

  const first = await expectStatus(await finance.fetch('/sale-invoice-records', write({
    invoiceDate: '2026-11-28', bindMode: 'sales_order', invoiceNo: 'FP-001',
    lines: [{ salesOrderId: order.id, amount: 30 }],
  })), 201);
  const second = await expectStatus(await finance.fetch('/sale-invoice-records', write({
    invoiceDate: '2026-11-28', bindMode: 'sales_order', invoiceNo: 'FP-002',
    lines: [{ salesOrderId: order.id, amount: 20 }],
  })), 201);
  await finance.fetch(`/sale-invoice-records/${String(first.id)}/confirm`, write());
  await finance.fetch(`/sale-invoice-records/${String(second.id)}/confirm`, write());
  const detail = await jsonOf(await admin.fetch(`/sales-orders/${String(order.id)}`, get()));
  expect(detail.invoicedAmount).toBe(50);

  await finance.fetch(`/sale-invoice-records/${String(first.id)}/void`, write());
  const after = await jsonOf(await admin.fetch(`/sales-orders/${String(order.id)}`, get()));
  expect(after.invoicedAmount).toBe(20);
  const again = await finance.fetch(`/sale-invoice-records/${String(second.id)}/confirm`, write());
  expect(again.status, '重复 confirm 422').toBe(422);
  expect((await jsonOf(again)).error?.reason).toBe('FINANCE_NOT_DRAFT');
}, TIMEOUT);

test('应收对账单：出库单快照只读；收入与开票两腿都到才 settled，作废回退', async ({
  testApp, connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const finance = await financeUser(admin, testApp);
  const customer = await createPartner(admin, { isCustomer: true });
  const posted = await postedDoc(connection, admin, 'out', 2);

  const recon = await expectStatus(await finance.fetch('/receivable-recons', write({
    reconDate: '2026-11-28', expectedPayDate: '2026-12-28',
    customerId: customer.id, periodAmount: 100,
    outStockDocIds: [posted.id], contactName: '编造联系人', phone: '000-0000',
  })), 201);
  expect(recon.status).toBe('draft');
  expect(recon.reconStatus).toBe('unsettled');
  expect(recon.snapshotLines).toHaveLength(2);
  expect(recon.snapshotLines[0]?.item.id).toBe(posted.itemId);
  expect((await finance.fetch(`/receivable-recons/${String(recon.id)}/confirm`, write())).status).toBe(200);

  const first = await expectStatus(await finance.fetch('/income-records', write({
    incomeDate: '2026-11-28', bindMode: 'receivable_recon',
    lines: [{ receivableReconId: recon.id, amount: 40 }],
  })), 201);
  expect(first.customer?.id).toBe(customer.id);
  await finance.fetch(`/income-records/${String(first.id)}/confirm`, write());
  let detail = await jsonOf(await finance.fetch(`/receivable-recons/${String(recon.id)}`, get()));
  expect(detail.reconciledIncomeAmount).toBe(40);
  expect(detail.reconStatus).toBe('partial');

  const second = await expectStatus(await finance.fetch('/income-records', write({
    incomeDate: '2026-11-28', bindMode: 'receivable_recon',
    lines: [{ receivableReconId: recon.id, amount: 60 }],
  })), 201);
  await finance.fetch(`/income-records/${String(second.id)}/confirm`, write());
  detail = await jsonOf(await finance.fetch(`/receivable-recons/${String(recon.id)}`, get()));
  expect(detail.reconciledIncomeAmount).toBe(100);
  // 收款腿到了、开票腿没到：只算 partial。
  expect(detail.reconStatus).toBe('partial');

  const invoiced = await expectStatus(await finance.fetch('/sale-invoice-records', write({
    invoiceDate: '2026-11-28', bindMode: 'receivable_recon',
    lines: [{ receivableReconId: recon.id, amount: 100 }],
  })), 201);
  await finance.fetch(`/sale-invoice-records/${String(invoiced.id)}/confirm`, write());
  detail = await jsonOf(await finance.fetch(`/receivable-recons/${String(recon.id)}`, get()));
  expect(detail.reconciledInvoiceAmount).toBe(100);
  expect(detail.reconStatus).toBe('settled');

  await finance.fetch(`/sale-invoice-records/${String(invoiced.id)}/void`, write());
  detail = await jsonOf(await finance.fetch(`/receivable-recons/${String(recon.id)}`, get()));
  expect(detail.reconciledInvoiceAmount).toBe(0);
  expect(detail.reconStatus).toBe('partial');
  await finance.fetch(`/income-records/${String(second.id)}/void`, write());
  detail = await jsonOf(await finance.fetch(`/receivable-recons/${String(recon.id)}`, get()));
  expect(detail.reconciledIncomeAmount).toBe(40);
  expect(detail.reconStatus).toBe('partial');

  const options = await expectStatus(
    await finance.fetch('/receivable-recons/options?q=', get()), 200,
  );
  expect(options.items?.some((item) => item.id === recon.id)).toBe(true);
}, TIMEOUT);

test('应付对账单：支出与到票分别回写付款/到票两列', async ({ testApp, connection }) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const finance = await financeUser(admin, testApp);
  const supplier = await createPartner(admin, { isSupplier: true });
  await createDictEntry(connection, 'invoice_type', 'VAT-RECON');
  const posted = await postedDoc(connection, admin, 'in', 1);

  const recon = await expectStatus(await finance.fetch('/payable-recons', write({
    reconDate: '2026-11-28', supplierId: supplier.id, periodAmount: 100,
    purchaseStockDocIds: [posted.id], invoiceTypeCode: 'VAT-RECON',
  })), 201);
  await finance.fetch(`/payable-recons/${String(recon.id)}/confirm`, write());

  const expense = await expectStatus(await finance.fetch('/expenses', write({
    expenseDate: '2026-11-28', bindMode: 'payable_recon',
    lines: [{ payableReconId: recon.id, amount: 70 }],
  })), 201);
  expect(expense.lines?.[0]?.payableReconId).toBe(recon.id);
  expect(expense.lines?.[0]?.purchaseOrderId).toBe('');
  await finance.fetch(`/expenses/${String(expense.id)}/confirm`, write());
  let detail = await jsonOf(await finance.fetch(`/payable-recons/${String(recon.id)}`, get()));
  expect(detail.reconciledPaidAmount).toBe(70);
  expect(detail.reconciledInvoiceAmount).toBe(0);
  expect(detail.reconStatus).toBe('partial');

  const morePaid = await expectStatus(await finance.fetch('/expenses', write({
    expenseDate: '2026-11-28', bindMode: 'payable_recon',
    lines: [{ payableReconId: recon.id, amount: 30 }],
  })), 201);
  await finance.fetch(`/expenses/${String(morePaid.id)}/confirm`, write());
  detail = await jsonOf(await finance.fetch(`/payable-recons/${String(recon.id)}`, get()));
  expect(detail.reconciledPaidAmount).toBe(100);
  expect(detail.reconciledInvoiceAmount).toBe(0);
  expect(detail.reconStatus).toBe('partial');

  const invoice = await expectStatus(await finance.fetch('/invoice-receipts', write({
    invoiceDate: '2026-11-28', bindMode: 'payable_recon',
    lines: [{ payableReconId: recon.id, amount: 100 }],
  })), 201);
  await finance.fetch(`/invoice-receipts/${String(invoice.id)}/confirm`, write());
  detail = await jsonOf(await finance.fetch(`/payable-recons/${String(recon.id)}`, get()));
  expect(detail.reconciledPaidAmount).toBe(100);
  expect(detail.reconciledInvoiceAmount).toBe(100);
  expect(detail.reconStatus).toBe('settled');

  await finance.fetch(`/expenses/${String(morePaid.id)}/void`, write());
  detail = await jsonOf(await finance.fetch(`/payable-recons/${String(recon.id)}`, get()));
  expect(detail.reconciledPaidAmount).toBe(70);
  expect(detail.reconStatus).toBe('partial');
  await finance.fetch(`/invoice-receipts/${String(invoice.id)}/void`, write());
  detail = await jsonOf(await finance.fetch(`/payable-recons/${String(recon.id)}`, get()));
  expect(detail.reconciledInvoiceAmount).toBe(0);
  expect(detail.reconStatus).toBe('partial');
}, TIMEOUT);

test('拒绝：未确认对账单、混绑、跨客户、草稿来源、作废登记、重复引用', async ({
  testApp, connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const finance = await financeUser(admin, testApp);
  const customer = await createPartner(admin, { isCustomer: true });
  const otherCustomer = await createPartner(admin, { isCustomer: true });
  const first = await saleOrder(admin, connection, String(customer.id));
  const other = await saleOrder(admin, connection, String(otherCustomer.id));
  const posted = await postedDoc(connection, admin, 'out', 1);

  const draftRecon = await expectStatus(await finance.fetch('/receivable-recons', write({
    reconDate: '2026-11-28', customerId: customer.id, periodAmount: 100,
    outStockDocIds: [posted.id],
  })), 201);
  const rejected = await finance.fetch('/income-records', write({
    incomeDate: '2026-11-28', bindMode: 'receivable_recon',
    lines: [{ receivableReconId: draftRecon.id, amount: 10 }],
  }));
  expect(rejected.status).toBe(422);
  expect((await jsonOf(rejected)).error?.reason).toBe('FINANCE_RECON_NOT_OPEN');

  const mixed = await finance.fetch('/income-records', write({
    incomeDate: '2026-11-28', bindMode: 'sales_order',
    lines: [
      { salesOrderId: first.id, amount: 10 },
      { receivableReconId: draftRecon.id, amount: 10 },
    ],
  }));
  expect(mixed.status).toBe(422);
  expect((await jsonOf(mixed)).error?.reason).toBe('FINANCE_BIND_MIXED');

  const cross = await finance.fetch('/income-records', write({
    incomeDate: '2026-11-28', bindMode: 'sales_order',
    lines: [
      { salesOrderId: first.id, amount: 10 },
      { salesOrderId: other.id, amount: 10 },
    ],
  }));
  expect(cross.status).toBe(422);
  expect((await jsonOf(cross)).error?.reason).toBe('FINANCE_CUSTOMER_MIXED');

  const dup = await finance.fetch('/income-records', write({
    incomeDate: '2026-11-28', bindMode: 'sales_order',
    lines: [
      { salesOrderId: first.id, amount: 10 },
      { salesOrderId: first.id, amount: 10 },
    ],
  }));
  expect(dup.status).toBe(422);
  expect((await jsonOf(dup)).error?.reason).toBe('FINANCE_LINE_DUPLICATED');

  const blankDocId = `doc-${randomUUID()}`;
  await connection.query.insertInto('stock_docs').values({
    id: blankDocId, docNo: `CK-${unique('DRAFT')}`,
    docType: 'out', reason: 'sale_out', status: 'draft', remark: '',
    createdById: 'recon-test', createdAt: new Date(), updatedAt: new Date(),
  }).execute();
  const badSource = await finance.fetch('/receivable-recons', write({
    reconDate: '2026-11-28', customerId: customer.id, periodAmount: 100,
    outStockDocIds: [blankDocId],
  }));
  expect(badSource.status).toBe(422);
  expect((await jsonOf(badSource)).error?.reason).toBe('RECON_SOURCE_INVALID');

  const voided = await expectStatus(await finance.fetch('/income-records', write({
    incomeDate: '2026-11-28', bindMode: 'none', amount: 5,
  })), 201);
  await finance.fetch(`/income-records/${String(voided.id)}/void`, write());
  const registerVoided = await finance.fetch(`/income-records/${String(voided.id)}/confirm`, write());
  expect(registerVoided.status).toBe(422);
  expect((await jsonOf(registerVoided)).error?.reason).toBe('FINANCE_VOIDED');
}, TIMEOUT);

test('并发：同一张对账单上两笔核销，已核销金额等于两笔之和（两个真事务，不用睡眠）', async ({
  app, testApp, connection, database,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const finance = await financeUser(admin, testApp);
  const customer = await createPartner(admin, { isCustomer: true });
  const posted = await postedDoc(connection, admin, 'out', 1);
  const recon = await expectStatus(await finance.fetch('/receivable-recons', write({
    reconDate: '2026-11-28', customerId: customer.id, periodAmount: 200,
    outStockDocIds: [posted.id],
  })), 201);
  await finance.fetch(`/receivable-recons/${String(recon.id)}/confirm`, write());

  const service = app.container.resolve(reconciliationMutationsToken);
  const entered = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
  const bothEntered = Promise.withResolvers<void>();
  const attempt = (index: number, amount: number) => database.transaction(async (tx) => {
    entered[index]!.resolve();
    await bothEntered.promise;
    return await service.createDoc(
      'income',
      {
        date: '2026-11-28', bindMode: 'receivable_recon', confirm: true,
        lines: [{ receivableReconId: String(recon.id), amount }],
      },
      'recon-concurrency-test', tx,
    );
  });

  const first = attempt(0, 30);
  const second = attempt(1, 70);
  try {
    await Promise.all(entered.map((gate) => gate.promise));
  } finally {
    bothEntered.resolve();
  }
  await Promise.all([first, second]);

  const detail = await jsonOf(await finance.fetch(`/receivable-recons/${String(recon.id)}`, get()));
  expect(detail.reconciledIncomeAmount).toBe(100);
  expect(detail.reconStatus).toBe('partial');
}, TIMEOUT);

test('stateOfRecon 边界：两列各自比本期金额，不用相加；容差 0.005', () => {
  expect(stateOfRecon(100, 0, 0)).toBe('unsettled');
  expect(stateOfRecon(100, 40, 0)).toBe('partial');
  expect(stateOfRecon(100, 60, 40)).toBe('partial');
  expect(stateOfRecon(100, 100, 0)).toBe('partial');
  expect(stateOfRecon(100, 100, 100)).toBe('settled');
  expect(stateOfRecon(100, 100, 100.01)).toBe('settled');
  // 容差：99.995 算到 100；差得更远的 99.99 仍是 partial。
  expect(stateOfRecon(100, 99.995, 100)).toBe('settled');
  expect(stateOfRecon(100, 99.99, 100)).toBe('partial');
  // 浮点凑出来的本期金额也不能误判。
  const fuzz = 33.33 + 66.67;
  expect(stateOfRecon(fuzz, fuzz, fuzz)).toBe('settled');
});

test('窄读：sales-orders/receivable 没有明细、单价、备注、经办人；没有 DELETE 路由', async ({
  testApp, connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const finance = await financeUser(admin, testApp);
  const order = await saleOrder(admin, connection);
  const response = await expectStatus(await finance.fetch('/sales-orders/receivable', get()), 200);
  expect(response.total).toBeGreaterThan(0);
  const row = response.items?.find((item) => item.id === order.id) ?? response.items?.[0];
  expect(row).toBeDefined();
  for (const key of ['lines', 'remark', 'price', 'handler', 'handlerUserId', 'taxIncludedTotal']) {
    expect(Object.keys(row!)).not.toContain(key);
  }
  expect(Object.keys(row!.customer as Row).sort()).toEqual(['code', 'id', 'name']);
  expect(Object.keys(row!).sort()).toEqual([
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

test('页面窄读：已过账出入库单与客户/供应商下拉只给财务，字段收窄', async ({
  testApp, connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const finance = await financeUser(admin, testApp);
  const { session: outsider } = await makeRoleUser(admin, testApp, 'r065rout', []);
  const posted = await postedDoc(connection, admin, 'out', 1);
  const customer = await createPartner(admin, { isCustomer: true });

  const source = await expectStatus(
    await finance.fetch('/reconciliation/source-docs?kind=out&page=1&pageSize=20', get()), 200,
  );
  const row = source.items?.find((item) => item.id === posted.id);
  expect(row).toBeDefined();
  expect(Object.keys(row as Row).sort()).toEqual([
    'docDate', 'docNo', 'id', 'partnerId', 'partnerName', 'reason', 'status', 'totalQty',
  ]);
  expect(JSON.stringify(row)).not.toContain('item');
  expect(JSON.stringify(row)).not.toContain('price');
  const partners = await expectStatus(
    await finance.fetch('/reconciliation/partners?kind=customer&page=1&pageSize=20', get()), 200,
  );
  expect(partners.items?.some((item) => item.id === customer.id)).toBe(true);
  expect(Object.keys(partners.items?.[0] as Row).sort()).toEqual(['code', 'id', 'name']);

  // 授权范围不变：两个窄读沿用对账单 view，非财务一样 403。
  for (const path of [
    '/reconciliation/source-docs?kind=out', '/reconciliation/partners?kind=customer',
  ]) {
    expect((await outsider.fetch(path, get())).status).toBe(403);
  }
}, TIMEOUT);
