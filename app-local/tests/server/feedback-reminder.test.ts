// @vitest-environment node
import { randomUUID } from 'node:crypto';

import type { DatabaseConnection } from '@nocobase/db';
import { expect } from 'vitest';

import {
  scanFeedbackReminders,
  type ReminderNotification,
  type ReminderNotifier,
  type ReminderRow,
  type ReminderStatus,
} from '../../server/feedback-reminder.js';
import { createStandaloneServer } from '../../server/standalone.js';
import { createAppTest } from '../helpers/test-app.js';

/**
 * R-026 验收32、33：七天提醒的扫描函数。
 *
 * 时钟是钉死的常量，所有「几天前」都相对它算，不读真实时间。通知发送器是假的：
 * 测试里不放行任何真实通知，发送器自己维护按幂等键查状态的记录，用来驱动
 * 抛错、成功没记时间、结果不明、试满五回四条分支。按用户裁定只跑真 Postgres，
 * 提醒记录表的并发抢占在真库上验。
 */
const NOW = new Date('2026-11-26T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const ago = (days: number) => new Date(NOW.getTime() - days * DAY);
/** 下一轮扫描的时钟：设计上一张单两回之间至少隔一天，也越过认领窗口。 */
const later = (days = 1) => new Date(NOW.getTime() + days * DAY);

const test = createAppTest({
  // 每条测试一个全新测试库：候选集不能被上一条测试留下的反馈单污染。
  scope: 'test',
  createServer: createStandaloneServer,
  config: {
    app: { publicOrigin: 'http://localhost' },
    auth: { secret: 'feedback-reminder-test-secret-at-least-32-chars' },
  },
});

/** 假通知服务：发送器完全由测试驱动，记录按幂等键可查，收件内容全部被截获。 */
function fakeNotifier() {
  const clock = { now: NOW };
  const sent: ReminderNotification[] = [];
  const records = new Map<
    string,
    { readonly status: ReminderStatus; readonly updatedAt: string }
  >();
  const record = (
    key: string,
    status: ReminderStatus,
    at: Date = clock.now,
  ) => {
    records.set(key, { status, updatedAt: at.toISOString() });
  };

  let behavior: (message: ReminderNotification) => Promise<ReminderStatus> =
    async (message) => {
      record(message.idempotencyKey, 'completed');
      return 'completed';
    };

  const notifier: ReminderNotifier = {
    async send(message) {
      sent.push(message);
      const status = await behavior(message);
      return { status, updatedAt: clock.now.toISOString() };
    },
    async getByIdempotencyKey(key) {
      return records.get(key);
    },
  };

  return {
    notifier,
    clock,
    sent,
    records,
    record,
    setBehavior(next: (message: ReminderNotification) => Promise<ReminderStatus>) {
      behavior = next;
    },
    completed: async (message: ReminderNotification) => {
      record(message.idempotencyKey, 'completed');
      return 'completed' as const;
    },
  };
}

async function insertCase(
  connection: DatabaseConnection,
  overrides: {
    readonly id?: string;
    readonly ownerId?: string | null;
    readonly createdDaysAgo?: number;
    readonly status?: string;
    readonly outcome?: string | null;
    readonly senderContact?: string | null;
  } = {},
): Promise<string> {
  const id = overrides.id ?? randomUUID();
  const createdAt = ago(overrides.createdDaysAgo ?? 8);
  const ownerId =
    overrides.ownerId === undefined ? `user-${id.slice(0, 8)}` : overrides.ownerId;
  await connection.repository('fqcMessages').createOne({
    values: {
      id,
      channel: 'web',
      externalId: id,
      senderName: '发件人',
      senderContact:
        overrides.senderContact === undefined
          ? '发件人 <submitter@example.test> 13812345678'
          : overrides.senderContact,
      content: '客户原文不能出现在提醒里',
      rawContentType: 'text',
      receivedAt: createdAt,
      status: overrides.status ?? 'open',
      ownerId,
      createdAt,
      updatedAt: createdAt,
    },
  });
  if (overrides.outcome !== null) {
    await connection.repository('fqcScreenings').createOne({
      values: {
        id: randomUUID(),
        messageId: id,
        outcome: overrides.outcome ?? 'needs-review',
        category: 'dimension',
        severity: 'major',
        createdAt,
        updatedAt: createdAt,
      },
    });
  }
  return id;
}

const remindersOf = async (connection: DatabaseConnection) =>
  (await connection.query
    .selectFrom('fqcFeedbackReminders')
    .selectAll()
    .execute()) as unknown as ReminderRow[];

const seedReminder = async (
  connection: DatabaseConnection,
  feedbackId: string,
  attempts: number,
  lastKey: string,
) => {
  await connection.repository('fqcFeedbackReminders').createOne({
    values: {
      id: randomUUID(),
      feedbackId,
      attempts,
      lastKey,
      notifiedAt: null,
      createdAt: ago(8),
      updatedAt: ago(8),
    },
  });
};

const scan = (
  connection: DatabaseConnection,
  notifier: ReminderNotifier,
  now: Date,
  log: (message: string) => void = () => {},
) => scanFeedbackReminders({ connection, notifier, now, log });

/**
 * 让第 N 次对提醒记录表的更新真的抛错，用来模拟「记发出时间那一步写库失败」。
 * 查询构造器是 clone 式的，所以每一层都要包住，直到最终那次 execute；
 * 恢复写在 finally 里，失败路径不放过。
 */
async function withFailingUpdate(
  connection: DatabaseConnection,
  failAt: number,
  run: () => Promise<void>,
): Promise<void> {
  const query = connection.query as unknown as {
    updateTable(table: string): object;
  };
  const original = query.updateTable;
  let updates = 0;
  const wrap = (builder: object): object =>
    new Proxy(builder, {
      get(target, property, receiver) {
        const value: unknown = Reflect.get(target, property, receiver);
        if (property === 'execute' && typeof value === 'function') {
          return async (...args: unknown[]) => {
            updates += 1;
            if (updates === failAt) throw new Error('fake notifiedAt write failure');
            return (value as (...a: unknown[]) => Promise<unknown>).apply(
              target,
              args,
            );
          };
        }
        if (typeof value === 'function') {
          return (...args: unknown[]) => {
            const result = (value as (...a: unknown[]) => unknown).apply(
              target,
              args,
            );
            return result !== null &&
              typeof result === 'object' &&
              'execute' in result
              ? wrap(result)
              : result;
          };
        }
        return value;
      },
    });
  query.updateTable = (table: string) => wrap(original.call(query, table));
  try {
    await run();
  } finally {
    query.updateTable = original;
  }
}

test('验收32：八天未处理、有提交人的单扫出一条提醒；再扫不发第二条', async ({
  connection,
}) => {
  const id = await insertCase(connection);
  const fake = fakeNotifier();

  await scan(connection, fake.notifier, NOW);

  expect(fake.sent).toHaveLength(1);
  expect(fake.sent[0].idempotencyKey).toBe(`feedback-reminder:${id}:1`);
  const rows = await remindersOf(connection);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    feedbackId: id,
    attempts: 1,
    lastKey: `feedback-reminder:${id}:1`,
  });
  expect(rows[0].notifiedAt).not.toBeNull();

  await scan(connection, fake.notifier, NOW);
  expect(fake.sent).toHaveLength(1);
  expect(await remindersOf(connection)).toHaveLength(1);
});

test('验收32：六天前、已丢弃、outcome 已 reviewed、没有提交人的四种都不发', async ({
  connection,
}) => {
  await insertCase(connection, { id: 'fresh-six-days', createdDaysAgo: 6 });
  await insertCase(connection, { id: 'discarded', status: 'discarded' });
  await insertCase(connection, { id: 'reviewed', outcome: 'reviewed' });
  await insertCase(connection, { id: 'no-submitter', ownerId: null });
  const fake = fakeNotifier();

  await scan(connection, fake.notifier, NOW);

  expect(fake.sent).toHaveLength(0);
  expect(await remindersOf(connection)).toHaveLength(0);
});

test('验收33a：发送抛错时记录还在、发出时间为空；下一回换钥匙再发并记上时间', async ({
  connection,
}) => {
  const id = await insertCase(connection);
  const fake = fakeNotifier();
  fake.setBehavior(async () => {
    throw new Error('fake notification unavailable');
  });

  await scan(connection, fake.notifier, NOW);

  expect(fake.sent).toHaveLength(1);
  const afterThrow = await remindersOf(connection);
  expect(afterThrow).toHaveLength(1);
  expect(afterThrow[0].notifiedAt).toBeNull();
  expect(afterThrow[0].attempts).toBe(1);

  fake.setBehavior(fake.completed);
  await scan(connection, fake.notifier, later());

  expect(fake.sent).toHaveLength(2);
  expect(fake.sent[1].idempotencyKey).toBe(`feedback-reminder:${id}:2`);
  expect(fake.sent[0].idempotencyKey).not.toBe(fake.sent[1].idempotencyKey);
  const rows = await remindersOf(connection);
  expect(rows[0].attempts).toBe(2);
  expect(rows[0].notifiedAt).not.toBeNull();

  await scan(connection, fake.notifier, later(2));
  expect(fake.sent).toHaveLength(2);
});

test('验收33b：发成功但没记上时间，下一回按旧钥匙查到已完成，只补时间不再发', async ({
  connection,
}) => {
  const id = await insertCase(connection);
  const fake = fakeNotifier();

  await scan(connection, fake.notifier, NOW);
  // 模拟「记发出时间那一步出错」：通知侧已经完成，但本地时间没落库。
  await connection.query
    .updateTable('fqcFeedbackReminders')
    .set({ notifiedAt: null })
    .where('feedbackId', '=', id)
    .execute();

  await scan(connection, fake.notifier, later());

  expect(fake.sent).toHaveLength(1);
  const rows = await remindersOf(connection);
  expect(rows).toHaveLength(1);
  expect(rows[0].notifiedAt).not.toBeNull();
  expect(rows[0].attempts).toBe(1);
});

test('验收33c：结果不明不满一天不重发，通知那一行满一天仍不明才换钥匙', async ({
  connection,
}) => {
  const id = await insertCase(connection);
  const fake = fakeNotifier();
  fake.setBehavior(async (message) => {
    fake.record(message.idempotencyKey, 'unknown');
    return 'unknown';
  });

  await scan(connection, fake.notifier, NOW);
  expect(fake.sent).toHaveLength(1);
  expect((await remindersOf(connection))[0].notifiedAt).toBeNull();

  // 过了半天：旧钥匙还是 unknown，但通知行的更新时间不满一天，不动它。
  fake.clock.now = new Date(NOW.getTime() + 12 * 60 * 60 * 1000);
  await scan(connection, fake.notifier, fake.clock.now);
  expect(fake.sent).toHaveLength(1);

  // 过了两天：把旧钥匙标成满一天前仍是 unknown，下一回换一把新钥匙。
  fake.record(`feedback-reminder:${id}:1`, 'unknown', new Date(NOW.getTime() - 2 * DAY));
  fake.clock.now = new Date(NOW.getTime() + 2 * DAY);
  fake.setBehavior(fake.completed);
  await scan(connection, fake.notifier, fake.clock.now);

  expect(fake.sent).toHaveLength(2);
  expect(fake.sent[1].idempotencyKey).toBe(`feedback-reminder:${id}:2`);
  expect((await remindersOf(connection))[0].notifiedAt).not.toBeNull();
});

test('验收33d：连续五回都不成功，第六回不再调发送器，只记一行日志', async ({
  connection,
}) => {
  const id = await insertCase(connection);
  const fake = fakeNotifier();
  const log: string[] = [];
  let failures = 0;
  fake.setBehavior(async (message) => {
    failures += 1;
    if (failures <= 5) {
      fake.record(message.idempotencyKey, 'failed');
      throw new Error('fake failure');
    }
    return fake.completed(message);
  });

  for (let round = 0; round < 6; round += 1) {
    await scan(connection, fake.notifier, later(round), (message) =>
      log.push(message),
    );
  }

  expect(fake.sent).toHaveLength(5);
  expect(new Set(fake.sent.map((item) => item.idempotencyKey)).size).toBe(5);
  expect(log).toHaveLength(1);
  expect(log[0]).toContain(id);
  const rows = await remindersOf(connection);
  expect(rows).toHaveLength(1);
  expect(rows[0].attempts).toBe(5);
  expect(rows[0].notifiedAt).toBeNull();
});

test('收件只解析服务端用户标识：通知内容不带原文、邮箱与手机号', async ({
  connection,
}) => {
  const contact = 'zhangsan@example.test / 13812345678';
  await insertCase(connection, { ownerId: 'user-abc-123', senderContact: contact });
  const fake = fakeNotifier();

  await scan(connection, fake.notifier, NOW);

  expect(fake.sent).toHaveLength(1);
  const message = fake.sent[0];
  expect(message.to).toBe('user-abc-123');
  const serialized = JSON.stringify(message);
  expect(serialized).not.toContain('客户原文不能出现在提醒里');
  expect(serialized).not.toContain('zhangsan@example.test');
  expect(serialized).not.toContain('13812345678');
  expect(serialized).not.toContain('@');
});

test('两轮扫描交叠（上一轮发送没落地、下一轮已经开始）不产生重复提醒', async ({
  connection,
}) => {
  await insertCase(connection);
  const fake = fakeNotifier();
  let started!: () => void;
  const didStart = new Promise<void>((resolve) => {
    started = resolve;
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let sends = 0;
  fake.setBehavior(async (message) => {
    // 真实的 NotificationManager.sendInternal 要过若干次 await 才落幂等键：
    // 第一回发送已经开跑、查状态却还查不到。落键放到门后，如实暴露那个窗口。
    // 只扣第一回，后面的回合一到就完成：没有认领保护时要能直接断言出重复，
    // 而不是让测试卡在门上超时。
    sends += 1;
    if (sends === 1) {
      started();
      await gate;
    }
    fake.record(message.idempotencyKey, 'completed');
    return 'completed';
  });

  const first = scan(connection, fake.notifier, NOW);
  await didStart; // 第一轮已经抢占并扣在发送里
  const second = scan(connection, fake.notifier, NOW);
  await expect(second).resolves.toBeUndefined();
  release();
  await expect(first).resolves.toBeUndefined();

  expect(fake.sent).toHaveLength(1);
  const rows = await remindersOf(connection);
  expect(rows).toHaveLength(1);
  expect(rows[0].attempts).toBe(1);
});

test('两轮同时读到同一回数时，带谓词的更新只让一轮发出', async ({
  connection,
}) => {
  const id = await insertCase(connection);
  const staleKey = `feedback-reminder:${id}:0`;
  await seedReminder(connection, id, 0, staleKey);
  const fake = fakeNotifier();

  // 把两轮都扣在「按旧钥匙查状态」里，放出来时它们读到的是同一个回数 0。
  // 没有带谓词的更新，两边都会把回数改成 1 并各发一次。
  let arrived = 0;
  let bothArrived!: () => void;
  const both = new Promise<void>((resolve) => {
    bothArrived = resolve;
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  fake.notifier.getByIdempotencyKey = async () => {
    arrived += 1;
    if (arrived === 2) bothArrived();
    await gate;
    return undefined;
  };

  const first = scan(connection, fake.notifier, NOW);
  const second = scan(connection, fake.notifier, NOW);
  await both;
  release();
  await expect(first).resolves.toBeUndefined();
  await expect(second).resolves.toBeUndefined();

  expect(fake.sent).toHaveLength(1);
  expect(new Set(fake.sent.map((item) => item.idempotencyKey)).size).toBe(1);
  expect((await remindersOf(connection))[0].attempts).toBe(1);
});

test('记发出时间那一步真抛错：后面的候选照发，下一轮按旧钥匙补记且不重发', async ({
  connection,
}) => {
  await insertCase(connection, { id: 'first-row' });
  await insertCase(connection, { id: 'second-row' });
  const fake = fakeNotifier();
  const log: string[] = [];

  // 第 2 次更新是第一条候选记 notifiedAt 的那一次；让它真的抛错。
  await withFailingUpdate(connection, 2, async () => {
    await scan(connection, fake.notifier, NOW, (message) => log.push(message));
  });

  const rows = await remindersOf(connection);
  expect(rows).toHaveLength(2);
  expect(fake.sent).toHaveLength(2);
  const unnotified = rows.find((row) => row.notifiedAt === null);
  expect(unnotified, '恰好有一条候选没记上时间').toBeDefined();
  expect(log.join(' ')).toContain(unnotified!.feedbackId);
  expect(rows.filter((row) => row.notifiedAt !== null)).toHaveLength(1);

  // 下一轮：没记上时间的那条按旧钥匙查到已完成，只补时间；假的不再被调用。
  await scan(connection, fake.notifier, later(), (message) => log.push(message));
  expect(fake.sent).toHaveLength(2);
  const after = await remindersOf(connection);
  expect(after.every((row) => row.notifiedAt !== null)).toBe(true);
});
