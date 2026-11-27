// @vitest-environment node
import { randomUUID } from 'node:crypto';

import { expect } from 'vitest';
import type { Knex } from 'knex';

import { createAppTest } from '../helpers/test-app.js';
import { createStandaloneServer } from '../../server/standalone.js';
import {
  CODE_PREFIXES,
  codeServiceToken,
} from '../../server/providers/codes.js';

/**
 * R-016 MVP：发号服务的格式、并发、跨日、满位进位与回滚。
 *
 * 并发用例照 R-025 的写法：两个真事务，第一个领满 20 个号后扣住不提交，
 * 第二个事务进入后才放行；用 Promise 会合，不用睡眠，扣住的事务在 finally 里
 * 一定放行。扣住期间从另一个连接读不到那行（真前置条件），两个集合必须无交集。
 */
const test = createAppTest({
  createServer: createStandaloneServer,
  config: {
    app: { publicOrigin: 'http://localhost' },
    auth: { secret: 'test-auth-secret-at-least-32-characters' },
  },
});

// 注入时钟：UTC 02:00 = 上海 10:00 当天；UTC 18:00 = 上海次日 02:00。
const DAY1 = new Date('2026-11-27T02:00:00.000Z');
const DAY2 = new Date('2026-11-27T18:00:00.000Z');

const uniquePrefix = (letter: string) =>
  `${letter}${randomUUID().replaceAll('-', '').slice(0, 7).toUpperCase()}`;

/** 确认两条事务真的落在两个不同的 PG 后端连接上，而不是同一连接的嵌套事务。 */
async function backendPid(tx: { client<T>(): Promise<T> }): Promise<number> {
  const knex = await tx.client<Knex>();
  const result = await knex.raw('select pg_backend_pid() as pid');
  return Number((result.rows ?? result)[0]?.pid ?? 0);
}

test('前缀写死一处；格式是前缀-yyyymmdd-四位序号；none 不带日期', async ({
  app,
  connection,
}) => {
  const codes = app.container.resolve(codeServiceToken);
  expect(Object.values(CODE_PREFIXES)).toEqual([
    'M', 'P', 'CU', 'SU', 'PO', 'SO', 'IN', 'OUT',
  ]);

  expect(
    await codes.nextCode(connection, CODE_PREFIXES.item, { now: DAY1 }),
  ).toBe('M-20261127-0001');
  expect(
    await codes.nextCode(connection, CODE_PREFIXES.item, { now: DAY1 }),
  ).toBe('M-20261127-0002');

  const noDate = await codes.nextCode(connection, CODE_PREFIXES.customer, {
    period: 'none',
    now: DAY1,
  });
  expect(noDate).toBe('CU-0001');
  expect(
    await codes.nextCode(connection, CODE_PREFIXES.customer, {
      period: 'none',
      now: DAY2,
    }),
  ).toBe('CU-0002');
});

test('并发：两个连接各取 20 个号，互不重复', async ({
  app,
  database,
  connection,
}) => {
  const codes = app.container.resolve(codeServiceToken);
  const prefix = uniquePrefix('C');
  const options = { now: DAY1 };
  const firstWritten = Promise.withResolvers<void>();
  const releaseFirst = Promise.withResolvers<void>();
  const secondEntered = Promise.withResolvers<void>();
  let second: Promise<string[]> | undefined;
  let firstPid = 0;
  let secondPid = 0;

  const first = database.transaction(async (tx) => {
    firstPid = await backendPid(tx);
    const numbers: string[] = [];
    for (let i = 0; i < 20; i += 1) {
      numbers.push(await codes.nextCode(tx, prefix, options));
    }
    firstWritten.resolve();
    await releaseFirst.promise;
    return numbers;
  });

  try {
    await firstWritten.promise;
    // 前置条件真的成立：第一条事务扣住了，别的连接还看不到它的计数器行。
    const visible = await connection.query
      .selectFrom('codeSequences')
      .selectAll()
      .where('prefix', '=', prefix)
      .execute();
    expect(visible, '第一条事务未提交，别的连接不该看到计数器行').toHaveLength(0);

    second = database.transaction(async (tx) => {
      secondPid = await backendPid(tx);
      secondEntered.resolve();
      const numbers: string[] = [];
      for (let i = 0; i < 20; i += 1) {
        numbers.push(await codes.nextCode(tx, prefix, options));
      }
      return numbers;
    });
    await secondEntered.promise;
  } finally {
    releaseFirst.resolve();
  }

  const firstNumbers = await first;
  const secondNumbers = second === undefined ? [] : await second;
  expect(firstPid, '第一条事务的 PG 后端 pid').toBeGreaterThan(0);
  expect(secondPid, '第二条事务的 PG 后端 pid').toBeGreaterThan(0);
  expect(firstPid, '两条事务必须在不同连接上').not.toBe(secondPid);
  expect(firstNumbers).toHaveLength(20);
  expect(secondNumbers).toHaveLength(20);
  const all = [...firstNumbers, ...secondNumbers];
  expect(new Set(all).size, '40 个号必须互不相同').toBe(40);

  const row = await connection.query
    .selectFrom('codeSequences')
    .selectAll()
    .where('prefix', '=', prefix)
    .executeTakeFirstOrThrow();
  expect(Number(row.lastNo)).toBe(40);
});

test('跨日重置：同一前缀不同日期各从 1 起（注入时钟）', async ({
  app,
  connection,
}) => {
  const codes = app.container.resolve(codeServiceToken);
  const prefix = uniquePrefix('D');

  expect(await codes.nextCode(connection, prefix, { now: DAY1 })).toBe(
    `${prefix}-20261127-0001`,
  );
  expect(await codes.nextCode(connection, prefix, { now: DAY1 })).toBe(
    `${prefix}-20261127-0002`,
  );
  expect(await codes.nextCode(connection, prefix, { now: DAY2 })).toBe(
    `${prefix}-20261128-0001`,
  );
  const rows = await connection.query
    .selectFrom('codeSequences')
    .selectAll()
    .where('prefix', '=', prefix)
    .execute();
  expect(rows.map((row) => row.period).sort()).toEqual([
    '20261127',
    '20261128',
  ]);
});

test('满位进位：9999 之后发出五位序号，不失败', async ({ app, connection }) => {
  const codes = app.container.resolve(codeServiceToken);
  const prefix = uniquePrefix('G');
  await connection.query
    .insertInto('codeSequences')
    .values({ prefix, period: '20261127', lastNo: 9999 })
    .execute();

  expect(await codes.nextCode(connection, prefix, { now: DAY1 })).toBe(
    `${prefix}-20261127-10000`,
  );
  expect(await codes.nextCode(connection, prefix, { now: DAY1 })).toBe(
    `${prefix}-20261127-10001`,
  );
});

test('回滚不占号：事务里领号后回滚，下一个号还是 1', async ({
  app,
  database,
  connection,
}) => {
  const codes = app.container.resolve(codeServiceToken);
  const prefix = uniquePrefix('R');

  await expect(
    database.transaction(async (tx) => {
      expect(await codes.nextCode(tx, prefix, { now: DAY1 })).toBe(
        `${prefix}-20261127-0001`,
      );
      throw new Error('force rollback');
    }),
  ).rejects.toThrow('force rollback');

  expect(await codes.nextCode(connection, prefix, { now: DAY1 })).toBe(
    `${prefix}-20261127-0001`,
  );
  const row = await connection.query
    .selectFrom('codeSequences')
    .selectAll()
    .where('prefix', '=', prefix)
    .executeTakeFirstOrThrow();
  expect(Number(row.lastNo)).toBe(1);
});

test('reject 模式：满位抛 code-exhausted，计数器不多走一步', async ({
  app,
  connection,
}) => {
  const codes = app.container.resolve(codeServiceToken);
  const prefix = uniquePrefix('X');
  await connection.query
    .insertInto('codeSequences')
    .values({ prefix, period: '20261127', lastNo: 9999 })
    .execute();

  await expect(
    codes.nextCode(connection, prefix, {
      now: DAY1,
      onExhaust: 'reject',
    }),
  ).rejects.toMatchObject({ code: 'code-exhausted' });
  const row = await connection.query
    .selectFrom('codeSequences')
    .selectAll()
    .where('prefix', '=', prefix)
    .executeTakeFirstOrThrow();
  expect(Number(row.lastNo)).toBe(9999);
  await expect(
    codes.nextCode(connection, prefix, { now: DAY1 }),
  ).resolves.toBe(`${prefix}-20261127-10000`);
});
