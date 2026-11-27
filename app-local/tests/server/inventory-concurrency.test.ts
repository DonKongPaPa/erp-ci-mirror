// @vitest-environment node
import { randomUUID } from 'node:crypto';

import {
  DEFAULT_ADMIN_CREDENTIALS,
  signIn,
} from '@nocobase/app-plugin-authentication/testing';
import { expect } from 'vitest';
import type { Knex } from 'knex';

import { createAppTest } from '../helpers/test-app.js';
import { createItem } from '../helpers/inventory.js';
import { createOrder, createPartner } from '../helpers/orders.js';
import { createStandaloneServer } from '../../server/standalone.js';
import {
  StockRuleError,
  stockMutationsToken,
  type StockDocRecord,
} from '../../server/providers/inventory.js';

/**
 * R-020 并发守住的那一条：两张出库单对同一物料同一仓库同时过账，合计超过现存量时
 * 恰有一张成功、另一张 422，现存量不为负。
 *
 * 两个真事务：第一个过账完扣住不提交，第二个进入并停在现存量行锁上；等到
 * pg_stat_activity 里真的有会话在等锁才放行（不用睡眠），扣住的事务在 finally 里释放。
 */
const test = createAppTest({
  createServer: createStandaloneServer,
  config: {
    app: { publicOrigin: 'http://localhost' },
    auth: { secret: 'test-auth-secret-at-least-32-characters' },
  },
});

const unique = (prefix: string) =>
  `${prefix}${randomUUID().replaceAll('-', '').slice(0, 10).toUpperCase()}`;
const write = (body: unknown = {}): RequestInit => ({
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    origin: 'http://localhost',
    'Idempotency-Key': `${Date.now()}.${randomUUID()}`,
  },
  body: JSON.stringify(body),
});

/** 等第二个事务真的排在库存行锁上；拿不到就是前置条件没成立，不能算并发通过。 */
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
          and query ilike '%stock_balances%'`,
    );
    waiting = Number((result.rows ?? result)[0]?.waiting ?? 0);
    if (waiting > 0) return waiting;
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  return waiting;
}

test('两张出库单同时过账：一成一拒，现存量不为负', async ({
  testApp,
  app,
  database,
  connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const warehouseResponse = await admin.fetch('/warehouses', write({
    code: unique('WH'), name: '并发仓',
  }));
  expect(warehouseResponse.status).toBe(201);
  const warehouseId = String((await warehouseResponse.json() as { id: string }).id);
  const itemId = await createItem(connection);

  const inboundResponse = await admin.fetch('/stock-docs', write({
    docType: 'in',
    reason: 'purchase_receipt',
    lines: [{ itemId, warehouseId, qty: 100 }],
  }));
  expect(inboundResponse.status).toBe(201);
  const inboundId = String((await inboundResponse.json() as { id: string }).id);
  const mutations = app.container.resolve(stockMutationsToken);
  await mutations.post(inboundId, 'concurrency-test');

  const ids: string[] = [];
  for (const qty of [60, 60]) {
    // R1（新约束）：销售出库过账要有来源订单；这里各备一张量足够的订单。
    const customer = await createPartner(admin, { isCustomer: true });
    const source = await createOrder(admin, 'sales', {
      customerId: customer.id, lines: [{ itemId, qty: 200 }],
    });
    expect((await admin.fetch(`/sales-orders/${String(source.id)}/submit`, write())).status).toBe(200);
    const response = await admin.fetch('/stock-docs', write({
      docType: 'out',
      reason: 'sales_issue',
      sourceType: 'sales_order',
      sourceId: String(source.id),
      lines: [{ itemId, warehouseId, qty }],
    }));
    expect(response.status).toBe(201);
    ids.push(String((await response.json() as { id: string }).id));
  }

  const firstWritten = Promise.withResolvers<void>();
  const releaseFirst = Promise.withResolvers<void>();
  const secondEntered = Promise.withResolvers<void>();
  let second: Promise<unknown> | undefined;

  const first = database
    .transaction(async (tx) => {
      await mutations.post(ids[0]!, 'concurrency-test', tx);
      firstWritten.resolve();
      await releaseFirst.promise;
    })
    .catch((error: unknown) => error);
  try {
    await firstWritten.promise;
    second = database
      .transaction(async (tx) => {
        secondEntered.resolve();
        await mutations.post(ids[1]!, 'concurrency-test', tx);
      })
      .then(
        () => null,
        (error: unknown) => error,
      );
    await secondEntered.promise;
    expect(
      await waitForLockWait(connection),
      '第二个事务没有停在库存行锁上，不能证明并发',
    ).toBeGreaterThan(0);
  } finally {
    releaseFirst.resolve();
  }
  await first;
  const failure = second === undefined ? null : await second;

  expect(failure, '第二个过账必须被拒绝').toBeInstanceOf(StockRuleError);
  expect((failure as StockRuleError).code).toBe('insufficient');
  const balance = await connection.repository<Record<string, unknown>>('stockBalances').findOne({
    filter: { itemId, warehouseId, batchNo: '' },
  });
  expect(Number(balance?.qty)).toBe(40);
  const statuses: string[] = [];
  for (const id of ids) {
    const row = await connection.repository<StockDocRecord>('stockDocs').findOne({ filter: { id } });
    statuses.push(String(row?.status));
  }
  expect(statuses.sort()).toEqual(['draft', 'posted']);
  const written: Record<string, unknown>[] = [];
  for (const id of ids) {
    written.push(
      ...await connection.repository<Record<string, unknown>>('stockTransactions').findMany({
        filter: { docId: id },
      }),
    );
  }
  expect(written).toHaveLength(1);
  expect(Number(written[0]?.balanceAfter)).toBe(40);
}, 60_000);
