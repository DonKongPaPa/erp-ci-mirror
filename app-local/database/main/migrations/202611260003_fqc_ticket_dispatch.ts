import { defineMigration, type MigrationDefinition } from '@nocobase/db';

/**
 * R-003 第一个切片：工单的列、派单规则表与存量迁移。
 *
 * 一条新迁移，不改已经执行过的三条。四件事：
 *
 * - `fqcTickets` 加七列：`departmentId`（责任部门，可空、索引）、`createdBy`
 *   （确认并派单的人）、`resolution`（处理说明）、`reopenCount`（重开次数，非空默认 0）、
 *   `statusChangedAt`（最近流转时间，`datetimeTz`）、`lifecycleVersion`（非空默认 0）、
 *   `lifecycleDefinition`（绑定哪个定义）。`state` 就是状态列，不另加 `status`；
 *   `ownerDepartment` 与 `dueAt` 留着不再写入；不建外键。
 * - `screeningId` 上加唯一约束：一份草稿至多一张工单，由数据库裁决。**不在加约束前
 *   去重**：一份草稿一张单是投递路径构造上的保证；真出现重复时宁可让迁移失败，
 *   也不要悄悄删掉业务数据。失败时先查出同一 `screeningId` 的重复工单、交人工处理，
 *   处理完再重跑本迁移（主会话裁决）。
 * - 存量 `lifecycleDefinition` 回填成 `'fqcTickets'`，即生命周期定义的 `name`。
 *   **后面定义 lifecycle 的那一片（S5）必须用同一个 name**，否则 `checkBinding` 会抛
 *   `DEFINITION_MISMATCH`；`key` / `version` 不是存在这一列的值。
 * - 新建 `fqcRoutingRules`：一个类别一个责任部门，类别是主键，`updatedAt` 与
 *   `updatedBy` 都非空。七行数据由维护派单规则的页面写，不在这里 seed。
 * - 存量：初筛的 `auto` 改成 `suggested`（确认之后不再有「自动」）；存量工单的
 *   `lifecycleDefinition` 回填成生命周期定义的 `name`，不能留空 —— 运行时对没有
 *   绑定定义的记录直接抛 `DEFINITION_MISMATCH`，「第一次流转时补上」不成立。
 *
 * 时间列按各自的表来：工单的流转时间带时区（lifecycle 要的 `datetimeTz`），派单
 * 规则表与其余业务列一致用不带时区的 `datetime`。外键不建：与本项目其余业务表一致，
 * 关联由服务层按标识读。
 */

/** 工单的唯一约束名。改它等于改库结构，`down` 用的也是这个名字。 */
const UNIQUE_SCREENING = 'uq_fqc_tickets_screening';

/**
 * 生命周期定义的 `name`。回填必须是它：`checkBinding` 拿记录上的值和 `lifecycle.name`
 * 比，`key` / `version` 不是存在这一列的值。S5 注册定义时必须用同一个 name。
 */
const DEFINITION_NAME = 'fqcTickets';

const NEW_TICKET_FIELDS = [
  'departmentId',
  'createdBy',
  'resolution',
  'reopenCount',
  'statusChangedAt',
  'lifecycleVersion',
  'lifecycleDefinition',
] as const;

const migration: MigrationDefinition = defineMigration({
  name: '202611260003_fqc_ticket_dispatch',
  async up({ builder, query }) {
    await builder.alterCollection('fqcTickets', (collection) => {
      collection.string('departmentId', { length: 64 }).nullable();
      collection.string('createdBy', { length: 64 }).nullable();
      collection.text('resolution').nullable();
      collection.integer('reopenCount').notNull().defaultTo(0);
      collection.datetimeTz('statusChangedAt').nullable();
      collection.integer('lifecycleVersion').notNull().defaultTo(0);
      collection.string('lifecycleDefinition', { length: 64 }).nullable();
      collection.index('departmentId', { name: 'ix_fqc_tickets_department' });
      collection.unique('screeningId', { name: UNIQUE_SCREENING });
    });

    await builder.createCollection('fqcRoutingRules', (collection) => {
      collection.string('category', { length: 64 }).notNull();
      collection.string('departmentId', { length: 64 }).notNull();
      collection.datetime('updatedAt').notNull();
      collection.string('updatedBy', { length: 64 }).notNull();
      collection.primary('category', { name: 'pk_fqc_routing_rules' });
    });

    // 确认之后不再有「自动」：auto 只剩「复核线以上、不用优先复核」的意思。
    await query
      .updateTable('fqcScreenings')
      .set({ outcome: 'suggested' })
      .where('outcome', '=', 'auto')
      .execute();

    // 存量工单补上定义绑定。留空会让第一次流转抛 DEFINITION_MISMATCH。
    await query
      .updateTable('fqcTickets')
      .set({ lifecycleDefinition: DEFINITION_NAME })
      .where('lifecycleDefinition', 'is', null)
      .execute();
  },
  async down({ builder }) {
    // 不把 suggested 改回 auto，也不把 lifecycleDefinition 清空：中间可能已经
    // 流转或改判过，改回去会丢掉事实；这一列随字段一起删掉。
    await builder.alterCollection('fqcTickets', (collection) => {
      collection.dropConstraint(UNIQUE_SCREENING);
      for (const field of NEW_TICKET_FIELDS) {
        collection.dropField(field);
      }
    });
    await builder.dropCollection('fqcRoutingRules');
  },
});

export default migration;
