// @vitest-environment node
import { randomUUID } from 'node:crypto';

import { expect } from 'vitest';
import type { Knex } from 'knex';

import { createAppTest } from '../helpers/test-app.js';
import { createStandaloneServer } from '../../server/standalone.js';
import {
  ShiftRuleError,
  shiftMutationsToken,
  type ShiftRecord,
} from '../../server/providers/shifts.js';

/**
 * R-025 并发：两个真事务，第一个写完扣住不提交，第二个事务进入并调用同一个写操作，
 * 然后才放行第一个。用 Promise.when 会合，不用睡眠；扣住的会话在 finally 里放行，
 * 失败路径也不会把事务留在库上。
 *
 * 建同编码与停用同一条都先取固定键的咨询锁；第二个会话在锁里重读，必然被规则挡下。
 * 主键唯一约束再兜一层。锁存在性直接在 pg_locks 里看一眼，去掉取锁时这条会红。
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

const input = (id: string) => ({
  id,
  title: '并发班次',
  startMinute: 480,
  endMinute: 1020,
});

/** 第一个事务还扣着时，另一个连接应该能看到固定键的咨询锁。 */
async function advisoryLocksHeld(connection: {
  client<T>(): Promise<T>;
}): Promise<number> {
  const knex = await connection.client<Knex>();
  // hashtext 返回有符号 int4，符号扩展进 bigint 后落在 classid，低 32 位落在 objid。
  const result = await knex.raw(
    `select count(*)::int as held
       from pg_locks
      where locktype = 'advisory'
        and granted
        and objid = (select (hashtext(?)::bigint & 4294967295)::oid)`,
    ['hs-erp:shifts:structure'],
  );
  return Number((result.rows ?? result)[0]?.held ?? 0);
}

test('并发建同编码：第二个会话在锁内重读后得到 code-exists，只留一行', async ({
  app,
  database,
  connection,
}) => {
  const mutations = app.container.resolve(shiftMutationsToken);
  const id = unique('S');
  const firstWritten = Promise.withResolvers<void>();
  const releaseFirst = Promise.withResolvers<void>();
  const secondEntered = Promise.withResolvers<void>();
  let second: Promise<unknown> | undefined;

  const first = database
    .transaction(async (tx) => {
      await mutations.create(input(id), tx);
      firstWritten.resolve();
      await releaseFirst.promise;
    })
    .catch((error: unknown) => error);
  try {
    await firstWritten.promise;
    // 前置条件真的成立：扣住的事务持有咨询锁，第二个会话还没提交。
    expect(await advisoryLocksHeld(connection), '没有看到咨询锁').toBeGreaterThan(0);
    second = database
      .transaction(async (tx) => {
        secondEntered.resolve();
        await mutations.create(input(id), tx);
      })
      .then(
        () => null,
        (error: unknown) => error,
      );
    await secondEntered.promise;
  } finally {
    releaseFirst.resolve();
  }
  await first;
  const failure = second === undefined ? null : await second;
  expect(failure).toBeInstanceOf(ShiftRuleError);
  expect((failure as ShiftRuleError).code).toBe('code-exists');
  expect(
    await connection.repository<ShiftRecord>('shifts').count({ filter: { id } }),
  ).toBe(1);
});

test('并发停用同一条：只有一个成功，另一个得到 already-inactive', async ({
  app,
  database,
  connection,
}) => {
  const mutations = app.container.resolve(shiftMutationsToken);
  const id = unique('D');
  await mutations.create(input(id));
  const firstWritten = Promise.withResolvers<void>();
  const releaseFirst = Promise.withResolvers<void>();
  const secondEntered = Promise.withResolvers<void>();
  let second: Promise<unknown> | undefined;

  const first = database
    .transaction(async (tx) => {
      await mutations.setActive(id, false, tx);
      firstWritten.resolve();
      await releaseFirst.promise;
    })
    .catch((error: unknown) => error);
  try {
    await firstWritten.promise;
    expect(await advisoryLocksHeld(connection), '没有看到咨询锁').toBeGreaterThan(0);
    second = database
      .transaction(async (tx) => {
        secondEntered.resolve();
        await mutations.setActive(id, false, tx);
      })
      .then(
        () => null,
        (error: unknown) => error,
      );
    await secondEntered.promise;
  } finally {
    releaseFirst.resolve();
  }
  await first;
  const failure = second === undefined ? null : await second;
  expect(failure).toBeInstanceOf(ShiftRuleError);
  expect((failure as ShiftRuleError).code).toBe('already-inactive');
  const stored = await connection
    .repository<ShiftRecord>('shifts')
    .findOne({ filter: { id } });
  expect(stored?.active).toBe(false);
});
