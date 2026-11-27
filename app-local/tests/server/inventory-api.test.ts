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
  const response = await session.fetch('/stock-docs', write({
    docType: 'out',
    reason: 'sales_issue',
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

test('建单自动取号：IN/OUT 前缀带日期，明细整单写入', async ({ testApp, connection }) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const warehouse = await createWarehouse(admin);
  const itemId = await createItem(connection);
  const inbound = await createInbound(admin, itemId, String(warehouse.id), 12.5);
  expect(String(inbound.docNo)).toMatch(/^IN-\d{8}-\d{4,}$/u);
  expect(inbound).toMatchObject({ docType: 'in', status: 'draft' });
  expect(String(inbound.remark)).toBe('');
  expect(inbound.sourceType).toBeNull();
  expect(inbound.lines).toHaveLength(1);
  expect(inbound.lines?.[0]).toMatchObject({ itemId, warehouseId: warehouse.id, qty: 12.5 });

  const outbound = await createOutbound(admin, itemId, String(warehouse.id), 3);
  expect(String(outbound.docNo)).toMatch(/^OUT-\d{8}-\d{4,}$/u);
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
