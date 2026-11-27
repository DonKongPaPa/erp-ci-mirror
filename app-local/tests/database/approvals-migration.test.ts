import path from 'node:path';
import { describeMigration } from '@nocobase/app-testing/server';
import { describe, expect } from 'vitest';

/**
 * R-017 S1：审批三张表由一条迁移建出，列逐项钉在物理结构上。
 *
 * 一条新迁移建 approvals、approvalRounds、approvalRecords，照设计
 * R-017.md:11-59。字段的类型、长度、可空性逐项断言；默认值靠真插一行读回来
 * 钉住，因为 expectCollection 不读默认值。状态列不建 DB 枚举（设计
 * R-017.md:27 只要求代码映射），只有 (status, statusChangedAt) 的联合索引；
 * 三张表都不建外键（以 userId 为键的表同理 R-012），down 后干净消失。
 *
 * 设计没有写长度、可空性与默认值的地方，按相邻建法取并在设计里回写：
 * 标识列 64、状态列 32（同 fqcTickets.state）、计数器默认 0（同 reopenCount）、
 * 生命周期三列同 fqcTickets 的建法；round 由服务写成从 1 开始，不设默认值。
 * 所有时间列是 datetimeTz；dueAt 可空（不配超时或依次未开放的任务没有到期时间）。
 */
const sources = [
  {
    packageName: 'approvals-migration-test',
    directory: path.resolve(
      import.meta.dirname,
      '../../database/main/migrations',
    ),
  },
];

const APPROVAL_FIELDS = [
  'applicantId',
  'collectionName',
  'createdAt',
  'currentRound',
  'dataKey',
  'id',
  'lifecycleDefinition',
  'lifecycleVersion',
  'status',
  'statusChangedAt',
  'updatedAt',
  'workflowKey',
];

const ROUND_FIELDS = [
  'approvalId',
  'endedAt',
  'id',
  'round',
  'snapshot',
  'startedAt',
  'status',
];

const RECORD_FIELDS = [
  'actedAt',
  'assigneeId',
  'comment',
  'dueAt',
  'id',
  'lastRemindedAt',
  'nodeKey',
  'origin',
  'prevRecordId',
  'roundId',
  'seq',
  'status',
];

describe('R-017 S1：审批单、轮次与审批任务的迁移', () => {
  describeMigration('202611260006_create_approvals', {
    sources,
    up: async ({ connection, expectCollection }) => {
      const approvals = await expectCollection('approvals').toExist();
      expect(approvals.primaryKey).toEqual(['id']);
      expect(Object.keys(approvals.fields).sort()).toEqual(APPROVAL_FIELDS);
      await expectCollection('approvals').toHaveField('id', {
        type: 'string',
        length: 64,
        nullable: false,
      });
      for (const field of [
        'collectionName',
        'dataKey',
        'workflowKey',
        'applicantId',
      ] as const) {
        await expectCollection('approvals').toHaveField(field, {
          type: 'string',
          length: 64,
          nullable: false,
        });
      }
      await expectCollection('approvals').toHaveField('status', {
        type: 'string',
        length: 32,
        nullable: false,
      });
      await expectCollection('approvals').toHaveField('currentRound', {
        type: 'integer',
        nullable: false,
      });
      for (const field of ['createdAt', 'updatedAt'] as const) {
        await expectCollection('approvals').toHaveField(field, {
          type: 'datetimeTz',
          nullable: false,
        });
      }
      await expectCollection('approvals').toHaveField('lifecycleDefinition', {
        type: 'string',
        length: 64,
        nullable: true,
      });
      await expectCollection('approvals').toHaveField('statusChangedAt', {
        type: 'datetimeTz',
        nullable: true,
      });
      await expectCollection('approvals').toHaveField('lifecycleVersion', {
        type: 'integer',
        nullable: false,
      });
      // 唯一指定的索引：定时扫描按状态与最近变化时间推进。
      await expectCollection('approvals').toHaveIndex([
        'status',
        'statusChangedAt',
      ]);
      expect(approvals.indexes).toHaveLength(1);
      expect(approvals.foreignKeys).toHaveLength(0);

      const rounds = await expectCollection('approvalRounds').toExist();
      expect(rounds.primaryKey).toEqual(['id']);
      expect(Object.keys(rounds.fields).sort()).toEqual(ROUND_FIELDS);
      for (const field of ['id', 'approvalId'] as const) {
        await expectCollection('approvalRounds').toHaveField(field, {
          type: 'string',
          length: 64,
          nullable: false,
        });
      }
      await expectCollection('approvalRounds').toHaveField('round', {
        type: 'integer',
        nullable: false,
      });
      await expectCollection('approvalRounds').toHaveField('status', {
        type: 'string',
        length: 32,
        nullable: false,
      });
      await expectCollection('approvalRounds').toHaveField('startedAt', {
        type: 'datetimeTz',
        nullable: false,
      });
      await expectCollection('approvalRounds').toHaveField('endedAt', {
        type: 'datetimeTz',
        nullable: true,
      });
      await expectCollection('approvalRounds').toHaveField('snapshot', {
        type: 'json',
        nullable: false,
      });
      // 一轮只有一个轮次号：唯一约束便宜，以后补要开迁移。
      await expectCollection('approvalRounds').toHaveIndex(['approvalId', 'round'], {
        unique: true,
      });
      expect(rounds.indexes).toHaveLength(1);
      expect(rounds.foreignKeys).toHaveLength(0);

      const records = await expectCollection('approvalRecords').toExist();
      expect(records.primaryKey).toEqual(['id']);
      expect(Object.keys(records.fields).sort()).toEqual(RECORD_FIELDS);
      for (const field of [
        'id',
        'roundId',
        'nodeKey',
        'assigneeId',
      ] as const) {
        await expectCollection('approvalRecords').toHaveField(field, {
          type: 'string',
          length: 64,
          nullable: false,
        });
      }
      await expectCollection('approvalRecords').toHaveField('status', {
        type: 'string',
        length: 32,
        nullable: false,
      });
      await expectCollection('approvalRecords').toHaveField('comment', {
        type: 'text',
        nullable: true,
      });
      for (const field of ['actedAt', 'dueAt', 'lastRemindedAt'] as const) {
        await expectCollection('approvalRecords').toHaveField(field, {
          type: 'datetimeTz',
          nullable: true,
        });
      }
      for (const field of ['prevRecordId'] as const) {
        await expectCollection('approvalRecords').toHaveField(field, {
          type: 'string',
          length: 64,
          nullable: true,
        });
      }
      await expectCollection('approvalRecords').toHaveField('seq', {
        type: 'integer',
        nullable: false,
      });
      await expectCollection('approvalRecords').toHaveField('origin', {
        type: 'string',
        length: 16,
        nullable: false,
      });
      // 「我的待办」与超时扫描的索引。
      await expectCollection('approvalRecords').toHaveIndex([
        'assigneeId',
        'status',
      ]);
      await expectCollection('approvalRecords').toHaveIndex(['status', 'dueAt']);
      expect(records.indexes).toHaveLength(2);
      expect(records.foreignKeys).toHaveLength(0);

      // 索引与约束的名字也要钉住：物理结构改名时 expectCollection 看不见。
      const approvalPhysical =
        await connection.schemaInspector.getPhysicalCollection({
          tableName: 'approvals',
        });
      const roundPhysical =
        await connection.schemaInspector.getPhysicalCollection({
          tableName: 'approval_rounds',
        });
      const recordPhysical =
        await connection.schemaInspector.getPhysicalCollection({
          tableName: 'approval_records',
        });
      const indexNames = (physical: typeof approvalPhysical) =>
        [...(physical?.indexes.map((index) => index.name) ?? [])].sort();
      expect(indexNames(approvalPhysical)).toEqual([
        'ix_approvals_status_changed_at',
        'pk_approvals',
      ]);
      expect(indexNames(roundPhysical)).toEqual([
        'pk_approval_rounds',
        'uq_approval_rounds_approval_round',
      ]);
      expect(indexNames(recordPhysical)).toEqual([
        'ix_approval_records_assignee_status',
        'ix_approval_records_status_due_at',
        'pk_approval_records',
      ]);

      // 默认值靠真插一行读回来：计数器默认 0，来源默认 normal；可空列保持空。
      await connection.query
        .insertInto('approvals')
        .values({
          id: 'r017-approval-1',
          collectionName: 'leaveRequests',
          dataKey: 'r017-leave-1',
          workflowKey: 'leave',
          status: 'draft',
          applicantId: 'r017-user-1',
          createdAt: '2026-11-26T09:00:00.000Z',
          updatedAt: '2026-11-26T09:00:00.000Z',
        })
        .execute();
      const approval = await connection.query
        .selectFrom('approvals')
        .selectAll()
        .where('id', '=', 'r017-approval-1')
        .executeTakeFirst();
      expect(Number(approval?.currentRound)).toBe(0);
      expect(Number(approval?.lifecycleVersion)).toBe(0);
      expect(approval?.lifecycleDefinition).toBeNull();
      expect(approval?.statusChangedAt).toBeNull();

      await connection.query
        .insertInto('approvalRounds')
        .values({
          id: 'r017-round-1',
          approvalId: 'r017-approval-1',
          round: 1,
          status: 'processing',
          startedAt: '2026-11-26T09:01:00.000Z',
          snapshot: { amount: 100 },
        })
        .execute();
      const round = await connection.query
        .selectFrom('approvalRounds')
        .selectAll()
        .where('id', '=', 'r017-round-1')
        .executeTakeFirst();
      expect(round?.endedAt).toBeNull();
      expect(round?.snapshot).toEqual({ amount: 100 });

      await connection.query
        .insertInto('approvalRecords')
        .values({
          id: 'r017-record-1',
          roundId: 'r017-round-1',
          nodeKey: 'manager',
          assigneeId: 'r017-user-2',
          status: 'pending',
        })
        .execute();
      const record = await connection.query
        .selectFrom('approvalRecords')
        .selectAll()
        .where('id', '=', 'r017-record-1')
        .executeTakeFirstOrThrow();
      expect(record.origin).toBe('normal');
      expect(Number(record.seq)).toBe(0);
      expect(record.comment).toBeNull();
      expect(record.actedAt).toBeNull();
      expect(record.dueAt, '没配超时的任务没有到期时间').toBeNull();
      expect(record.lastRemindedAt).toBeNull();
      expect(record.prevRecordId).toBeNull();
    },
    down: async ({ expectCollection }) => {
      await expectCollection('approvals').not.toExist();
      await expectCollection('approvalRounds').not.toExist();
      await expectCollection('approvalRecords').not.toExist();
    },
  });
});
