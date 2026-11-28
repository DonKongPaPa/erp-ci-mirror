import { createDatabaseTest } from '@nocobase/app-testing/server';
import type { DatabaseConnection } from '@nocobase/db';
import { expect } from 'vitest';

import {
  scanApprovalTimeouts,
  type ScanApprovalTimeoutsOptions,
} from '../../server/approval-timeout.js';
import type { ApprovalNotificationEvent } from '../../server/approval-notifications.js';

/**
 * R-017 M4：任务级超时扫描的可控时钟测试。真库、真条件更新，
 * 通知器是假的，连 Postgres 的测试 schema，不碰开发库。
 */
const test = createDatabaseTest();

async function createCollections(connection: DatabaseConnection) {
  await connection.builder.createCollection('approvals', (c) => {
    c.string('id', { length: 64 }).primary().notNull();
    c.string('status', { length: 32 }).notNull().defaultTo('draft');
    c.string('workflowKey', { length: 64 }).notNull().defaultTo('leave');
    c.string('applicantId', { length: 64 }).notNull().defaultTo('applicant');
  });
  await connection.builder.createCollection('approvalRounds', (c) => {
    c.string('id', { length: 64 }).primary().notNull();
    c.string('approvalId', { length: 64 }).notNull();
  });
  await connection.builder.createCollection('approvalRecords', (c) => {
    c.string('id', { length: 64 }).primary().notNull();
    c.string('roundId', { length: 64 }).notNull();
    c.string('assigneeId', { length: 64 }).notNull();
    c.string('status', { length: 32 }).notNull();
    c.datetimeTz('dueAt').nullable();
    c.datetimeTz('lastRemindedAt').nullable();
  });
}

function notifier() {
  const sent: ApprovalNotificationEvent[] = [];
  return {
    sent,
    notify: async (event: ApprovalNotificationEvent) => {
      sent.push(event);
      return true;
    },
  };
}

/**
 * 造数据用的时钟必须就是扫描时传入的那个 `now`：到期时间按它减一分钟算。
 * 原先这里取真实时间、扫描却用写死的时刻 —— 真实时间一过那个时刻，任务相对写死的时钟
 * 就「还没到期」，测试从此永远红（镜像全量 `46099900006`，2026-11-28 03:18Z 之后）。
 */
async function seedRow(
  connection: DatabaseConnection,
  status = 'pending',
  now = new Date(),
) {
  await connection.query
    .insertInto('approvals')
    .values({ id: 'approval-1', status: 'submitted' })
    .execute();
  await connection.query
    .insertInto('approvalRounds')
    .values({ id: 'round-1', approvalId: 'approval-1' })
    .execute();
  await connection.query
    .insertInto('approvalRecords')
    .values({
      id: 'task-1',
      roundId: 'round-1',
      assigneeId: 'approver-1',
      status,
      dueAt: new Date(now.getTime() - 60_000),
      lastRemindedAt: null,
    })
    .execute();
}

test('R-017 任务级超时：到期只提醒一次，重复扫描不再发', async ({ connection }) => {
  await createCollections(connection);
  const now = new Date('2026-11-28T02:00:00.000Z');
  await seedRow(connection, 'pending', now);
  const fake = notifier();
  const options: ScanApprovalTimeoutsOptions = { connection, notifier: fake, now };
  expect(await scanApprovalTimeouts(options)).toBe(1);
  expect(fake.sent).toHaveLength(1);
  expect(fake.sent[0]?.kind).toBe('reminder');
  expect(fake.sent[0]?.taskId).toBe('task-1');
  expect(await scanApprovalTimeouts(options)).toBe(0);
  expect(fake.sent).toHaveLength(1);
  const row = await connection.query
    .selectFrom('approvalRecords')
    .select(['lastRemindedAt'])
    .where('id', '=', 'task-1')
    .executeTakeFirstOrThrow();
  expect(row.lastRemindedAt).not.toBeNull();
});

test('R-017 任务级超时：未到期、已处理、已提醒的任务都不发', async ({ connection }) => {
  await createCollections(connection);
  const now = new Date('2026-11-28T02:00:00.000Z');
  await seedRow(connection, 'approved', now);
  const fake = notifier();
  expect(await scanApprovalTimeouts({ connection, notifier: fake, now })).toBe(0);
  expect(fake.sent).toHaveLength(0);
});
