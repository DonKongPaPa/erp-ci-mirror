import { createDatabaseTest } from '@nocobase/app-testing/server';
import type { DatabaseConnection, DatabaseManager } from '@nocobase/db';
import {
  createRepositoryLifecycleStore,
  LifecycleError,
  LifecycleRuntime,
  SYSTEM_ACTOR,
} from '@nocobase/lifecycle';
import { expect } from 'vitest';

import {
  approvalExpectation,
  pendingTaskClaim,
} from '../../server/lifecycles/approvals-engine.js';
import { approvalsLifecycle } from '../../server/lifecycles/approvals.js';

/**
 * R-017 S3：版本条件更新只信真仓储。这里不建迁移、不起应用，只在测试库自己的
 * schema 里临时建出审批单表与 lifecycle 两张日志表，用真实的 Repository store
 * 跑两个并发决策，断言至多一个生效。任务行的 status 谓词也用真库的条件更新验。
 */
const test = createDatabaseTest();

async function createApprovalCollections(connection: DatabaseConnection) {
  await connection.builder.createCollection('approvals', (c) => {
    c.string('id', { length: 64 }).primary().notNull();
    c.string('status', { length: 32 }).notNull().defaultTo('draft');
    c.datetimeTz('statusChangedAt').nullable();
    c.integer('lifecycleVersion').notNull().defaultTo(0);
    c.string('lifecycleDefinition', { length: 64 }).nullable();
    c.string('workflowKey', { length: 64 }).nullable();
    c.string('applicantId', { length: 64 }).nullable();
    c.integer('currentRound').notNull().defaultTo(0);
  });
  await connection.builder.createCollection('approvalTestTasks', (c) => {
    c.string('id', { length: 64 }).primary().notNull();
    c.string('status', { length: 32 }).notNull();
    c.datetimeTz('dueAt').nullable();
    c.datetimeTz('lastRemindedAt').nullable();
  });
  // 列清单照 tests/fixtures/submission/migration.ts，仓储就按这两张表写日志。
  await connection.builder.createCollection('lifecycleTransitions', (c) => {
    c.bigInt('id').primary().autoIncrement().notNull();
    c.string('lifecycle').notNull();
    c.string('recordId').notNull();
    c.string('transition').notNull();
    c.string('from').nullable();
    c.string('to').notNull();
    c.string('actorId').notNull();
    c.json('input').notNull();
    c.datetimeTz('at').notNull();
    c.integer('version').notNull();
    c.string('requestId').nullable();
    c.string('requestKey').notNull();
    c.unique(['lifecycle', 'recordId', 'version']);
    c.unique(['lifecycle', 'recordId', 'requestKey']);
  });
  await connection.builder.createCollection('lifecycleEffectRuns', (c) => {
    c.bigInt('id').primary().autoIncrement().notNull();
    c.bigInt('transitionId').notNull();
    c.string('lifecycle').notNull();
    c.string('recordId').notNull();
    c.string('effect').notNull();
    c.boolean('stayBound').notNull();
    c.string('status').notNull();
    c.integer('attempts').notNull();
    c.integer('maxAttempts').notNull();
    c.json('result').nullable();
    c.text('error').nullable();
    c.datetimeTz('createdAt').notNull();
    c.datetimeTz('updatedAt').notNull();
    c.datetimeTz('claimedAt').nullable();
    c.datetimeTz('runAfter').nullable();
    c.json('continuation').nullable();
    c.datetimeTz('continuationDueAt').nullable();
    c.datetimeTz('continuationAbandonedAt').nullable();
  });
}

async function runtimeOf(database: DatabaseManager) {
  const runtime = new LifecycleRuntime({
    store: createRepositoryLifecycleStore(database),
  });
  runtime.register(approvalsLifecycle);
  return runtime;
}

async function insertApproval(
  connection: DatabaseConnection,
  id = 'approval-1',
) {
  await connection.query
    .insertInto('approvals')
    .values({
      id,
      status: 'submitted',
      statusChangedAt: new Date('2026-11-26T00:00:00.000Z'),
      lifecycleVersion: 0,
      lifecycleDefinition: 'approvals',
      workflowKey: 'leave',
      applicantId: 'applicant',
      currentRound: 1,
    })
    .execute();
}

test('R-017 验收并发：两个审批人同时处理同一张单，至多一个生效', async ({
  database,
  connection,
}) => {
  await createApprovalCollections(connection);
  await insertApproval(connection);
  const runtime = await runtimeOf(database);

  const [left, right] = await Promise.allSettled([
    runtime.fire('approvals', 'approval-1', 'approve', {
      actor: { id: 'approver-a' },
      expect: approvalExpectation({ lifecycleVersion: 0 }),
    }),
    runtime.fire('approvals', 'approval-1', 'approve', {
      actor: { id: 'approver-b' },
      expect: approvalExpectation({ lifecycleVersion: 0 }),
    }),
  ]);

  const codes = [left, right].map((outcome) =>
    outcome.status === 'fulfilled'
      ? 'ok'
      : outcome.reason instanceof LifecycleError
        ? outcome.reason.code
        : 'unknown',
  );
  expect(codes.filter((code) => code === 'ok')).toHaveLength(1);
  expect(codes.filter((code) => code === 'CONFLICT')).toHaveLength(1);

  const row = await connection.query
    .selectFrom('approvals')
    .select(['status', 'lifecycleVersion'])
    .where('id', '=', 'approval-1')
    .executeTakeFirstOrThrow();
  expect(row.status).toBe('approved');
  expect(row.lifecycleVersion).toBe(1);
  const logs = await connection.query
    .selectFrom('lifecycleTransitions')
    .select(['id'])
    .where('recordId', '=', 'approval-1')
    .execute();
  expect(logs).toHaveLength(1);
});

test('R-017 验收并发：旧版本页面上的决策被版本条件挡下', async ({
  database,
  connection,
}) => {
  await createApprovalCollections(connection);
  await insertApproval(connection);
  const runtime = await runtimeOf(database);

  await runtime.fire('approvals', 'approval-1', 'process', {
    actor: SYSTEM_ACTOR,
    expect: approvalExpectation({ lifecycleVersion: 0 }),
  });
  await expect(
    runtime.fire('approvals', 'approval-1', 'approve', {
      actor: { id: 'stale-approver' },
      expect: approvalExpectation({ lifecycleVersion: 0 }),
    }),
  ).rejects.toMatchObject({ code: 'CONFLICT' });

  const row = await connection.query
    .selectFrom('approvals')
    .select(['status', 'lifecycleVersion'])
    .where('id', '=', 'approval-1')
    .executeTakeFirstOrThrow();
  expect([row.status, row.lifecycleVersion]).toEqual(['processing', 1]);
});

test('R-017 验收并发：任务行 status 谓词抢占，两个条件更新只有一个成功', async ({
  connection,
}) => {
  await createApprovalCollections(connection);
  await connection.query
    .insertInto('approvalTestTasks')
    .values({
      id: 'task-1',
      status: 'pending',
    })
    .execute();
  const claim = pendingTaskClaim({ id: 'task-1', status: 'pending' });
  const update = () =>
    connection.query
      .updateTable('approvalTestTasks')
      .set({ status: 'approved' })
      .where('id', '=', claim.id)
      .where('status', '=', claim.where.status)
      .execute();

  const [left, right] = await Promise.all([update(), update()]);
  expect(
    [left, right].filter((result) => result.updatedCount === 1),
  ).toHaveLength(1);
  const row = await connection.query
    .selectFrom('approvalTestTasks')
    .select('status')
    .where('id', '=', 'task-1')
    .executeTakeFirstOrThrow();
  expect(row.status).toBe('approved');
});
