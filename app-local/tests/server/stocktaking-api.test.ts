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
import { createStandaloneServer } from '../../server/standalone.js';
import {
  StocktakingRuleError,
  stocktakingMutationsToken,
} from '../../server/providers/stocktaking.js';

/**
 * R-020 波 1 盘点单：快照、暂存、财务监盘结束、盘盈盘亏两张单生成并过账；
 * 拒绝、反向断言与两个真事务的并发结束。所有库存数字从真库读回。
 */
const test = createAppTest({
  createServer: createStandaloneServer,
  config: {
    app: { publicOrigin: 'http://localhost' },
    auth: { secret: 'test-auth-secret-at-least-32-characters' },
  },
});

const PASSWORD = 'R020-stocktaking-123!';
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

async function makeRoleUser(
  admin: TestSession,
  testApp: Parameters<typeof signIn>[0],
  name: string,
  roles: readonly string[],
): Promise<{ session: TestSession; id: string }> {
  const username = unique(name);
  const created = await admin.fetch('/users', write({
    name: username, username,
    email: `${username.toLowerCase()}@example.test`,
    password: PASSWORD,
    roleScopes: { app: [...roles] },
  }));
  expect(created.status, `建用户失败：${await created.clone().text()}`).toBe(201);
  const id = String(((await jsonOf(created)).data as Row | undefined)?.id ?? '');
  expect(id, '建用户响应应当带 id').not.toBe('');
  return { session: await signIn(testApp, { username, password: PASSWORD }), id };
}

async function createWarehouse(admin: TestSession): Promise<string> {
  const response = await admin.fetch('/warehouses', write({ code: unique('WH'), name: '盘点测试仓' }));
  expect(response.status, `建仓库失败：${await response.clone().text()}`).toBe(201);
  return String((await jsonOf(response)).id);
}

async function stockIn(
  admin: TestSession,
  itemId: string,
  warehouseId: string,
  qty: number,
): Promise<string> {
  const created = await admin.fetch('/stock-docs', write({
    docType: 'in', reason: 'purchase_receipt',
    lines: [{ itemId, warehouseId, qty }],
  }));
  expect(created.status, `建入库单失败：${await created.clone().text()}`).toBe(201);
  const id = String((await jsonOf(created)).id);
  expect((await admin.fetch(`/stock-docs/${id}/post`, write())).status).toBe(200);
  return id;
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
  field: 'stocktakingId' | 'transferDocId',
  id: string,
): Promise<Row[]> => await connection.repository<Row>('stockDocs').findMany({
  filter: { [field]: id },
});

const FORBIDDEN_KEYS = [
  'createdById', 'storageKey', 'uploadedById', 'uploadedBy',
  'purchasePrice', 'salesPrice', 'taxIncludedPrice', 'taxExcludedPrice',
  'price', 'email', 'phone', 'mobile',
];

test('盘点正向：快照不冻结库存，财务监盘结束后盘盈盘亏两张单生成并过账', async ({
  testApp, connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const keeper = await makeRoleUser(admin, testApp, 'stkkeeper', ['warehouse']);
  const finance = await makeRoleUser(admin, testApp, 'stkfinance', ['finance']);
  await createEmployee(connection, finance.id);
  const warehouseId = await createWarehouse(admin);
  const itemA = await createItem(connection);
  const itemB = await createItem(connection);
  const ordinaryInboundId = await stockIn(admin, itemA, warehouseId, 10);
  await stockIn(admin, itemB, warehouseId, 10);

  const created = await keeper.session.fetch('/stocktakings', write({
    warehouseId,
    lines: [{ itemId: itemA }, { itemId: itemB }],
  }));
  expect(created.status, `建盘点单失败：${await created.clone().text()}`).toBe(201);
  const body = await jsonOf(created);
  const id = String(body.id);
  expect(String(body.docNo)).toMatch(/^PD-\d{8}-\d{4,}$/u);
  expect(body.status).toBe('staging');
  expect(body.lines).toHaveLength(2);
  for (const line of body.lines!) {
    expect(Number(line.systemQty)).toBe(10);
    expect(line.actualQty).toBeNull();
    expect(Object.keys(line.item as Row).sort()).toEqual(
      ['barcode', 'code', 'id', 'name', 'spec', 'unitCode'],
    );
  }
  for (const key of FORBIDDEN_KEYS) expect(Object.keys(body)).not.toContain(key);
  expect(Object.keys(body.warehouse as Row).sort()).toEqual(['id', 'name']);
  expect(Object.keys(body.handler as Row).sort()).toEqual(['name', 'userId']);

  const patched = await keeper.session.fetch(`/stocktakings/${id}`, write({
    lines: [{ itemId: itemA, actualQty: 12 }, { itemId: itemB, actualQty: 8 }],
  }, 'PATCH'));
  expect(patched.status, `暂存失败：${await patched.clone().text()}`).toBe(200);
  expect(await balanceOf(connection, itemA, warehouseId), '不冻结库存').toBe(10);

  const finished = await finance.session.fetch(`/stocktakings/${id}/finish`, write({
    supervisorUserId: finance.id,
  }));
  expect(finished.status, `结束盘点失败：${await finished.clone().text()}`).toBe(200);
  const result = await jsonOf(finished);
  expect(result.stocktaking?.status).toBe('finished');
  expect(result.stocktaking?.supervisor).toMatchObject({ userId: finance.id });
  expect(result.profitDocId).toEqual(expect.any(String));
  expect(result.lossDocId).toEqual(expect.any(String));
  for (const line of (result.stocktaking?.lines ?? []) as Row[]) {
    expect(['profit', 'loss']).toContain(line.result);
    expect(Math.abs(Number(line.deltaQty))).toBe(2);
  }
  for (const key of FORBIDDEN_KEYS) expect(Object.keys(result.stocktaking as Row)).not.toContain(key);
  expect(Object.keys(result.stocktaking?.supervisor as Row).sort()).toEqual(['name', 'userId']);

  const docs = await docsOf(connection, 'stocktakingId', id);
  expect(docs).toHaveLength(2);
  const profit = docs.find((doc) => doc.docType === 'in')!;
  const loss = docs.find((doc) => doc.docType === 'out')!;
  expect(profit).toMatchObject({ reason: 'other_in', status: 'posted' });
  expect(loss).toMatchObject({ reason: 'other_out', status: 'posted' });
  for (const [doc, expected] of [[profit, 2], [loss, -2]] as const) {
    const lines = await connection.repository<Row>('stockDocLines').findMany({
      filter: { docId: doc.id },
    });
    expect(lines).toHaveLength(1);
    expect(Number(lines[0]?.qty)).toBe(2);
    const transactions = await connection.repository<Row>('stockTransactions').findMany({
      filter: { docId: doc.id },
    });
    expect(transactions).toHaveLength(1);
    expect(Number(transactions[0]?.qtyDelta)).toBe(expected);
    expect(transactions[0]?.docNo).toBe(doc.docNo);
  }
  expect(await balanceOf(connection, itemA, warehouseId)).toBe(12);
  expect(await balanceOf(connection, itemB, warehouseId)).toBe(8);

  const linked = await jsonOf(await keeper.session.fetch(`/stock-docs?stocktakingId=${id}`, get()));
  expect(linked.total).toBe(2);
  for (const row of linked.items ?? []) expect(row.stocktakingId).toBe(id);
  const ordinary = await jsonOf(await keeper.session.fetch(`/stock-docs/${ordinaryInboundId}`, get()));
  expect(Object.keys(ordinary)).not.toContain('stocktakingId');
  expect(Object.keys(ordinary)).not.toContain('transferDocId');
});

test('盘点拒绝与反向断言：缺实盘、缺监盘人、重复物品、重复结束、重复单据都被拒', async ({
  testApp, app, connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const keeper = await makeRoleUser(admin, testApp, 'stkreject', ['warehouse']);
  const finance = await makeRoleUser(admin, testApp, 'stkrejectfin', ['finance']);
  await createEmployee(connection, finance.id);
  const warehouseId = await createWarehouse(admin);
  const itemA = await createItem(connection);
  await stockIn(admin, itemA, warehouseId, 10);

  const duplicate = await keeper.session.fetch('/stocktakings', write({
    warehouseId, lines: [{ itemId: itemA }, { itemId: itemA }],
  }));
  expect(duplicate.status).toBe(422);
  expect((await jsonOf(duplicate)).error?.reason).toBe('STOCKTAKE_DUPLICATE_ITEM');

  const created = await keeper.session.fetch('/stocktakings', write({
    warehouseId, lines: [{ itemId: itemA }],
  }));
  expect(created.status).toBe(201);
  const id = String((await jsonOf(created)).id);

  const noActual = await finance.session.fetch(`/stocktakings/${id}/finish`, write({
    supervisorUserId: finance.id,
  }));
  expect(noActual.status).toBe(422);
  expect((await jsonOf(noActual)).error?.reason).toBe('STOCKTAKE_ACTUAL_REQUIRED');

  const patched = await keeper.session.fetch(`/stocktakings/${id}`, write({
    lines: [{ itemId: itemA, actualQty: 12 }],
  }, 'PATCH'));
  expect(patched.status).toBe(200);

  const noSupervisor = await finance.session.fetch(`/stocktakings/${id}/finish`, write({
    supervisorUserId: '',
  }));
  expect(noSupervisor.status).toBe(422);
  expect((await jsonOf(noSupervisor)).error?.reason).toBe('STOCKTAKE_SUPERVISOR_REQUIRED');

  const finished = await finance.session.fetch(`/stocktakings/${id}/finish`, write({
    supervisorUserId: finance.id,
  }));
  expect(finished.status, `结束失败：${await finished.clone().text()}`).toBe(200);
  const beforeDocs = await docsOf(connection, 'stocktakingId', id);
  expect(beforeDocs).toHaveLength(1);
  const beforeBalance = await balanceOf(connection, itemA, warehouseId);

  const again = await finance.session.fetch(`/stocktakings/${id}/finish`, write({
    supervisorUserId: finance.id,
  }));
  expect(again.status).toBe(422);
  expect((await jsonOf(again)).error?.reason).toBe('STOCKTAKE_NOT_STAGING');
  expect(await docsOf(connection, 'stocktakingId', id)).toHaveLength(beforeDocs.length);
  expect(await balanceOf(connection, itemA, warehouseId)).toBe(beforeBalance);

  // 数据库兜底：同 (stocktakingId, docType) 的第二条插不进去。
  await expect(connection.query.insertInto('stock_docs').values({
    id: `stk-dup-${randomUUID()}`,
    doc_no: `PD-${randomUUID().slice(0, 8)}`,
    doc_type: 'in', reason: 'other_in', created_by_id: 'test',
    created_at: new Date(), updated_at: new Date(), stocktakingId: id,
  }).execute()).rejects.toThrow();
  expect(await docsOf(connection, 'stocktakingId', id)).toHaveLength(beforeDocs.length);

  const removed = await admin.fetch(`/stocktakings/${id}`, {
    method: 'DELETE', headers: { origin: ORIGIN },
  });
  expect([404, 405]).toContain(removed.status);
  void app;
});

/** 等第二个事务真的排在盘点单头锁上；拿不到就是前置条件没成立。 */
async function waitForLockWait(
  connection: { client<T>(): Promise<T> },
): Promise<number> {
  const knex = await connection.client<Knex>();
  const deadline = Date.now() + 15_000;
  let waiting = 0;
  while (Date.now() < deadline) {
    const result = await knex.raw(
      `select count(*)::int as waiting from pg_stat_activity
        where state = 'active' and wait_event_type = 'Lock'
          and query ilike '%stocktaking_docs%'`,
    );
    waiting = Number((result.rows ?? result)[0]?.waiting ?? 0);
    if (waiting > 0) return waiting;
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  return waiting;
}

test('两个事务同时结束同一张盘点单：只有一个成功，库存和单据不重复', async ({
  testApp, app, database, connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const keeper = await makeRoleUser(admin, testApp, 'stkconc', ['warehouse']);
  const finance = await makeRoleUser(admin, testApp, 'stkconcfin', ['finance']);
  await createEmployee(connection, finance.id);
  const warehouseId = await createWarehouse(admin);
  const itemId = await createItem(connection);
  await stockIn(admin, itemId, warehouseId, 10);

  const created = await keeper.session.fetch('/stocktakings', write({
    warehouseId, lines: [{ itemId, actualQty: 12 }],
  }));
  expect(created.status).toBe(201);
  const id = String((await jsonOf(created)).id);
  const mutations = app.container.resolve(stocktakingMutationsToken);

  const firstWritten = Promise.withResolvers<void>();
  const releaseFirst = Promise.withResolvers<void>();
  const secondEntered = Promise.withResolvers<void>();
  let second: Promise<unknown> | undefined;
  const first = database
    .transaction(async (tx) => {
      await mutations.finish(id, finance.id, finance.id, tx);
      firstWritten.resolve();
      await releaseFirst.promise;
    })
    .catch((error: unknown) => error);
  try {
    await firstWritten.promise;
    second = database
      .transaction(async (tx) => {
        secondEntered.resolve();
        await mutations.finish(id, finance.id, finance.id, tx);
      })
      .then(() => null, (error: unknown) => error);
    await secondEntered.promise;
    expect(
      await waitForLockWait(connection),
      '第二个事务没有停在盘点单头锁上，不能证明并发',
    ).toBeGreaterThan(0);
  } finally {
    releaseFirst.resolve();
  }
  await first;
  const failure = second === undefined ? null : await second;
  expect(failure, '第二个结束必须被拒').toBeInstanceOf(StocktakingRuleError);
  expect((failure as StocktakingRuleError).code).toBe('stocktaking-not-staging');
  expect(await balanceOf(connection, itemId, warehouseId)).toBe(12);
  expect(await docsOf(connection, 'stocktakingId', id)).toHaveLength(1);
}, 60_000);
