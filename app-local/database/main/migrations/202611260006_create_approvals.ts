import { defineMigration, type MigrationDefinition } from '@nocobase/db';

/**
 * R-017 S1：审批单、轮次与审批任务三张业务表。
 *
 * 一条新迁移，不改已经执行过的五条。数据模型照 R-017.md:11-59：
 *
 * - `approvals`        审批单。雪花字符串主键，业务表名与记录键、流程定义 key、
 *                      申请人、状态与当前轮次；lifecycle 的三列（定义字段、状态
 *                      变化时间、版本号）照 fqcTickets 的建法。状态是字符串枚举，
 *                      不建 DB 枚举列（映射写在代码里）。唯一指定的索引是
 *                      (status, statusChangedAt)，供定时扫描用。
 * - `approvalRounds`   轮次。退回重提开新的一轮，历史轮次留痕；`snapshot` 是这一轮
 *                      提交时的业务单据数据快照，审批人看的是提交当时的数据。
 * - `approvalRecords`  任务/票。序号 `seq` 供依次审批与加签重排用；`origin` 记普通、
 *                      转交生成、加签生成；`prevRecordId` 串成转交加签链；
 *                      `lastRemindedAt` 可空，靠条件更新保证一条任务只提醒一次。
 *
 * 设计没写长度、可空性与默认值的地方，按相邻建法取，并在 R-017.md 回写：
 * 标识列 64、状态列 32（同 fqcTickets.state）、计数器默认 0（同 reopenCount）、
 * 生命周期三列同 fqcTickets 的建法；round 从 1 开始由服务写，不设默认值。
 * 所有时间列用 datetimeTz（同 fqcTickets.statusChangedAt 与调研稿），`dueAt`
 * 可空：不配超时的节点与依次审批里还没开放的 assigned 记录没有到期时间，
 * 引擎把空值当「不到期」。`lastRemindedAt` 同样可空。三张表都不建外键：
 * 关联由服务层按标识读（同部门表与员工表）。
 *
 * 约束便宜、以后补要开迁移，所以一次建齐：`approvalRounds` 的 (approvalId, round)
 * 唯一（一轮只有一个轮次号）；`approvalRecords` 的 (assigneeId, status) 供「我的待办」，
 * (status, dueAt) 供超时扫描。名字写死，`down` 随表一起消失。
 *
 * `down` 按相反顺序显式删三张表：表没了，索引与主键约束也一起没了。
 */
const migration: MigrationDefinition = defineMigration({
  name: '202611260006_create_approvals',
  async up({ builder }) {
    await builder.createCollection('approvals', (collection) => {
      collection.string('id', { length: 64 }).notNull();
      collection.string('collectionName', { length: 64 }).notNull();
      collection.string('dataKey', { length: 64 }).notNull();
      collection.string('workflowKey', { length: 64 }).notNull();
      collection.string('status', { length: 32 }).notNull();
      collection.string('applicantId', { length: 64 }).notNull();
      collection.integer('currentRound').notNull().defaultTo(0);
      collection.datetimeTz('createdAt').notNull();
      collection.datetimeTz('updatedAt').notNull();
      collection.string('lifecycleDefinition', { length: 64 }).nullable();
      collection.datetimeTz('statusChangedAt').nullable();
      collection.integer('lifecycleVersion').notNull().defaultTo(0);
      collection.primary('id', { name: 'pk_approvals' });
      collection.index(['status', 'statusChangedAt'], {
        name: 'ix_approvals_status_changed_at',
      });
    });

    await builder.createCollection('approvalRounds', (collection) => {
      collection.string('id', { length: 64 }).notNull();
      collection.string('approvalId', { length: 64 }).notNull();
      collection.integer('round').notNull();
      collection.string('status', { length: 32 }).notNull();
      collection.datetimeTz('startedAt').notNull();
      collection.datetimeTz('endedAt').nullable();
      collection.json('snapshot').notNull();
      collection.primary('id', { name: 'pk_approval_rounds' });
      collection.unique(['approvalId', 'round'], {
        name: 'uq_approval_rounds_approval_round',
      });
    });

    await builder.createCollection('approvalRecords', (collection) => {
      collection.string('id', { length: 64 }).notNull();
      collection.string('roundId', { length: 64 }).notNull();
      collection.string('nodeKey', { length: 64 }).notNull();
      collection.string('assigneeId', { length: 64 }).notNull();
      collection.string('status', { length: 32 }).notNull();
      collection.text('comment').nullable();
      collection.datetimeTz('actedAt').nullable();
      collection.string('prevRecordId', { length: 64 }).nullable();
      collection.integer('seq').notNull().defaultTo(0);
      collection.string('origin', { length: 16 }).notNull().defaultTo('normal');
      collection.datetimeTz('dueAt').nullable();
      collection.datetimeTz('lastRemindedAt').nullable();
      collection.primary('id', { name: 'pk_approval_records' });
      collection.index(['assigneeId', 'status'], {
        name: 'ix_approval_records_assignee_status',
      });
      collection.index(['status', 'dueAt'], {
        name: 'ix_approval_records_status_due_at',
      });
    });
  },
  async down({ builder }) {
    await builder.dropCollection('approvalRecords');
    await builder.dropCollection('approvalRounds');
    await builder.dropCollection('approvals');
  },
});

export default migration;
