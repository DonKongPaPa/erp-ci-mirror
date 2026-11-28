// @vitest-environment node
import { randomUUID } from 'node:crypto';

import {
  DEFAULT_ADMIN_CREDENTIALS,
  signIn,
  type TestSession,
} from '@nocobase/app-plugin-authentication/testing';
import { expect } from 'vitest';
import type { Knex } from 'knex';

import { createAppTest } from '../helpers/test-app.js';
import { createItem } from '../helpers/inventory.js';
import { createEmployee } from '../helpers/orders.js';
import {
  createOrder,
  createPartner,
  get,
  jsonOf,
  type Row,
  unique,
  write,
} from '../helpers/orders.js';
import { createStandaloneServer } from '../../server/standalone.js';
import {
  ReturnRuleError,
  returnsMutationsToken,
} from '../../server/providers/returns.js';

/**
 * R-020 波 2 加片二：采购退货与销售退货。
 *
 * 退货单是真实的单据：从来源行带出仓库、批次与数量；发起与过账分角色；过账生成一张
 * 既有路径的出入库单并冲减订单已收 / 已发。数量上限、重复过账、作废与并发都在真库上验。
 */
const test = createAppTest({
  createServer: createStandaloneServer,
  config: {
    app: { publicOrigin: 'http://localhost' },
    auth: { secret: 'test-auth-secret-at-least-32-characters' },
  },
});

const PASSWORD = 'R020-returns-123!';

async function makeRoleUser(
  admin: TestSession,
  testApp: Parameters<typeof signIn>[0],
  name: string,
  role: string,
  connectionFromFixture: Parameters<typeof createEmployee>[0],
): Promise<TestSession> {
  const username = unique(name);
  const created = await admin.fetch('/users', write({
    name: username,
    username,
    email: `${username.toLowerCase()}@example.test`,
    password: PASSWORD,
    roleScopes: { app: [role] },
  }));
  expect(created.status, `建 ${role} 用户失败：${await created.clone().text()}`).toBe(201);
  const body = await jsonOf(created);
  const userId = String((body.data as Row | undefined)?.id ?? body.id ?? '');
  await createEmployee(connectionFromFixture, userId);
  return await signIn(testApp, { username, password: PASSWORD });
}

/** 建一张已过账的出入库单，返回单据 id、来源行 id 与订单行 id。 */
async function postedSource(
  admin: TestSession,
  kind: 'purchase' | 'sales',
  itemId: string,
  warehouseId: string,
  qty: number,
): Promise<{ docId: string; sourceLineId: string; orderId: string; orderLineId: string }> {
  const partner = await createPartner(admin, kind === 'purchase'
    ? { isSupplier: true } : { isCustomer: true });
  const order = await createOrder(admin, kind, {
    ...(kind === 'purchase' ? { supplierId: partner.id } : { customerId: partner.id }),
    lines: [{ itemId, qty, price: 113, taxRate: 13, deliveryDate: '2026-12-01' }],
  });
  const orderId = String(order.id);
  expect((await admin.fetch(`/${kind}-orders/${orderId}/submit`, write())).status).toBe(200);
  const generated = await admin.fetch(`/${kind}-orders/${orderId}/${kind === 'purchase' ? 'create-receipt' : 'create-issue'}`, write({ warehouseId }));
  expect(generated.status, `生成来源单据失败：${await generated.clone().text()}`).toBe(201);
  const doc = await jsonOf(generated);
  const docId = String(doc.id);
  expect((await admin.fetch(`/stock-docs/${docId}/post`, write())).status).toBe(200);
  const detail = await jsonOf(await admin.fetch(`/stock-docs/${docId}`, get()));
  const orderLineId = String(((order.lines ?? []) as Row[])[0]?.id);
  expect(orderLineId, '订单行 id').not.toBe('');
  return {
    docId,
    sourceLineId: String(((detail.lines ?? []) as Row[])[0]?.id),
    orderId,
    orderLineId,
  };
}

async function createReturn(
  session: TestSession,
  kind: 'purchase' | 'sales',
  sourceId: string,
  sourceLineId: string,
  returnQty: number,
): Promise<{ status: number; body: Row }> {
  const path = kind === 'purchase' ? '/purchase-returns' : '/sales-returns';
  const response = await session.fetch(path, write({
    sourceType: 'stock_doc',
    sourceId,
    lines: [{ sourceLineId, returnQty }],
  }));
  return { status: response.status, body: await jsonOf(response) };
}

async function createOrderReturn(
  session: TestSession,
  kind: 'purchase' | 'sales',
  orderId: string,
  orderLineId: string,
  warehouseId: string,
  returnQty: number,
): Promise<{ status: number; body: Row }> {
  const path = kind === 'purchase' ? '/purchase-returns' : '/sales-returns';
  const response = await session.fetch(path, write({
    sourceType: 'order',
    sourceId: orderId,
    lines: [{ sourceLineId: orderLineId, returnQty, warehouseId }],
  }));
  return { status: response.status, body: await jsonOf(response) };
}

test('采购退货：过账生成出库单、库存与流水减少、订单已收数量冲减', async ({
  testApp, connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const buyer = await makeRoleUser(admin, testApp, 'r020buyer', 'purchase', connection);
  const keeper = await makeRoleUser(admin, testApp, 'r020keeper', 'warehouse', connection);
  const warehouseId = String((await jsonOf(await admin.fetch('/warehouses', write({
    code: unique('WH'), name: '退货仓',
  })))).id);
  const itemId = await createItem(connection);
  const source = await postedSource(admin, 'purchase', itemId, warehouseId, 10);

  const created = await createReturn(buyer, 'purchase', source.docId, source.sourceLineId, 3);
  expect(created.status, `采购退货建单失败：${JSON.stringify(created.body)}`).toBe(201);
  const returnId = String(created.body.id);
  expect(created.body.status).toBe('draft');
  expect(created.body.docNo).toMatch(/^TH-\d{8}-\d{4}$/u);
  expect(created.body.partner).toBeDefined();
  expect(created.body.handler).toEqual({ userId: String((created.body.handler as Row).userId), name: expect.any(String) });

  const posted = await keeper.fetch(`/purchase-returns/${returnId}/post`, write());
  expect(posted.status, `采购退货过账失败：${await posted.clone().text()}`).toBe(200);
  const result = await jsonOf(posted);
  const stockDocId = String(result.stockDocId);
  const generated = await jsonOf(await admin.fetch(`/stock-docs/${stockDocId}`, get()));
  expect(generated).toMatchObject({ docType: 'out', reason: 'purchase_return', status: 'posted', returnDocId: returnId });
  expect(((generated.lines ?? []) as Row[])[0]).toMatchObject({ itemId, warehouseId, qty: 3 });

  const balance = await connection.repository<Row>('stockBalances').findOne({
    filter: { itemId, warehouseId, batchNo: '' },
  });
  expect(Number(balance?.qty)).toBe(7);
  const transactions = await connection.repository<Row>('stockTransactions').findMany({
    filter: { docId: stockDocId },
  });
  expect(transactions).toHaveLength(1);
  expect(Number(transactions[0]?.qtyDelta)).toBe(-3);
  expect(Number(transactions[0]?.balanceAfter)).toBe(7);

  const orderLine = await connection.repository<Row>('purchaseOrderLines').findOne({
    filter: { id: source.orderLineId },
  });
  expect(Number(orderLine?.receivedQty)).toBe(7);
}, 60_000);

test('销售退货：过账生成入库单、库存与流水增加、订单已发数量冲减', async ({
  testApp, connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const seller = await makeRoleUser(admin, testApp, 'r020seller', 'sales', connection);
  const keeper = await makeRoleUser(admin, testApp, 'r020keeper2', 'warehouse', connection);
  const warehouseId = String((await jsonOf(await admin.fetch('/warehouses', write({
    code: unique('WH'), name: '销售退货仓',
  })))).id);
  const itemId = await createItem(connection);
  // 销售出库要有现存量：先手工入库 10（不带来源）。
  const inbound = await admin.fetch('/stock-docs', write({
    docType: 'in', reason: 'purchase_receipt', lines: [{ itemId, warehouseId, qty: 10 }],
  }));
  expect(inbound.status).toBe(201);
  expect((await admin.fetch(`/stock-docs/${String((await jsonOf(inbound)).id)}/post`, write())).status).toBe(200);
  const source = await postedSource(admin, 'sales', itemId, warehouseId, 10);

  const created = await createReturn(seller, 'sales', source.docId, source.sourceLineId, 3);
  expect(created.status, `销售退货建单失败：${JSON.stringify(created.body)}`).toBe(201);
  const posted = await keeper.fetch(`/sales-returns/${String(created.body.id)}/post`, write());
  expect(posted.status, `销售退货过账失败：${await posted.clone().text()}`).toBe(200);
  const stockDocId = String((await jsonOf(posted)).stockDocId);
  const generated = await jsonOf(await admin.fetch(`/stock-docs/${stockDocId}`, get()));
  expect(generated).toMatchObject({ docType: 'in', reason: 'sales_return', status: 'posted' });

  const balance = await connection.repository<Row>('stockBalances').findOne({
    filter: { itemId, warehouseId, batchNo: '' },
  });
  expect(Number(balance?.qty)).toBe(3);
  const transactions = await connection.repository<Row>('stockTransactions').findMany({
    filter: { docId: stockDocId },
  });
  expect(Number(transactions[0]?.qtyDelta)).toBe(3);
  const orderLine = await connection.repository<Row>('salesOrderLines').findOne({
    filter: { id: source.orderLineId },
  });
  expect(Number(orderLine?.shippedQty)).toBe(7);
}, 60_000);

test('数量上限、作废后重退、重复过账与已过账不许作废', async ({ testApp, connection }) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const buyer = await makeRoleUser(admin, testApp, 'r020buyer2', 'purchase', connection);
  const keeper = await makeRoleUser(admin, testApp, 'r020keeper3', 'warehouse', connection);
  const warehouseId = String((await jsonOf(await admin.fetch('/warehouses', write({
    code: unique('WH'), name: '上限仓',
  })))).id);
  const itemId = await createItem(connection);
  const source = await postedSource(admin, 'purchase', itemId, warehouseId, 10);

  const first = await createReturn(buyer, 'purchase', source.docId, source.sourceLineId, 3);
  expect(first.status).toBe(201);
  const exceeded = await createReturn(buyer, 'purchase', source.docId, source.sourceLineId, 8);
  expect(exceeded.status).toBe(422);
  expect((exceeded.body.error as Row)?.reason).toBe('RETURN_QTY_EXCEED');

  // 页面片：作废原因由页面必填，服务端把它附在备注里留痕；老客户端不带原因仍照旧作废。
  const voided = await buyer.fetch(
    `/purchase-returns/${String(first.body.id)}/void`,
    write({ reason: 'Quality check failed' }),
  );
  expect(voided.status).toBe(200);
  expect(String((await jsonOf(voided)).remark ?? '')).toContain('Quality check failed');
  const again = await createReturn(buyer, 'purchase', source.docId, source.sourceLineId, 8);
  expect(again.status, `作废后重退失败：${JSON.stringify(again.body)}`).toBe(201);
  const returnId = String(again.body.id);

  const firstPost = await keeper.fetch(`/purchase-returns/${returnId}/post`, write());
  expect(firstPost.status).toBe(200);
  const secondPost = await keeper.fetch(`/purchase-returns/${returnId}/post`, write());
  expect(secondPost.status).toBe(422);
  expect(((await jsonOf(secondPost)).error as Row)?.reason).toBe('RETURN_NOT_DRAFT');
  const voidPosted = await buyer.fetch(`/purchase-returns/${returnId}/void`, write());
  expect(voidPosted.status).toBe(422);
  expect(((await jsonOf(voidPosted)).error as Row)?.reason).toBe('RETURN_NOT_DRAFT');
  const deleted = await admin.fetch(`/purchase-returns/${returnId}`, { method: 'DELETE', headers: { origin: 'http://localhost' } });
  expect([404, 405]).toContain(deleted.status);

  // 部分唯一索引：同一 returnDocId 直接插第二条必须被数据库拒绝。
  const stockDocId = String((await jsonOf(firstPost)).stockDocId);
  const duplicate = `sd-dup-${randomUUID()}`;
  await expect(connection.query.insertInto('stock_docs').values({
    id: duplicate,
    doc_no: `CK-DUP-${randomUUID().slice(0, 8)}`,
    doc_type: 'out',
    reason: 'purchase_return',
    status: 'draft',
    created_by_id: 'returns-test',
    created_at: new Date(),
    updated_at: new Date(),
    returnDocId: returnId,
  }).execute()).rejects.toThrow();
  const generated = await connection.repository<Row>('stockDocs').findOne({ filter: { id: stockDocId } });
  expect(generated?.returnDocId).toBe(returnId);
}, 60_000);

test('从订单直接退货：仓库必填、按订单行带入并冲减已收数量', async ({ testApp, connection }) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const buyer = await makeRoleUser(admin, testApp, 'r020buyer3', 'purchase', connection);
  const keeper = await makeRoleUser(admin, testApp, 'r020keeper4', 'warehouse', connection);
  const warehouseId = String((await jsonOf(await admin.fetch('/warehouses', write({
    code: unique('WH'), name: '订单退货仓',
  })))).id);
  const itemId = await createItem(connection);
  const source = await postedSource(admin, 'purchase', itemId, warehouseId, 10);
  const withoutWarehouse = await buyer.fetch('/purchase-returns', write({
    sourceType: 'order',
    sourceId: source.orderId,
    lines: [{ sourceLineId: source.orderLineId, returnQty: 1 }],
  }));
  expect(withoutWarehouse.status).toBe(404);
  const created = await buyer.fetch('/purchase-returns', write({
    sourceType: 'order',
    sourceId: source.orderId,
    lines: [{ sourceLineId: source.orderLineId, returnQty: 2, warehouseId }],
  }));
  expect(created.status, `从订单退货失败：${await created.clone().text()}`).toBe(201);
  const body = await jsonOf(created);
  expect(body.lines?.[0]).toMatchObject({ itemId, warehouseId, batchNo: '', qty: 10, returnQty: 2 });
  expect((await keeper.fetch(`/purchase-returns/${String(body.id)}/post`, write())).status).toBe(200);
  const orderLine = await connection.repository<Row>('purchaseOrderLines').findOne({
    filter: { id: source.orderLineId },
  });
  expect(Number(orderLine?.receivedQty)).toBe(8);
}, 60_000);

test('来源选项与财务窄形状：只回声明的列', async ({ testApp, connection }) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const buyer = await makeRoleUser(admin, testApp, 'r020buyer4', 'purchase', connection);
  const seller = await makeRoleUser(admin, testApp, 'r020seller4', 'sales', connection);
  const finance = await makeRoleUser(admin, testApp, 'r020finance4', 'finance', connection);
  const keeper = await makeRoleUser(admin, testApp, 'r020keeper5', 'warehouse', connection);
  const warehouseId = String((await jsonOf(await admin.fetch('/warehouses', write({
    code: unique('WH'), name: '窄形状仓',
  })))).id);
  const itemId = await createItem(connection);
  const purchase = await postedSource(admin, 'purchase', itemId, warehouseId, 10);
  const inbound = await admin.fetch('/stock-docs', write({
    docType: 'in', reason: 'other_in', lines: [{ itemId, warehouseId, qty: 10 }],
  }));
  expect(inbound.status).toBe(201);
  expect((await admin.fetch(`/stock-docs/${String((await jsonOf(inbound)).id)}/post`, write())).status).toBe(200);
  const sales = await postedSource(admin, 'sales', itemId, warehouseId, 10);

  const options = await jsonOf(await buyer.fetch('/purchase-returns/source-options', get()));
  expect(options.items?.length).toBeGreaterThan(0);
  const option = (options.items as Row[]).find((row) => row.id === purchase.docId);
  expect(option).toMatchObject({ id: purchase.docId, docNo: expect.any(String) });
  expect(Object.keys(option ?? {})).toEqual(['id', 'docNo', 'docDate', 'partner', 'lines']);
  expect(Object.keys(((option?.lines as Row[])[0] ?? {}))).toEqual([
    'sourceLineId', 'itemId', 'warehouseId', 'batchNo', 'remainQty',
  ]);

  const saleReturn = await createReturn(seller, 'sales', sales.docId, sales.sourceLineId, 4);
  expect(saleReturn.status).toBe(201);
  expect((await keeper.fetch(`/sales-returns/${String(saleReturn.body.id)}/post`, write())).status).toBe(200);
  const financeResponse = await finance.fetch('/sales-returns/finance-options', get());
  expect(financeResponse.status).toBe(200);
  const financeBody = await jsonOf(financeResponse);
  expect(financeBody.items?.length).toBeGreaterThan(0);
  const narrow = (financeBody.items as Row[]).find((row) => row.id === saleReturn.body.id);
  expect(narrow).toBeDefined();
  expect(Object.keys(narrow ?? {}).sort()).toEqual([
    'customerId', 'docNo', 'id', 'lines', 'returnDate', 'status',
  ]);
  expect(Object.keys(((narrow?.lines as Row[])[0] ?? {})).sort()).toEqual(['itemId', 'qty']);

  const detail = await jsonOf(await seller.fetch(`/sales-returns/${String(saleReturn.body.id)}`, get()));
  for (const key of ['createdById', 'storageKey', 'postedById', 'price', 'email', 'phone']) {
    expect(Object.keys(detail)).not.toContain(key);
  }
  expect(detail.handler).toEqual({ userId: String((detail.handler as Row).userId), name: expect.any(String) });
  const line = (detail.lines as Row[])[0]!;
  expect(Object.keys(line.item as Row).sort()).toEqual(['code', 'id', 'name', 'spec', 'unitCode']);
}, 60_000);

/** 两个真事务：第一个过账后扣住，第二个停在来源行锁上；等到真的等锁才放行。 */
async function waitForSourceLineLock(
  connection: { client<T>(): Promise<T> },
): Promise<number> {
  const knex = await connection.client<Knex>();
  const deadline = Date.now() + 15_000;
  let waiting = 0;
  while (Date.now() < deadline) {
    const result = await knex.raw(
      `select count(*)::int as waiting from pg_stat_activity
        where state = 'active' and wait_event_type = 'Lock'
          and query ilike '%from stock_doc_lines%'`,
    );
    waiting = Number((result.rows ?? result)[0]?.waiting ?? 0);
    if (waiting > 0) return waiting;
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  return waiting;
}

test('并发：两张退货单同时过账，合计超过来源行可退量时只有一张成功', async ({
  app, database, connection, testApp,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const buyer = await makeRoleUser(admin, testApp, 'r020buyer5', 'purchase', connection);
  const warehouseId = String((await jsonOf(await admin.fetch('/warehouses', write({
    code: unique('WH'), name: '退货并发仓',
  })))).id);
  const itemId = await createItem(connection);
  const source = await postedSource(admin, 'purchase', itemId, warehouseId, 10);
  const ids: string[] = [];
  for (const qty of [4, 4]) {
    const created = await createReturn(buyer, 'purchase', source.docId, source.sourceLineId, qty);
    expect(created.status).toBe(201);
    ids.push(String(created.body.id));
  }
  // 绕过建单校验模拟并发建单竞态：两张草稿合计 11，超过来源行的 10。
  await database.transaction(async (tx) => {
    const txKnex = await tx.client<Knex>();
    await txKnex('return_doc_lines').where({ doc_id: ids[1] }).update({ return_qty: 7 });
  });


  const mutations = app.container.resolve(returnsMutationsToken);
  const written = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  let second: Promise<unknown> | undefined;
  const first = database.transaction(async (tx) => {
    await mutations.post('purchase', ids[0]!, 'returns-concurrency', tx);
    written.resolve();
    await release.promise;
  }).catch((error: unknown) => error);
  try {
    await written.promise;
    second = database.transaction(async (tx) => {
      entered.resolve();
      await mutations.post('purchase', ids[1]!, 'returns-concurrency', tx);
    }).then(() => null, (error: unknown) => error);
    await entered.promise;
    expect(
      await waitForSourceLineLock(connection),
      '第二个事务没有停在来源行锁上，不能证明并发',
    ).toBeGreaterThan(0);
  } finally {
    release.resolve();
  }
  await first;
  const failure = second === undefined ? null : await second;
  expect(failure, '第二个过账必须被拒绝').toBeInstanceOf(ReturnRuleError);
  expect((failure as ReturnRuleError).code).toBe('qty-exceed');
  for (const [index, id] of ids.entries()) {
    const row = await connection.repository<Row>('returnDocs').findOne({ filter: { id } });
    expect(row?.status).toBe(index === 0 ? 'posted' : 'draft');
  }
  const orderLine = await connection.repository<Row>('purchaseOrderLines').findOne({
    filter: { id: source.orderLineId },
  });
  expect(Number(orderLine?.receivedQty)).toBe(6);
}, 60_000);


/** 订单行的进度已是净值：已过账退货不能再从「可退数量」里扣第二次。 */
async function orderReturnSequence(
  testApp: Parameters<typeof signIn>[0],
  connection: Parameters<typeof createEmployee>[0],
  kind: 'purchase' | 'sales',
): Promise<void> {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const initiator = await makeRoleUser(
    admin, testApp, kind === 'purchase' ? 'r020netbuyer' : 'r020netseller',
    kind === 'purchase' ? 'purchase' : 'sales', connection,
  );
  const keeper = await makeRoleUser(admin, testApp, 'r020netkeeper', 'warehouse', connection);
  const warehouseId = String((await jsonOf(await admin.fetch('/warehouses', write({
    code: unique('WH'), name: '订单净额仓',
  })))).id);
  const itemId = await createItem(connection);
  if (kind === 'sales') {
    const inbound = await admin.fetch('/stock-docs', write({
      docType: 'in', reason: 'purchase_receipt', lines: [{ itemId, warehouseId, qty: 10 }],
    }));
    expect(inbound.status).toBe(201);
    expect((await admin.fetch(`/stock-docs/${String((await jsonOf(inbound)).id)}/post`, write())).status).toBe(200);
  }
  const source = await postedSource(admin, kind, itemId, warehouseId, 10);
  const table = kind === 'purchase' ? 'purchaseOrderLines' : 'salesOrderLines';
  const column = kind === 'purchase' ? 'receivedQty' : 'shippedQty';
  const readProgress = async (): Promise<number> => {
    const row = await connection.repository<Row>(table).findOne({ filter: { id: source.orderLineId } });
    return Number(row?.[column]);
  };
  expect(await readProgress()).toBe(10);

  const first = await createOrderReturn(initiator, kind, source.orderId, source.orderLineId, warehouseId, 3);
  expect(first.status, `首单失败：${JSON.stringify(first.body)}`).toBe(201);
  expect((await keeper.fetch(`/${kind}-returns/${String(first.body.id)}/post`, write())).status).toBe(200);
  expect(await readProgress()).toBe(7);

  const seven = await createOrderReturn(initiator, kind, source.orderId, source.orderLineId, warehouseId, 7);
  expect(seven.status, `退 7 应成功：${JSON.stringify(seven.body)}`).toBe(201);
  const eight = await createOrderReturn(initiator, kind, source.orderId, source.orderLineId, warehouseId, 8);
  expect(eight.status, '净值 7 时退 8 应被拒').toBe(422);
  expect((eight.body.error as Row)?.reason).toBe('RETURN_QTY_EXCEED');
  expect((await keeper.fetch(`/${kind}-returns/${String(seven.body.id)}/post`, write())).status).toBe(200);
  expect(await readProgress()).toBe(0);

  const more = await createOrderReturn(initiator, kind, source.orderId, source.orderLineId, warehouseId, 1);
  expect(more.status, '净值 0 时退 1 应被拒').toBe(422);
  expect((more.body.error as Row)?.reason).toBe('RETURN_QTY_EXCEED');
}

test('从采购订单退货：已过账退货不重复扣减，净值 10→7→0', async ({ testApp, connection }) => {
  await orderReturnSequence(testApp, connection, 'purchase');
}, 60_000);

test('从销售订单退货：已过账退货不重复扣减，净值 10→7→0', async ({ testApp, connection }) => {
  await orderReturnSequence(testApp, connection, 'sales');
}, 60_000);

async function waitForOrderLineLock(
  connection: Parameters<typeof waitForSourceLineLock>[0],
): Promise<number> {
  const knex = await connection.client<Knex>();
  const deadline = Date.now() + 15_000;
  let waiting = 0;
  while (Date.now() < deadline) {
    const result = await knex.raw(
      `select count(*)::int as waiting from pg_stat_activity
        where state = 'active' and wait_event_type = 'Lock'
          and query ilike '%from purchase_order_lines%'`,
    );
    waiting = Number((result.rows ?? result)[0]?.waiting ?? 0);
    if (waiting > 0) return waiting;
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  return waiting;
}

test('并发：两张从订单发起的退货草稿同时过账，只有一张成功', async ({
  app, database, connection, testApp,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const buyer = await makeRoleUser(admin, testApp, 'r020netconbuyer', 'purchase', connection);
  const warehouseId = String((await jsonOf(await admin.fetch('/warehouses', write({
    code: unique('WH'), name: '订单退货并发仓',
  })))).id);
  const itemId = await createItem(connection);
  const source = await postedSource(admin, 'purchase', itemId, warehouseId, 10);
  const ids: string[] = [];
  for (const qty of [6, 4]) {
    const created = await createOrderReturn(
      buyer, 'purchase', source.orderId, source.orderLineId, warehouseId, qty,
    );
    expect(created.status, `建草稿失败：${JSON.stringify(created.body)}`).toBe(201);
    ids.push(String(created.body.id));
  }
  // 绕过建单校验模拟并发建单竞态：两张草稿合计 12，超过订单净值 10。
  await database.transaction(async (tx) => {
    const txKnex = await tx.client<Knex>();
    await txKnex('return_doc_lines').where({ doc_id: ids[1] }).update({ return_qty: 6 });
  });

  const mutations = app.container.resolve(returnsMutationsToken);
  const written = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  let second: Promise<unknown> | undefined;
  const first = database.transaction(async (tx) => {
    await mutations.post('purchase', ids[0]!, 'order-returns-concurrency', tx);
    written.resolve();
    await release.promise;
  }).catch((error: unknown) => error);
  try {
    await written.promise;
    second = database.transaction(async (tx) => {
      entered.resolve();
      await mutations.post('purchase', ids[1]!, 'order-returns-concurrency', tx);
    }).then(() => null, (error: unknown) => error);
    await entered.promise;
    expect(
      await waitForOrderLineLock(connection),
      '第二个事务没有停在订单行锁上，不能证明并发',
    ).toBeGreaterThan(0);
  } finally {
    release.resolve();
  }
  await first;
  const failure = second === undefined ? null : await second;
  expect(failure, '第二个过账必须被拒绝').toBeInstanceOf(ReturnRuleError);
  expect((failure as ReturnRuleError).code).toBe('qty-exceed');
  for (const [index, id] of ids.entries()) {
    const row = await connection.repository<Row>('returnDocs').findOne({ filter: { id } });
    expect(row?.status).toBe(index === 0 ? 'posted' : 'draft');
  }
  const orderLine = await connection.repository<Row>('purchaseOrderLines').findOne({
    filter: { id: source.orderLineId },
  });
  expect(Number(orderLine?.receivedQty)).toBe(4);
}, 60_000);
