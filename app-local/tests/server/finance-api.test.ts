// @vitest-environment node
import {
  DEFAULT_ADMIN_CREDENTIALS,
  signIn,
  type TestSession,
} from '@nocobase/app-plugin-authentication/testing';
import { expect } from 'vitest';
import { databaseManagerToken } from '@nocobase/db';
import type { Knex } from 'knex';

import { createAppTest } from '../helpers/test-app.js';
import { createItem } from '../helpers/inventory.js';
import {
  createDictEntry,
  createOrder,
  createPartner,
  get,
  jsonOf,
  makeRoleUser,
  write,
  type Row,
} from '../helpers/orders.js';
import { createStandaloneServer } from '../../server/standalone.js';
import { financeMutationsToken } from '../../server/providers/finance.js';

/**
 * R-065 第一片：支出与到票的正向、拒绝、重算不变量与并发回写。
 * 测试数据一律编造；字典取值由测试直接写进真库，不进仓库。
 */
const test = createAppTest({
  createServer: createStandaloneServer,
  config: {
    app: { publicOrigin: 'http://localhost' },
    auth: { secret: 'test-auth-secret-at-least-32-characters' },
  },
});
const TIMEOUT = 30_000;

async function payableOrder(
  admin: TestSession,
  connection: Parameters<typeof createItem>[0],
  qty = 100,
  supplier?: Row,
): Promise<Row> {
  supplier ??= await createPartner(admin, { isSupplier: true });
  const item = await createItem(connection);
  const order = await createOrder(admin, 'purchase', {
    supplierId: supplier.id,
    lines: [{ itemId: item, qty, price: 100, taxRate: 13 }],
  });
  expect((await admin.fetch(`/purchase-orders/${String(order.id)}/submit`, write())).status).toBe(200);
  return { ...order, supplierId: supplier.id };
}

async function createFinanceUser(
  admin: TestSession,
  testApp: Parameters<typeof signIn>[0],
): Promise<TestSession> {
  const { session } = await makeRoleUser(
    admin, testApp, 'r065finance', [
      { resource: { type: 'composite', id: 'expenses' }, actions: [
        { action: 'view' }, { action: 'create' }, { action: 'update' },
        { action: 'confirm' }, { action: 'void' },
      ] },
      { resource: { type: 'composite', id: 'invoiceReceipts' }, actions: [
        { action: 'view' }, { action: 'create' }, { action: 'update' },
        { action: 'confirm' }, { action: 'void' },
      ] },
      { resource: { type: 'composite', id: 'purchaseOrders' }, actions: [{ action: 'financeView' }] },
    ],
  );
  return session;
}

test('支出：草稿绑两张订单，登记回写已支出，作废回退', async ({ testApp, connection }) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const finance = await createFinanceUser(admin, testApp);
  const sharedSupplier = await createPartner(admin, { isSupplier: true });
  const first = await payableOrder(admin, connection, 100, sharedSupplier);
  const second = await payableOrder(admin, connection, 100, sharedSupplier);
  await createDictEntry(connection, 'expense_type', 'PAY-SUPPLY');
  await createDictEntry(connection, 'fund_account', 'BANK-A');

  const created = await finance.fetch('/expenses', write({
    expenseDate: '2026-11-28', bindMode: 'purchase_order',
    expenseTypeCode: 'PAY-SUPPLY', fundAccountCode: 'BANK-A',
    lines: [
      { purchaseOrderId: first.id, amount: 100 },
      { purchaseOrderId: second.id, amount: 50 },
    ],
  }));
  expect(created.status, `建支出失败：${await created.clone().text()}`).toBe(201);
  const record = await jsonOf(created);
  expect(record.status).toBe('draft');
  expect(record.totalAmount).toBe(150);
  expect(record.lines).toHaveLength(2);
  expect(String(record.docNo)).toMatch(/^EXP-\d{8}-\d{4,}$/u);

  const confirmed = await finance.fetch(`/expenses/${String(record.id)}/confirm`, write());
  expect(confirmed.status, `登记失败：${await confirmed.clone().text()}`).toBe(200);
  const confirmedBody = await jsonOf(confirmed);
  expect(confirmedBody.status).toBe('confirmed');
  expect(confirmedBody.confirmedAt).not.toBeNull();
  for (const [order, amount] of [[first, 100], [second, 50]] as const) {
    const adminDetail = await jsonOf(await admin.fetch(`/purchase-orders/${String(order.id)}`, get()));
    expect(adminDetail.paidAmount).toBe(amount);
  }
  const voided = await finance.fetch(`/expenses/${String(record.id)}/void`, write());
  expect(voided.status).toBe(200);
  for (const [order] of [[first], [second]] as const) {
    expect((await jsonOf(await admin.fetch(`/purchase-orders/${String(order.id)}`, get()))).paidAmount).toBe(0);
  }
}, TIMEOUT);

test('到票：confirm:true 一步登记，按订单回写已到票金额', async ({ testApp, connection }) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const finance = await createFinanceUser(admin, testApp);
  const order = await payableOrder(admin, connection);
  await createDictEntry(connection, 'invoice_type', 'VAT');
  const created = await finance.fetch('/invoice-receipts', write({
    invoiceDate: '2026-11-28', bindMode: 'purchase_order', invoiceTypeCode: 'VAT',
    issuerName: '测试开票方', invoiceNo: 'INV-TEST-1',
    lines: [{ purchaseOrderId: order.id, amount: 70 }], confirm: true,
  }));
  expect(created.status, `一步到票失败：${await created.clone().text()}`).toBe(201);
  const record = await jsonOf(created);
  expect(record.status).toBe('confirmed');
  expect(String(record.docNo)).toMatch(/^RCV-\d{8}-\d{4,}$/u);
  const detail = await jsonOf(await admin.fetch(`/purchase-orders/${String(order.id)}`, get()));
  expect(detail.invoicedAmount).toBe(70);
  expect(detail.paidAmount).toBe(0);
}, TIMEOUT);

test('拒绝路径：订单状态、供应商混用、金额、草稿状态、作废与字典码', async ({
  testApp, connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const finance = await createFinanceUser(admin, testApp);
  const order = await payableOrder(admin, connection);
  const draft = await createOrder(admin, 'purchase', { lines: [{ itemId: await createItem(connection), qty: 1 }] });
  await createDictEntry(connection, 'fund_account', 'BANK-OFF', 'inactive');
  const reject = async (body: Row, reason: string): Promise<void> => {
    const response = await finance.fetch('/expenses', write(body));
    expect(response.status, `${reason}: ${await response.clone().text()}`).toBe(422);
    expect((await jsonOf(response)).error?.reason).toBe(reason);
  };
  const base = { expenseDate: '2026-11-28', bindMode: 'purchase_order' };
  await reject({ ...base, lines: [{ purchaseOrderId: draft.id, amount: 1 }] }, 'FINANCE_ORDER_NOT_PAYABLE');
  await reject({ ...base, lines: [{ purchaseOrderId: order.id, amount: 0 }] }, 'FINANCE_LINE_INVALID');
  await reject({ ...base, fundAccountCode: 'BANK-OFF', lines: [{ purchaseOrderId: order.id, amount: 1 }] }, 'FINANCE_DICT_CODE_INVALID');
  const other = await payableOrder(admin, connection);
  await reject({
    ...base,
    lines: [
      { purchaseOrderId: order.id, amount: 1 },
      { purchaseOrderId: other.id, amount: 1 },
    ],
  }, 'FINANCE_SUPPLIER_MIXED');

  const record = await jsonOf(await finance.fetch('/expenses', write({
    ...base, lines: [{ purchaseOrderId: order.id, amount: 5 }],
  })));
  await finance.fetch(`/expenses/${String(record.id)}/confirm`, write());
  const secondConfirm = await finance.fetch(`/expenses/${String(record.id)}/confirm`, write());
  expect(secondConfirm.status).toBe(422);
  expect((await jsonOf(secondConfirm)).error?.reason).toBe('FINANCE_NOT_DRAFT');
  const edit = await finance.fetch(`/expenses/${String(record.id)}`, write({ remark: 'x' }, 'PATCH'));
  expect((await jsonOf(edit)).error?.reason).toBe('FINANCE_NOT_DRAFT');
  const voided = await jsonOf(await finance.fetch(`/expenses/${String(record.id)}/void`, write()));
  expect(voided.status).toBe('void');
  const afterVoid = await finance.fetch(`/expenses/${String(record.id)}/confirm`, write());
  expect((await jsonOf(afterVoid)).error?.reason).toBe('FINANCE_VOIDED');
}, TIMEOUT);

test('重算不变量：同一订单两张支出记录，已支出金额是两笔之和，作废一张后只剩一笔', async ({
  testApp, connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const finance = await createFinanceUser(admin, testApp);
  const order = await payableOrder(admin, connection);
  for (const amount of [30, 45]) {
    const created = await finance.fetch('/expenses', write({
      expenseDate: '2026-11-28', bindMode: 'purchase_order',
      lines: [{ purchaseOrderId: order.id, amount }], confirm: true,
    }));
    expect(created.status).toBe(201);
  }
  expect((await jsonOf(await admin.fetch(`/purchase-orders/${String(order.id)}`, get()))).paidAmount).toBe(75);
  const list = await jsonOf(await finance.fetch('/expenses?status=confirmed', get()));
  const first = list.items!.find((item) => Number(item.totalAmount) === 30)!;
  expect((await jsonOf(await finance.fetch(`/expenses/${String(first.id)}/void`, write()))).status).toBe('void');
  expect((await jsonOf(await admin.fetch(`/purchase-orders/${String(order.id)}`, get()))).paidAmount).toBe(45);
}, TIMEOUT);

test('风险反向：两个真事务同时登记同一订单，paidAmount 等于两笔之和', async ({
  app, testApp, connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const finance = await createFinanceUser(admin, testApp);
  const order = await payableOrder(admin, connection);
  const database = app.container.resolve(databaseManagerToken);
  const mutations = app.container.resolve(financeMutationsToken);
  const knex = await database.connection().client<Knex>();
  const drafts: string[] = [];
  for (const amount of [20, 30]) {
    const created = await finance.fetch('/expenses', write({
      expenseDate: '2026-11-28', bindMode: 'purchase_order',
      lines: [{ purchaseOrderId: String(order.id), amount }],
    }));
    expect(created.status).toBe(201);
    drafts.push(String((await jsonOf(created)).id));
  }
  const firstWritten = Promise.withResolvers<void>();
  const releaseFirst = Promise.withResolvers<void>();
  const secondEntered = Promise.withResolvers<void>();

  // 两个草稿已经在库里；登记阶段只锁订单头，不碰发号器，争用的就是回写行锁。
  const first = database
    .transaction(async (tx) => {
      const result = await mutations.confirm('expense', drafts[0]!, 'finance-concurrency', tx);
      firstWritten.resolve();
      await releaseFirst.promise;
      return result;
    })
    .catch((error: unknown) => error);
  let second: Promise<unknown> | undefined;
  try {
    await firstWritten.promise;
    second = database
      .transaction(async (tx) => {
        secondEntered.resolve();
        return await mutations.confirm('expense', drafts[1]!, 'finance-concurrency', tx);
      })
      .then(() => null, (error: unknown) => error);
    await secondEntered.promise;
    const deadline = Date.now() + 15_000;
    let waiting = 0;
    while (Date.now() < deadline) {
      const result = await knex.raw(
        `select count(*)::int as waiting from pg_stat_activity
          where state = 'active' and wait_event_type = 'Lock'
            and query ilike '%purchase_orders%'`,
      );
      waiting = Number((result.rows ?? result)[0]?.waiting ?? 0);
      if (waiting > 0) break;
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
    expect(waiting, '前置：第二个事务应当真的排在订单行锁上').toBeGreaterThan(0);
  } finally {
    releaseFirst.resolve();
  }
  await first;
  const failure = second === undefined ? null : await second;
  expect(failure, '并发登记不能失败').toBeNull();
  const detail = await jsonOf(await admin.fetch(`/purchase-orders/${String(order.id)}`, get()));
  expect(detail.paidAmount).toBe(50);
}, TIMEOUT);
