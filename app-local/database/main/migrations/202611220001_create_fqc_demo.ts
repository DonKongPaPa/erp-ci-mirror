import { defineMigration, type MigrationDefinition } from '@nocobase/db';

/**
 * FQC 客服信息收集与初筛演示。
 *
 * 建模依据（见 raw/项目决策/2026-11-22-客服FQC-AI场景细化.md）：
 * - 客户微信群消息是原始输入，AI 不对外回复，只做记录与理解
 * - AI 用知识库初筛后，派发内部分流工单
 *
 * 三张表：
 * - fqcMessages    客户消息留痕（原始输入）
 * - fqcScreenings  AI 初筛结果（分类、严重度、建议归属、置信度）
 * - fqcTickets     内部工单（分流后的处理单元）
 */
const migration: MigrationDefinition = defineMigration({
  name: '202611220001_create_fqc_demo',
  async up({ builder }) {
    await builder.createCollection('fqcMessages', (collection) => {
      collection.string('id', { length: 64 }).notNull();
      collection.string('channel', { length: 32 }).notNull();
      collection.string('externalId', { length: 128 }).nullable();
      collection.string('senderName', { length: 128 }).nullable();
      collection.string('senderContact', { length: 128 }).nullable();
      collection.text('content').notNull();
      collection.string('rawContentType', { length: 32 }).notNull();
      collection.datetime('receivedAt').notNull();
      collection.string('status', { length: 32 }).notNull();
      collection.datetime('createdAt').notNull();
      collection.datetime('updatedAt').notNull();
      collection.primary('id', { name: 'pk_fqc_messages' });
      collection.index('receivedAt', { name: 'ix_fqc_messages_received' });
      collection.index('status', { name: 'ix_fqc_messages_status' });
    });

    await builder.createCollection('fqcScreenings', (collection) => {
      collection.string('id', { length: 64 }).notNull();
      collection.string('messageId', { length: 64 }).notNull();
      collection.string('category', { length: 64 }).nullable();
      collection.string('severity', { length: 16 }).nullable();
      collection.string('suggestedOwner', { length: 64 }).nullable();
      collection.text('summary').nullable();
      collection.decimal('confidence', { precision: 5, scale: 4 }).nullable();
      collection.json('evidence').nullable();
      collection.string('modelName', { length: 128 }).nullable();
      collection.string('outcome', { length: 32 }).notNull();
      collection.datetime('createdAt').notNull();
      collection.datetime('updatedAt').notNull();
      collection.primary('id', { name: 'pk_fqc_screenings' });
      collection.index('messageId', { name: 'ix_fqc_screenings_message' });
      collection.index('category', { name: 'ix_fqc_screenings_category' });
    });

    await builder.createCollection('fqcTickets', (collection) => {
      collection.string('id', { length: 64 }).notNull();
      collection.string('code', { length: 32 }).notNull();
      collection.string('title', { length: 256 }).notNull();
      collection.text('description').nullable();
      collection.string('sourceMessageId', { length: 64 }).nullable();
      collection.string('screeningId', { length: 64 }).nullable();
      collection.string('category', { length: 64 }).nullable();
      collection.string('severity', { length: 16 }).notNull();
      collection.string('ownerDepartment', { length: 64 }).nullable();
      collection.string('assigneeId', { length: 64 }).nullable();
      collection.string('state', { length: 32 }).notNull();
      collection.datetime('dueAt').nullable();
      collection.datetime('closedAt').nullable();
      collection.datetime('createdAt').notNull();
      collection.datetime('updatedAt').notNull();
      collection.primary('id', { name: 'pk_fqc_tickets' });
      // 注意：这里曾写作 collection.index('code', { unique: true })，但 IndexDefinition 没有
      // unique 字段，该参数会被类型系统拒绝、运行期也不生效 —— 库里实际建的是非唯一索引。
      // 本次只做类型修正，保持与已执行结果一致。要去重请在**新**迁移里加唯一约束，
      // 不要改这条已执行的迁移（迁移合并后不可变）。
      collection.index('code', { name: 'ix_fqc_tickets_code' });
      collection.index('state', { name: 'ix_fqc_tickets_state' });
      collection.index('ownerDepartment', { name: 'ix_fqc_tickets_dept' });
    });
  },
  async down({ builder }) {
    await builder.dropCollection('fqcTickets');
    await builder.dropCollection('fqcScreenings');
    await builder.dropCollection('fqcMessages');
  },
});

export default migration;
