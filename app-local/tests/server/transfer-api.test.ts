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
import { transferMutationsToken } from '../../server/providers/transfer.js';

/**
 * R-020 波 1 调拨单：先草稿再过账，一出一入两张单同事务；
 * 拒绝、反向断言（重复过账、只搬一半、库存不够）都从真库读回。
 */
const test = createAppTest({
  createServer: createStandaloneServer,
  config: {
    app: { publicOrigin: 'http://localhost' },
    auth: { secret: 'test-auth-secret-at-least-32-characters' },
  },
});

const PASSWORD = 'R020-transfer-123!';
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

interface Row { [key: string]: unknown; }
type JsonBody = Row & { items?: Row[]; total?: number; error?: { reason: string } };
const jsonOf = async (response: Response): Promise<JsonBody> => (await response.json()) as JsonBody;

async function makeKeeper(
  admin: TestSession,
  testApp: Parameters<typeof signIn>[0],
): Promise<TestSession> {
  const username = unique('trfkeeper');
  const created = await admin.fetch('/users', write({
    name: username, username,
    email: `${username.toLowerCase()}@example.test`,
    password: PASSWORD,
    roleScopes: { app: ['warehouse'] },
  }));
  expect(created.status).toBe(201);
  return await signIn(testApp, { username, password: PASSWORD });
}

async function createWarehouse(admin: TestSession): Promise<string> {
  const response = await admin.fetch('/warehouses', write({ code: unique('WH'), name: '调拨测试仓' }));
  expect(response.status).toBe(201);
  return String((await jsonOf(response)).id);
}

async function stockIn(
  admin: TestSession,
  itemId: string,
  warehouseId: string,
  qty: number,
): Promise<void> {
  const created = await admin.fetch('/stock-docs', write({
    docType: 'in', reason: 'purchase_receipt',
    lines: [{ itemId, warehouseId, qty }],
  }));
  expect(created.status).toBe(201);
  const id = String((await jsonOf(created)).id);
  expect((await admin.fetch(`/stock-docs/${id}/post`, write())).status).toBe(200);
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

const docsOf = async (
  connection: { repository<T>(name: string): { findMany(options: unknown): Promise<T[]> } },
  id: string,
): Promise<Row[]> => await connection.repository<Row>('stockDocs').findMany({
  filter: { transferDocId: id },
});

const FORBIDDEN_KEYS = [
  'createdById', 'storageKey', 'uploadedById', 'uploadedBy',
  'purchasePrice', 'salesPrice', 'taxIncludedPrice', 'taxExcludedPrice',
  'price', 'email', 'phone', 'mobile',
];

test('调拨正向：过账生成一出一入两张单，两仓一减一增、流水齐全', async ({
  testApp, connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const keeper = await makeKeeper(admin, testApp);
  const outWarehouse = await createWarehouse(admin);
  const inWarehouse = await createWarehouse(admin);
  const itemId = await createItem(connection);
  await stockIn(admin, itemId, outWarehouse, 20);

  const created = await keeper.fetch('/transfers', write({
    transferInWarehouseId: inWarehouse,
    transferOutWarehouseId: outWarehouse,
    remark: '波 1 调拨',
    lines: [{ itemId, qty: 10 }],
  }));
  expect(created.status, `建调拨单失败：${await created.clone().text()}`).toBe(201);
  const body = await jsonOf(created);
  const id = String(body.id);
  expect(String(body.docNo)).toMatch(/^DB-\d{8}-\d{4,}$/u);
  expect(body.status).toBe('draft');
  expect(body.lines).toHaveLength(1);
  expect(Number(body.lines![0]!.qty)).toBe(10);
  expect(Number(body.lines![0]!.transferQty)).toBe(10);
  expect(Object.keys(body.lines![0]!.item as Row).sort()).toEqual(
    ['code', 'id', 'name', 'spec', 'unitCode'],
  );
  for (const key of FORBIDDEN_KEYS) expect(Object.keys(body)).not.toContain(key);
  expect(Object.keys(body.warehouseIn as Row).sort()).toEqual(['id', 'name']);
  expect(Object.keys(body.warehouseOut as Row).sort()).toEqual(['id', 'name']);
  expect(Object.keys(body.handler as Row).sort()).toEqual(['name', 'userId']);

  const posted = await keeper.fetch(`/transfers/${id}/post`, write());
  expect(posted.status, `过账失败：${await posted.clone().text()}`).toBe(200);
  const result = await jsonOf(posted);
  expect(result.transfer?.status).toBe('posted');
  expect(result.outDocId).toEqual(expect.any(String));
  expect(result.inDocId).toEqual(expect.any(String));
  for (const key of FORBIDDEN_KEYS) expect(Object.keys(result.transfer as Row)).not.toContain(key);

  const docs = await docsOf(connection, id);
  expect(docs).toHaveLength(2);
  const out = docs.find((doc) => doc.docType === 'out')!;
  const inbound = docs.find((doc) => doc.docType === 'in')!;
  expect(out).toMatchObject({ reason: 'other_out', status: 'posted' });
  expect(inbound).toMatchObject({ reason: 'other_in', status: 'posted' });
  for (const [doc, delta] of [[out, -10], [inbound, 10]] as const) {
    const lines = await connection.repository<Row>('stockDocLines').findMany({
      filter: { docId: doc.id },
    });
    expect(lines).toHaveLength(1);
    expect(Number(lines[0]?.qty)).toBe(10);
    const transactions = await connection.repository<Row>('stockTransactions').findMany({
      filter: { docId: doc.id },
    });
    expect(transactions).toHaveLength(1);
    expect(Number(transactions[0]?.qtyDelta)).toBe(delta);
    expect(transactions[0]?.docNo).toBe(doc.docNo);
  }
  expect(await balanceOf(connection, itemId, outWarehouse)).toBe(10);
  expect(await balanceOf(connection, itemId, inWarehouse)).toBe(10);

  const linked = await jsonOf(await keeper.fetch(`/stock-docs?transferDocId=${id}`, get()));
  expect(linked.total).toBe(2);
  for (const row of linked.items ?? []) expect(row.transferDocId).toBe(id);
});

test('调拨反向：重复过账、数量越界、同仓、库存不够、无调出仓与只搬一半都被守住', async ({
  testApp, app, connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const keeper = await makeKeeper(admin, testApp);
  const outWarehouse = await createWarehouse(admin);
  const inWarehouse = await createWarehouse(admin);
  const itemId = await createItem(connection);
  await stockIn(admin, itemId, outWarehouse, 20);

  const invalid = await keeper.fetch('/transfers', write({
    transferInWarehouseId: inWarehouse, transferOutWarehouseId: outWarehouse,
    lines: [{ itemId, qty: 10, transferQty: 11 }],
  }));
  expect(invalid.status).toBe(422);
  expect((await jsonOf(invalid)).error?.reason).toBe('TRANSFER_QTY_INVALID');

  const same = await keeper.fetch('/transfers', write({
    transferInWarehouseId: outWarehouse, transferOutWarehouseId: outWarehouse,
    lines: [{ itemId, qty: 1 }],
  }));
  expect(same.status).toBe(422);
  expect((await jsonOf(same)).error?.reason).toBe('TRANSFER_SAME_WAREHOUSE');

  const short = await keeper.fetch('/transfers', write({
    transferInWarehouseId: inWarehouse, transferOutWarehouseId: outWarehouse,
    lines: [{ itemId, qty: 25 }],
  }));
  expect(short.status).toBe(201);
  const shortId = String((await jsonOf(short)).id);
  const insufficient = await keeper.fetch(`/transfers/${shortId}/post`, write());
  expect(insufficient.status).toBe(422);
  expect((await jsonOf(insufficient)).error?.reason).toBe('TRANSFER_INSUFFICIENT');
  expect(await docsOf(connection, shortId)).toHaveLength(0);
  expect(await balanceOf(connection, itemId, outWarehouse)).toBe(20);
  expect(await balanceOf(connection, itemId, inWarehouse)).toBe(0);

  const created = await keeper.fetch('/transfers', write({
    transferInWarehouseId: inWarehouse, transferOutWarehouseId: outWarehouse,
    lines: [{ itemId, qty: 10, transferQty: 4 }],
  }));
  expect(created.status).toBe(201);
  const id = String((await jsonOf(created)).id);
  const posted = await keeper.fetch(`/transfers/${id}/post`, write());
  expect(posted.status, `过账失败：${await posted.clone().text()}`).toBe(200);
  expect(await balanceOf(connection, itemId, outWarehouse)).toBe(16);
  expect(await balanceOf(connection, itemId, inWarehouse)).toBe(4);
  const beforeDocs = await docsOf(connection, id);
  expect(beforeDocs).toHaveLength(2);
  for (const doc of beforeDocs) {
    const lines = await connection.repository<Row>('stockDocLines').findMany({
      filter: { docId: doc.id },
    });
    expect(Number(lines[0]?.qty)).toBe(4);
  }

  const again = await keeper.fetch(`/transfers/${id}/post`, write());
  expect(again.status).toBe(422);
  expect((await jsonOf(again)).error?.reason).toBe('TRANSFER_NOT_DRAFT');
  expect(await docsOf(connection, id)).toHaveLength(beforeDocs.length);
  expect(await balanceOf(connection, itemId, outWarehouse)).toBe(16);
  expect(await balanceOf(connection, itemId, inWarehouse)).toBe(4);

  const removed = await admin.fetch(`/transfers/${id}`, {
    method: 'DELETE', headers: { origin: ORIGIN },
  });
  expect([404, 405]).toContain(removed.status);

  // 只搬一半不可能：第二张单写入失败时第一张也回滚。
  const rollback = await keeper.fetch('/transfers', write({
    transferInWarehouseId: inWarehouse, transferOutWarehouseId: outWarehouse,
    lines: [{ itemId, qty: 6 }],
  }));
  expect(rollback.status).toBe(201);
  const rollbackId = String((await jsonOf(rollback)).id);
  await connection.query.insertInto('stock_docs').values({
    id: `trf-collision-${randomUUID()}`,
    doc_no: `DB-${randomUUID().slice(0, 8)}`,
    doc_type: 'in', reason: 'other_in', created_by_id: 'test',
    created_at: new Date(), updated_at: new Date(), transferDocId: rollbackId,
  }).execute();
  const mutations = app.container.resolve(transferMutationsToken);
  await expect(mutations.post(rollbackId, 'test')).rejects.toThrow();
  expect(await docsOf(connection, rollbackId)).toHaveLength(1); // 只有人为塞进去的那张
  expect(await balanceOf(connection, itemId, outWarehouse)).toBe(16);
  expect(await balanceOf(connection, itemId, inWarehouse)).toBe(4);
  const header = await connection.repository<Row>('transferDocs').findOne({
    filter: { id: rollbackId },
  });
  expect(header?.status).toBe('draft');
});

test('无调出仓时只生成调入单，按其他入库口径增加现存量', async ({
  testApp, connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const keeper = await makeKeeper(admin, testApp);
  const inWarehouse = await createWarehouse(admin);
  const itemId = await createItem(connection);

  const created = await keeper.fetch('/transfers', write({
    transferInWarehouseId: inWarehouse,
    lines: [{ itemId, qty: 7 }],
  }));
  expect(created.status).toBe(201);
  const createdBody = await jsonOf(created);
  const id = String(createdBody.id);
  expect(createdBody.warehouseOut).toBeNull();

  const posted = await keeper.fetch(`/transfers/${id}/post`, write());
  expect(posted.status, `过账失败：${await posted.clone().text()}`).toBe(200);
  const result = await jsonOf(posted);
  expect(result.outDocId).toBeNull();
  expect(result.inDocId).toEqual(expect.any(String));
  const docs = await docsOf(connection, id);
  expect(docs).toHaveLength(1);
  expect(docs[0]).toMatchObject({ docType: 'in', reason: 'other_in', status: 'posted' });
  expect(await balanceOf(connection, itemId, inWarehouse)).toBe(7);

  const listed = await keeper.fetch('/transfers?status=posted', get());
  expect(listed.status).toBe(200);
  expect((await jsonOf(listed)).items?.some((row) => row.id === id)).toBe(true);
});
