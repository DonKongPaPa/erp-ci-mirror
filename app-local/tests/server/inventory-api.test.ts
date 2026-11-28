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
import {
  createDictEntry, createEmployee, createOrder, createPartner, makeRoleUser,
} from '../helpers/orders.js';
import { createStandaloneServer } from '../../server/standalone.js';

/**
 * R-020 端点：建单自动取号、草稿改明细、过账改存量写流水、出库不够整单回滚、
 * 作废、已过账不许改、查询过滤，以及没有删除。
 * 每条断言都从真库读回写入结果；数量是 decimal，读回统一断言成 number。
 */
const test = createAppTest({
  createServer: createStandaloneServer,
  config: {
    app: { publicOrigin: 'http://localhost' },
    auth: { secret: 'test-auth-secret-at-least-32-characters' },
  },
});

const ORIGIN = 'http://localhost';
const unique = (prefix: string) =>
  `${prefix}${randomUUID().replaceAll('-', '').slice(0, 10).toUpperCase()}`;
const write = (body: unknown = {}, method = 'POST'): RequestInit => ({
  method,
  headers: {
    'content-type': 'application/json',
    origin: ORIGIN,
    'Idempotency-Key': `${Date.now()}.${randomUUID()}`,
  },
  body: JSON.stringify(body),
});
const get = (): RequestInit => ({ method: 'GET' });

interface Row {
  [key: string]: unknown;
}
type JsonBody = Row & {
  items?: Row[];
  total?: number;
  error?: { reason: string };
};
const jsonOf = async (response: Response): Promise<JsonBody> =>
  (await response.json()) as JsonBody;

async function createWarehouse(session: TestSession, code = unique('WH')): Promise<Row> {
  const response = await session.fetch('/warehouses', write({ code, name: '测试仓' }));
  expect(response.status, `建仓库失败：${await response.clone().text()}`).toBe(201);
  return await jsonOf(response);
}

async function createInbound(
  session: TestSession,
  itemId: string,
  warehouseId: string,
  qty: number,
  batchNo = '',
): Promise<Row> {
  const response = await session.fetch('/stock-docs', write({
    docType: 'in',
    reason: 'purchase_receipt',
    lines: [{ itemId, warehouseId, batchNo, qty }],
  }));
  expect(response.status, `建入库单失败：${await response.clone().text()}`).toBe(201);
  return await jsonOf(response);
}

async function createOutbound(
  session: TestSession,
  itemId: string,
  warehouseId: string,
  qty: number,
  batchNo = '',
): Promise<Row> {
  // R1（设计新加的约束）：销售出库过账要有来源；这里备一张量足够的销售订单。
  const customer = await createPartner(session, { isCustomer: true });
  const order = await createOrder(session, 'sales', {
    customerId: customer.id,
    lines: [{ itemId, qty: qty + 1000 }],
  });
  const submitted = await session.fetch(`/sales-orders/${String(order.id)}/submit`, write());
  expect(submitted.status, `提交来源订单失败：${await submitted.clone().text()}`).toBe(200);
  const response = await session.fetch('/stock-docs', write({
    docType: 'out',
    reason: 'sales_issue',
    sourceType: 'sales_order',
    sourceId: String(order.id),
    lines: [{ itemId, warehouseId, batchNo, qty }],
  }));
  expect(response.status, `建出库单失败：${await response.clone().text()}`).toBe(201);
  return await jsonOf(response);
}

const balanceOf = async (
  connection: { repository<T>(name: string): { findOne(options: unknown): Promise<T | undefined> } },
  itemId: string,
  warehouseId: string,
): Promise<number> => {
  const row = await connection.repository<Row>('stockBalances').findOne({
    filter: { itemId, warehouseId, batchNo: '' },
  });
  return row === undefined ? 0 : Number(row.qty);
};

test('建单自动取号：RK/CK 前缀带日期，明细整单写入', async ({ testApp, connection }) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const warehouse = await createWarehouse(admin);
  const itemId = await createItem(connection);
  const inbound = await createInbound(admin, itemId, String(warehouse.id), 12.5);
  expect(String(inbound.docNo)).toMatch(/^RK-\d{8}-\d{4,}$/u);
  expect(inbound).toMatchObject({ docType: 'in', status: 'draft' });
  expect(String(inbound.remark)).toBe('');
  expect(inbound.sourceType).toBeNull();
  expect(inbound.lines).toHaveLength(1);
  expect(inbound.lines?.[0]).toMatchObject({ itemId, warehouseId: warehouse.id, qty: 12.5 });

  const outbound = await createOutbound(admin, itemId, String(warehouse.id), 3);
  expect(String(outbound.docNo)).toMatch(/^CK-\d{8}-\d{4,}$/u);
  expect(String(outbound.docNo)).not.toBe(inbound.docNo);

  const stored = await connection
    .repository<Row>('stockDocLines')
    .findMany({ filter: { docId: inbound.id } });
  expect(stored).toHaveLength(1);
});

test('草稿改明细是整单替换；已过账不许改、不许作废，也没有删除', async ({
  testApp,
  connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const warehouse = await createWarehouse(admin);
  const itemA = await createItem(connection);
  const itemB = await createItem(connection);
  const doc = await createInbound(admin, itemA, String(warehouse.id), 5);
  const docId = String(doc.id);

  const patched = await admin.fetch(`/stock-docs/${docId}`, write({
    remark: '改过的备注',
    lines: [{ itemId: itemB, warehouseId: warehouse.id, batchNo: 'B1', qty: 7 }],
  }, 'PATCH'));
  expect(patched.status, `改草稿失败：${await patched.clone().text()}`).toBe(200);
  const body = await jsonOf(patched);
  expect(body).toMatchObject({ remark: '改过的备注' });
  expect(body.lines).toHaveLength(1);
  expect(body.lines?.[0]).toMatchObject({ itemId: itemB, batchNo: 'B1', qty: 7 });
  expect(
    await connection.repository<Row>('stockDocLines').findMany({ filter: { docId } }),
  ).toHaveLength(1);

  const posted = await admin.fetch(`/stock-docs/${docId}/post`, write());
  expect(posted.status, `过账失败：${await posted.clone().text()}`).toBe(200);
  expect((await jsonOf(posted)).status).toBe('posted');

  for (const [path, label] of [
    [`PATCH`, '改'],
    ['post', '再过账'],
    ['void', '作废'],
  ] as const) {
    const response = await admin.fetch(
      `/stock-docs/${docId}${path === 'PATCH' ? '' : `/${path}`}`,
      path === 'PATCH'
        ? write({ remark: '还想改' }, 'PATCH')
        : write(),
    );
    expect(response.status, `${label}已过账单据应当被拒`).toBe(422);
    expect((await jsonOf(response)).error?.reason).toBe('STOCK_DOC_NOT_DRAFT');
  }
  const removed = await admin.fetch(`/stock-docs/${docId}`, {
    method: 'DELETE',
    headers: { origin: ORIGIN },
  });
  expect([404, 405]).toContain(removed.status);
  expect((await admin.fetch(`/stock-docs/${docId}`, get())).status).toBe(200);
});

test('过账改现存量并写流水（带过账后余额）；出库不够 422 且整单回滚', async ({
  testApp,
  connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const warehouse = await createWarehouse(admin);
  const itemId = await createItem(connection);
  const wh = String(warehouse.id);

  const inbound = await createInbound(admin, itemId, wh, 100);
  const postedIn = await admin.fetch(`/stock-docs/${String(inbound.id)}/post`, write());
  expect(postedIn.status, `入库过账失败：${await postedIn.clone().text()}`).toBe(200);
  expect(await balanceOf(connection, itemId, wh)).toBe(100);

  const transactions = await connection
    .repository<Row>('stockTransactions')
    .findMany({ filter: { docId: inbound.id } });
  expect(transactions).toHaveLength(1);
  expect(Number(transactions[0]?.qtyDelta)).toBe(100);
  expect(Number(transactions[0]?.balanceAfter)).toBe(100);
  expect(transactions[0]?.docNo).toBe(inbound.docNo);
  expect(transactions[0]?.byUserId).toBeDefined();

  const out = await createOutbound(admin, itemId, wh, 40);
  const postedOut = await admin.fetch(`/stock-docs/${String(out.id)}/post`, write());
  expect(postedOut.status).toBe(200);
  expect(await balanceOf(connection, itemId, wh)).toBe(60);
  const outTransactions = await connection
    .repository<Row>('stockTransactions')
    .findMany({ filter: { docId: out.id } });
  expect(outTransactions).toHaveLength(1);
  expect(Number(outTransactions[0]?.qtyDelta)).toBe(-40);
  expect(Number(outTransactions[0]?.balanceAfter)).toBe(60);

  const beforeCount = await connection.repository<Row>('stockTransactions').count();
  const tooMuch = await createOutbound(admin, itemId, wh, 61);
  const rejected = await admin.fetch(`/stock-docs/${String(tooMuch.id)}/post`, write());
  expect(rejected.status).toBe(422);
  expect((await jsonOf(rejected)).error?.reason).toBe('STOCK_INSUFFICIENT');
  expect(await balanceOf(connection, itemId, wh), '整单回滚后存量不变').toBe(60);
  expect(
    await connection.repository<Row>('stockTransactions').count(),
    '整单回滚后不留下流水',
  ).toBe(beforeCount);
  const stillDraft = await connection.repository<Row>('stockDocs').findOne({
    filter: { id: tooMuch.id },
  });
  expect(stillDraft?.status).toBe('draft');
});

test('作废只改状态不写流水；草稿不许作废两次', async ({ testApp, connection }) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const warehouse = await createWarehouse(admin);
  const itemId = await createItem(connection);
  const doc = await createInbound(admin, itemId, String(warehouse.id), 4);
  const docId = String(doc.id);
  const beforeCount = await connection.repository<Row>('stockTransactions').count();

  const voided = await admin.fetch(`/stock-docs/${docId}/void`, write());
  expect(voided.status, `作废失败：${await voided.clone().text()}`).toBe(200);
  expect((await jsonOf(voided)).status).toBe('void');
  expect(await connection.repository<Row>('stockTransactions').count()).toBe(beforeCount);
  expect(await balanceOf(connection, String(doc.lines?.[0]?.itemId), String(warehouse.id))).toBe(0);

  const again = await admin.fetch(`/stock-docs/${docId}/void`, write());
  expect(again.status).toBe(422);
  expect((await jsonOf(again)).error?.reason).toBe('STOCK_DOC_NOT_DRAFT');
});

test('列表过滤与详情带明细；明细为空、数量非正、停用仓库、理由不配都被拒', async ({
  testApp,
  connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const warehouse = await createWarehouse(admin);
  const wh = String(warehouse.id);
  const itemId = await createItem(connection);
  const doc = await createInbound(admin, itemId, wh, 8, 'B7');

  const list = await jsonOf(await admin.fetch('/stock-docs?docType=in&status=draft&page=1&pageSize=5', get()));
  expect(list.items?.map((row) => String(row.id))).toContain(String(doc.id));
  expect(list).toMatchObject({ page: 1, pageSize: 5 });
  expect(list.items?.some((row) => 'lines' in row)).toBe(false);
  const detail = await jsonOf(await admin.fetch(`/stock-docs/${String(doc.id)}`, get()));
  expect(detail.lines).toHaveLength(1);

  const balances = await jsonOf(await admin.fetch(`/stock/balances?warehouseId=${wh}&q=B7`, get()));
  expect(balances.total).toBe(0); // 没过账，没有现存量行
  const transactions = await jsonOf(await admin.fetch(`/stock/transactions?itemId=${itemId}&from=2020-01-01T00:00:00Z&to=2099-01-01T00:00:00Z`, get()));
  expect(transactions.total).toBe(0);

  const rejected = async (body: unknown, reason: string): Promise<void> => {
    const response = await admin.fetch('/stock-docs', write(body));
    expect(response.status, `${reason}: ${await response.clone().text()}`).toBe(422);
    expect((await jsonOf(response)).error?.reason).toBe(reason);
  };
  await rejected({
    docType: 'in', reason: 'purchase_receipt', lines: [],
  }, 'STOCK_LINE_INVALID');
  await rejected({
    docType: 'in', reason: 'purchase_receipt',
    lines: [{ itemId, warehouseId: wh, qty: 0 }],
  }, 'STOCK_LINE_INVALID');
  await rejected({
    docType: 'in', reason: 'sales_issue',
    lines: [{ itemId, warehouseId: wh, qty: 1 }],
  }, 'STOCK_DOC_REASON_INVALID');
  await rejected({
    docType: 'out', reason: 'sales_issue', sourceType: 'purchase_order',
    lines: [{ itemId, warehouseId: wh, qty: 1 }],
  }, 'STOCK_DOC_INVALID');

  const deactivated = await admin.fetch(`/warehouses/${wh}`, write({ status: 'inactive' }, 'PATCH'));
  expect(deactivated.status).toBe(200);
  await rejected({
    docType: 'in', reason: 'purchase_receipt',
    lines: [{ itemId, warehouseId: wh, qty: 1 }],
  }, 'WAREHOUSE_INACTIVE');
});

test('仓库短码唯一、不可改；没有仓库删除端点', async ({ testApp }) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const warehouse = await createWarehouse(admin, 'FIXED');
  const duplicate = await admin.fetch('/warehouses', write({ code: 'FIXED', name: '冒名' }));
  expect(duplicate.status).toBe(409);
  expect((await jsonOf(duplicate)).error?.reason).toBe('WAREHOUSE_CODE_EXISTS');

  const immutable = await admin.fetch(`/warehouses/${String(warehouse.id)}`, write({ code: 'OTHER' }, 'PATCH'));
  expect(immutable.status).toBe(422);
  expect((await jsonOf(immutable)).error?.reason).toBe('WAREHOUSE_CODE_IMMUTABLE');

  const list = await jsonOf(await admin.fetch('/warehouses?q=FIXED', get()));
  expect(list.items?.map((row) => String(row.id))).toContain(String(warehouse.id));
  const removed = await admin.fetch(`/warehouses/${String(warehouse.id)}`, {
    method: 'DELETE', headers: { origin: ORIGIN },
  });
  expect([404, 405]).toContain(removed.status);
});

test('物料必须存在且在用：不存在 404 ITEM_NOT_FOUND，停用 422 ITEM_INACTIVE', async ({
  testApp,
  connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const warehouse = await createWarehouse(admin);
  const wh = String(warehouse.id);
  const inactive = await createItem(connection, 'inactive');
  const body = (itemId: string) => ({
    docType: 'in', reason: 'purchase_receipt',
    lines: [{ itemId, warehouseId: wh, qty: 1 }],
  });

  const missing = await admin.fetch('/stock-docs', write(body(unique('NO-SUCH-ITEM'))));
  expect(missing.status).toBe(404);
  expect((await jsonOf(missing)).error?.reason).toBe('ITEM_NOT_FOUND');
  const stopped = await admin.fetch('/stock-docs', write(body(inactive)));
  expect(stopped.status).toBe(422);
  expect((await jsonOf(stopped)).error?.reason).toBe('ITEM_INACTIVE');
});


async function createDepartment(connection: Parameters<typeof createItem>[0]): Promise<string> {
  const id = `dept-${randomUUID()}`;
  const now = new Date();
  await connection.query.insertInto('departments').values({
    id, title: '测试领用部门', active: true, sortOrder: 0, createdAt: now, updatedAt: now,
  }).execute();
  return id;
}

test('加片正向：内部领用、生产入库、采购退货过账，回写订单进度不变', async ({
  testApp, connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const warehouse = await createWarehouse(admin);
  const wh = String(warehouse.id);
  const itemId = await createItem(connection);
  const departmentId = await createDepartment(connection);
  const takerUserId = unique('TAKER');
  await createEmployee(connection, takerUserId);
  const inbound = await createInbound(admin, itemId, wh, 100);
  const stocked = await admin.fetch(`/stock-docs/${String(inbound.id)}/post`, write());
  expect(stocked.status, `备货过账失败：${await stocked.clone().text()}`).toBe(200);

  const internal = await jsonOf(await admin.fetch('/stock-docs', write({
    docType: 'out', reason: 'internal_use',
    takerDepartmentId: departmentId, takerUserId,
    docDate: '2026-11-28', remark: '领用测试',
    lines: [{ itemId, warehouseId: wh, qty: 10 }],
  })));
  expect(internal.reason).toBe('internal_use');
  expect(internal.taker).toMatchObject({ userId: takerUserId });
  expect(Object.keys(internal.taker as Row).sort()).toEqual(['name', 'userId']);
  expect(internal.takerDepartment).toMatchObject({ id: departmentId });
  expect(internal.docDate).toBe('2026-11-28');
  const postedInternal = await admin.fetch(`/stock-docs/${String(internal.id)}/post`, write());
  expect(postedInternal.status, `内部领用过账失败：${await postedInternal.clone().text()}`).toBe(200);
  expect(await balanceOf(connection, itemId, wh)).toBe(90);
  const transactions = await connection.repository<Row>('stockTransactions')
    .findMany({ filter: { docId: internal.id } });
  expect(Number(transactions[0]?.qtyDelta)).toBe(-10);

  const production = await jsonOf(await admin.fetch('/stock-docs', write({
    docType: 'in', reason: 'production_receipt',
    lines: [{ itemId, warehouseId: wh, qty: 7 }],
  })));
  expect((await admin.fetch(`/stock-docs/${String(production.id)}/post`, write())).status).toBe(200);
  expect(await balanceOf(connection, itemId, wh)).toBe(97);

  const supplier = await createPartner(admin, { isSupplier: true });
  const order = await createOrder(admin, 'purchase', {
    supplierId: supplier.id, lines: [{ itemId, qty: 20 }],
  });
  await admin.fetch(`/purchase-orders/${String(order.id)}/submit`, write());
  const before = await jsonOf(await admin.fetch(`/purchase-orders/${String(order.id)}`, get()));
  const returned = await jsonOf(await admin.fetch('/stock-docs', write({
    docType: 'out', reason: 'purchase_return', partnerId: supplier.id,
    lines: [{ itemId, warehouseId: wh, qty: 3 }],
  })));
  expect((await admin.fetch(`/stock-docs/${String(returned.id)}/post`, write())).status).toBe(200);
  expect(await balanceOf(connection, itemId, wh)).toBe(94);
  const after = await jsonOf(await admin.fetch(`/purchase-orders/${String(order.id)}`, get()));
  expect(after.lines?.[0]?.receivedQty).toBe(before.lines?.[0]?.receivedQty);
}, 30_000);

test('加片拒绝路径：来源、领用、对方、日期六类规则码', async ({ testApp, connection }) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const warehouse = await createWarehouse(admin);
  const wh = String(warehouse.id);
  const itemId = await createItem(connection);
  const otherItem = await createItem(connection);
  const supplier = await createPartner(admin, { isSupplier: true });
  const customer = await createPartner(admin, { isCustomer: true });
  const order = await createOrder(admin, 'sales', {
    customerId: customer.id, lines: [{ itemId, qty: 10 }],
  });
  await admin.fetch(`/sales-orders/${String(order.id)}/submit`, write());
  const reject = async (
    body: Row, reason: string, post = false, id?: string,
  ): Promise<void> => {
    const response = post
      ? await admin.fetch(`/stock-docs/${String(id)}/post`, write())
      : await admin.fetch('/stock-docs', write(body));
    expect(response.status, `${reason}: ${await response.clone().text()}`).toBe(422);
    expect((await jsonOf(response)).error?.reason).toBe(reason);
  };
  // R1：无来源的销售出库可以建草稿，过账才拦。
  const noSource = await jsonOf(await admin.fetch('/stock-docs', write({
    docType: 'out', reason: 'sales_issue', lines: [{ itemId, warehouseId: wh, qty: 1 }],
  })));
  await reject({}, 'STOCK_SOURCE_REQUIRED', true, noSource.id);
  await reject({
    docType: 'out', reason: 'sales_issue', sourceType: 'sales_order', sourceId: String(order.id),
    lines: [{ itemId: otherItem, warehouseId: wh, qty: 1 }],
  }, 'STOCK_SOURCE_LINE_INVALID');
  await reject({
    docType: 'out', reason: 'sales_issue', sourceType: 'sales_order', sourceId: String(order.id),
    lines: [{ itemId, warehouseId: wh, qty: 11 }],
  }, 'STOCK_SOURCE_QTY_EXCEEDS');
  await reject({
    docType: 'out', reason: 'purchase_return', sourceType: 'sales_order', sourceId: String(order.id),
    lines: [{ itemId, warehouseId: wh, qty: 1 }],
  }, 'STOCK_SOURCE_NOT_ALLOWED');
  await reject({
    docType: 'out', reason: 'sales_issue', partnerId: supplier.id,
    sourceType: 'sales_order', sourceId: String(order.id),
    lines: [{ itemId, warehouseId: wh, qty: 1 }],
  }, 'STOCK_PARTNER_MISMATCH');
  await reject({
    docType: 'in', reason: 'purchase_receipt',
    lines: [{
      itemId, warehouseId: wh, qty: 1,
      productionDate: '2026-12-02', expiryDate: '2026-12-01',
    }],
  }, 'STOCK_LINE_INVALID');
  const internal = await jsonOf(await admin.fetch('/stock-docs', write({
    docType: 'out', reason: 'internal_use',
    lines: [{ itemId, warehouseId: wh, qty: 1 }],
  })));
  await reject({}, 'STOCK_TAKER_REQUIRED', true, internal.id);
}, 30_000);

test('无来源草稿打补丁不被误判成带来源：内部领用草稿改备注照旧 200，来源两列仍空', async ({
  testApp, connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const warehouse = await createWarehouse(admin);
  const itemId = await createItem(connection);
  const created = await jsonOf(await admin.fetch('/stock-docs', write({
    docType: 'out', reason: 'internal_use',
    lines: [{ itemId, warehouseId: String(warehouse.id), qty: 1 }],
  })));
  expect(created.sourceType).toBeNull();
  expect(created.sourceId).toBeNull();
  const docId = String(created.id);

  const patched = await admin.fetch(`/stock-docs/${docId}`, write({
    remark: '补领用说明', docDate: '2026-11-28',
    lines: [{ itemId, warehouseId: String(warehouse.id), qty: 1 }],
  }, 'PATCH'));
  expect(patched.status, `无来源内部领用草稿补丁失败：${await patched.clone().text()}`).toBe(200);
  expect(await jsonOf(patched)).toMatchObject({ remark: '补领用说明', docDate: '2026-11-28' });
  const stored = await connection.repository<Row>('stockDocs').findOne({ filter: { id: docId } });
  expect(stored?.remark).toBe('补领用说明');
  expect(stored?.sourceType).toBeNull();
  expect(stored?.sourceId).toBeNull();

  // 反向：真带来源的补丁仍要按理由拒绝，不能把修复放宽成「任何来源都放行」。
  const customer = await createPartner(admin, { isCustomer: true });
  const order = await createOrder(admin, 'sales', {
    customerId: customer.id, lines: [{ itemId, qty: 10 }],
  });
  await admin.fetch(`/sales-orders/${String(order.id)}/submit`, write());
  const withSource = await admin.fetch(`/stock-docs/${docId}`, write({
    sourceType: 'sales_order', sourceId: String(order.id),
    lines: [{ itemId, warehouseId: String(warehouse.id), qty: 1 }],
  }, 'PATCH'));
  expect(withSource.status, `带来源的内部领用补丁应当被拒：${await withSource.clone().text()}`).toBe(422);
  expect((await jsonOf(withSource)).error?.reason).toBe('STOCK_SOURCE_NOT_ALLOWED');
}, 30_000);

test('加片金额与价格反向：没给税率的旧行照旧没有金额键，只持 stockView 看不到价格', async ({
  testApp, connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const warehouse = await createWarehouse(admin);
  const wh = String(warehouse.id);
  const itemId = await createItem(connection);
  await createDictEntry(connection, 'project', 'STOCK-PROJ');
  const created = await jsonOf(await admin.fetch('/stock-docs', write({
    docType: 'in', reason: 'purchase_receipt', projectCode: 'STOCK-PROJ', discountAmount: 13,
    lines: [{ itemId, warehouseId: wh, qty: 10, taxIncludedPrice: 113, taxRate: 13 }],
  })));
  expect(created.lines?.[0]).toMatchObject({
    taxRate: 13, taxExcludedPrice: 100, taxExcludedAmount: 1000,
    taxAmount: 130, taxIncludedAmount: 1130,
  });
  expect(created).toMatchObject({
    totalQty: 10, taxIncludedTotal: 1130, taxExcludedTotal: 1000,
    taxTotal: 130, payableTotal: 1117,
  });

  const { session: viewer } = await makeRoleUser(
    admin, testApp, 'r020view', [
      { resource: { type: 'composite', id: 'inventory' }, actions: [{ action: 'stockView' }] },
    ],
  );
  const priceKeys = [
    'taxIncludedPrice', 'taxExcludedPrice', 'taxExcludedAmount', 'taxAmount', 'taxIncludedAmount',
    'discountAmount', 'taxIncludedTotal', 'taxExcludedTotal', 'taxTotal', 'payableTotal',
  ];
  for (const response of [
    await viewer.fetch('/stock-docs', get()),
    await viewer.fetch(`/stock-docs/${String(created.id)}`, get()),
  ]) {
    expect(response.status, `只持 stockView 应当能读：${await response.clone().text()}`).toBe(200);
    const body = await jsonOf(response);
    for (const row of (body.items ?? [body]) as Row[]) {
      for (const key of priceKeys) expect(Object.keys(row)).not.toContain(key);
      for (const line of (row.lines ?? []) as Row[]) {
        for (const key of priceKeys) expect(Object.keys(line)).not.toContain(key);
      }
    }
  }
  const priced = await jsonOf(await admin.fetch(`/stock-docs/${String(created.id)}`, get()));
  for (const key of priceKeys.slice(5)) expect(Object.keys(priced)).toContain(key);
  for (const key of priceKeys.slice(0, 5)) expect(Object.keys(priced.lines![0]!)).toContain(key);
}, 30_000);

const HANDLER_PASSWORD = 'R020-handler-123!';

/** 仓管账号：缺省经办人测试用，默认没有员工档案。 */
async function makeWarehouseUser(
  admin: TestSession,
  testApp: Parameters<typeof signIn>[0],
  prefix: string,
): Promise<{ session: TestSession; id: string }> {
  const username = unique(prefix);
  const created = await admin.fetch('/users', write({
    name: username,
    username,
    email: `${username.toLowerCase()}@example.test`,
    password: HANDLER_PASSWORD,
    roleScopes: { app: ['warehouse'] },
  }));
  expect(created.status, `建用户失败：${await created.clone().text()}`).toBe(201);
  const body = await jsonOf(created);
  const id = String((body.data as Row | undefined)?.id ?? body.id ?? '');
  expect(id, '前置：用户 id').not.toBe('');
  return { id, session: await signIn(testApp, { username, password: HANDLER_PASSWORD }) };
}

test('经办人缺省：非员工建单留空、随后能改草稿；显式传非员工仍被拒', async ({
  testApp, connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const warehouse = await createWarehouse(admin);
  const itemId = await createItem(connection);
  const wh = String(warehouse.id);
  const keeper = await makeWarehouseUser(admin, testApp, 'r020keeper');
  // 前置：这个仓管会话没有在职员工档案。
  expect(
    await connection.repository<Row>('employees').findOne({ filter: { userId: keeper.id } }),
    '前置：仓管不应有员工档案',
  ).toBeUndefined();

  for (const [label, session] of [
    ['root', admin],
    ['无员工身份的仓管', keeper.session],
  ] as const) {
    const createdResponse = await session.fetch('/stock-docs', write({
      docType: 'in', reason: 'other_in',
      lines: [{ itemId, warehouseId: wh, qty: 1 }],
    }));
    expect(createdResponse.status, `${label}建单失败：${await createdResponse.clone().text()}`).toBe(201);
    const created = await jsonOf(createdResponse);
    expect(created.handler, `${label}的经办人应为空`).toBeNull();
    expect(created.handlerUserId, `${label}的经办人标识应为空`).toBeNull();
    expect(
      (await connection.repository<Row>('stockDocs').findOne({ filter: { id: created.id } }))?.handlerUserId,
      '库里的经办人列也应为空',
    ).toBeNull();

    const patchedResponse = await session.fetch(`/stock-docs/${String(created.id)}`, write({
      remark: `${label}改草稿`,
      lines: [{ itemId, warehouseId: wh, qty: 2 }],
    }, 'PATCH'));
    expect(patchedResponse.status, `${label}改草稿失败：${await patchedResponse.clone().text()}`).toBe(200);
    expect((await jsonOf(patchedResponse)).handler, '改完经办人仍为空').toBeNull();
  }

  // 反向：明确指定一个非在职员工，照旧 422，不能把整条校验一起放宽。
  const explicit = await admin.fetch('/stock-docs', write({
    docType: 'in', reason: 'other_in', handlerUserId: keeper.id,
    lines: [{ itemId, warehouseId: wh, qty: 1 }],
  }));
  expect(explicit.status, `显式非员工应当被拒：${await explicit.clone().text()}`).toBe(422);
  expect((await jsonOf(explicit)).error?.reason).toBe('STOCK_PERSON_INVALID');
}, 30_000);

test('经办人缺省：在职员工取登录人；显式离职员工仍 422', async ({ testApp, connection }) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const warehouse = await createWarehouse(admin);
  const itemId = await createItem(connection);
  const wh = String(warehouse.id);
  const keeper = await makeWarehouseUser(admin, testApp, 'r020staff');
  await createEmployee(connection, keeper.id);
  const staff = keeper.session;

  const createdResponse = await staff.fetch('/stock-docs', write({
    docType: 'in', reason: 'other_in',
    lines: [{ itemId, warehouseId: wh, qty: 1 }],
  }));
  expect(createdResponse.status, `在职员工建单失败：${await createdResponse.clone().text()}`).toBe(201);
  const created = await jsonOf(createdResponse);
  expect(created.handler).toMatchObject({ userId: keeper.id });
  expect(created.handlerUserId).toBe(keeper.id);

  const leftId = unique('LEFT');
  await createEmployee(connection, leftId, 'left');
  const rejected = await staff.fetch('/stock-docs', write({
    docType: 'in', reason: 'other_in', handlerUserId: leftId,
    lines: [{ itemId, warehouseId: wh, qty: 1 }],
  }));
  expect(rejected.status, `显式离职员工应当被拒：${await rejected.clone().text()}`).toBe(422);
  expect((await jsonOf(rejected)).error?.reason).toBe('STOCK_PERSON_INVALID');
}, 30_000);
