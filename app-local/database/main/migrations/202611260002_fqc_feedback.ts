import { defineMigration, type MigrationDefinition } from '@nocobase/db';

/**
 * R-026 第一个切片：反馈单的列、附件表、提醒记录表与存量迁移。
 *
 * 一条新迁移，不改已经执行过的两条。五件事：
 *
 * - `fqcMessages` 加十列。反馈单沿用这张表（R-026 的理由节）：表单字段、附件的标识
 *   数组、内部备注、丢弃的三列；`ownerId` 是「仅本人」范围比较的那一列。原文七列
 *   （channel、externalId、senderName、senderContact、content、rawContentType、
 *   receivedAt）不在这十列里，落库之后任何动作的改列清单都没有它们。
 * - 存量 `status = 'screened'` 改成 `open`。录入函数从此写 `open`；存量行本来就是
 *   「已经记下来的反馈」。`down` 不写反向的更新：中间可能已经丢弃过，改回
 *   `screened` 会丢掉这个事实。
 * - 加唯一约束之前先清重复：同一个 `(channel, externalId)` 只保留最早的一行，
 *   其余行的 `externalId` 置空，别的列不动。空值互不相等，`externalId` 为空的行
 *   可以并存 —— 这一点对两种方言的通则一样。
 * - `fqcScreenings` 加 `ownerId`（可空、索引）：网页入口的模型升级靠「仅本人」的
 *   范围拿到改权。存量初筛留空，不回填。
 * - 两张新表：`fqcFeedbackFiles`（反馈单的附件，文件插件要求的九列加两列）与
 *   `fqcFeedbackReminders`（七天提醒的记录，一张单至多一行）。两张都不登记进授权，
 *   只经已经授权的端点或定时任务读写。
 *
 * 时间列不带时区，与消息表的 `createdAt` 一致。外键不建：与本项目其余业务表一致，
 * 关联由服务层按标识读。
 */

/** 消息表加的唯一约束名。改它等于改库结构，`down` 用的也是这个名字。 */
const UNIQUE_CHANNEL_EXTERNAL = 'uq_fqc_messages_channel_external';

const NEW_MESSAGE_FIELDS = [
  'ownerId',
  'customerName',
  'productName',
  'model',
  'batchNo',
  'attachmentIds',
  'note',
  'discardedAt',
  'discardedBy',
  'discardReason',
] as const;

const migration: MigrationDefinition = defineMigration({
  name: '202611260002_fqc_feedback',
  async up({ builder, query }) {
    await builder.alterCollection('fqcMessages', (collection) => {
      collection.string('ownerId', { length: 64 }).nullable();
      collection.string('customerName', { length: 128 }).nullable();
      collection.string('productName', { length: 128 }).nullable();
      collection.string('model', { length: 128 }).nullable();
      collection.string('batchNo', { length: 64 }).nullable();
      collection.json('attachmentIds').nullable();
      collection.text('note').nullable();
      collection.datetime('discardedAt').nullable();
      collection.string('discardedBy', { length: 64 }).nullable();
      collection.string('discardReason', { length: 32 }).nullable();
      collection.index('ownerId', { name: 'ix_fqc_messages_owner' });
    });

    await builder.alterCollection('fqcScreenings', (collection) => {
      collection.string('ownerId', { length: 64 }).nullable();
      collection.index('ownerId', { name: 'ix_fqc_screenings_owner' });
    });

    await builder.createCollection('fqcFeedbackFiles', (collection) => {
      // 文件插件要求的九列。名字不能改；长度按插件文档给的兼容类型取。
      collection.string('id', { length: 64 }).notNull();
      collection.string('disk', { length: 255 }).notNull();
      collection.text('key').notNull();
      collection.text('filename').notNull();
      collection.string('ext', { length: 32 }).notNull();
      collection.string('mimeType', { length: 255 }).notNull();
      collection.integer('size').notNull();
      // 本条的：上传的人，以及挂在哪张反馈单上（刚上传、还没提交时为空）。
      collection.string('ownerId', { length: 64 }).nullable();
      collection.string('feedbackId', { length: 64 }).nullable();
      collection.datetime('createdAt').notNull();
      collection.datetime('updatedAt').notNull();
      collection.primary('id', { name: 'pk_fqc_feedback_files' });
      collection.index('ownerId', { name: 'ix_fqc_feedback_files_owner' });
      collection.index('feedbackId', {
        name: 'ix_fqc_feedback_files_feedback',
      });
    });

    await builder.createCollection('fqcFeedbackReminders', (collection) => {
      collection.string('id', { length: 64 }).notNull();
      collection.string('feedbackId', { length: 64 }).notNull();
      // 试了几回；每一回的幂等键由它决定，满了五回就不再试。
      collection.integer('attempts').notNull().defaultTo(0);
      collection.string('lastKey', { length: 191 }).nullable();
      collection.datetime('notifiedAt').nullable();
      collection.datetime('createdAt').notNull();
      collection.datetime('updatedAt').notNull();
      collection.primary('id', { name: 'pk_fqc_feedback_reminders' });
      // 一张单至多一行。
      collection.unique('feedbackId', {
        name: 'uq_fqc_feedback_reminders_feedback',
      });
    });

    // 存量行的状态：screened 就是「已经记下来的反馈」。
    await query
      .updateTable('fqcMessages')
      .set({ status: 'open' })
      .where('status', '=', 'screened')
      .execute();

    // 加唯一约束之前先清重复：只保留最早的一行。按创建时间排，时间相同按标识排，
    // 保证每次执行的选择一样。别的列原样留着。
    const existing = await query
      .selectFrom('fqcMessages')
      .select(['id', 'channel', 'externalId', 'createdAt'])
      .where('externalId', 'is not', null)
      .orderBy('createdAt', 'asc')
      .orderBy('id', 'asc')
      .execute();
    const seen = new Set<string>();
    const duplicates: string[] = [];
    for (const row of existing) {
      const key = `${String(row.channel)}\u0000${String(row.externalId)}`;
      if (seen.has(key)) {
        duplicates.push(String(row.id));
      } else {
        seen.add(key);
      }
    }
    if (duplicates.length > 0) {
      await query
        .updateTable('fqcMessages')
        .set({ externalId: null })
        .where('id', 'in', duplicates)
        .execute();
    }

    await builder.alterCollection('fqcMessages', (collection) => {
      collection.unique(['channel', 'externalId'], {
        name: UNIQUE_CHANNEL_EXTERNAL,
      });
    });
  },
  async down({ builder }) {
    // 不把 open 改回 screened：中间可能已经丢弃过，改回去会丢掉这个事实。
    await builder.alterCollection('fqcMessages', (collection) => {
      collection.dropConstraint(UNIQUE_CHANNEL_EXTERNAL);
      for (const field of NEW_MESSAGE_FIELDS) {
        collection.dropField(field);
      }
    });
    await builder.alterCollection('fqcScreenings', (collection) => {
      collection.dropField('ownerId');
    });
    await builder.dropCollection('fqcFeedbackReminders');
    await builder.dropCollection('fqcFeedbackFiles');
  },
});

export default migration;
