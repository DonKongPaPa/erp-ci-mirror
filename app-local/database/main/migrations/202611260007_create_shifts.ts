import { defineMigration, type MigrationDefinition } from '@nocobase/db';

/**
 * R-025 S1：班次定义表。
 *
 * 一条新迁移，排在未合并的 202611260006_create_approvals 之后，不改任何已执行的迁移。
 * 表照 R-025.md 的数据模型：id 就是班次编码，建时定、全表唯一、不复用；起止与休息段
 * 都是零点起的整数分钟数（不是 time/date/datetime），跨天由 endMinute < startMinute 推出，
 * 范围与休息段的校验在服务端做，不建数据库 CHECK。
 *
 * 时间列带时区：照 R-017 的 datetimeTz 建法（2026-11-27 主会话裁决，R-025.md 变更记录）。
 * active 默认真、sortOrder 默认 0，照 R-011 的岗位、职级字典。索引只有默认列表要用的
 * (active, sortOrder, id)；主键 id 同时是编码的全表唯一约束。没有外键、没有人员列。
 *
 * down 显式删表：表没了，主键与索引也一起没了。
 */
const migration: MigrationDefinition = defineMigration({
  name: '202611260007_create_shifts',
  async up({ builder }) {
    await builder.createCollection('shifts', (collection) => {
      collection.string('id', { length: 32 }).notNull();
      collection.string('title', { length: 64 }).notNull();
      collection.integer('startMinute').notNull();
      collection.integer('endMinute').notNull();
      collection.integer('breakStartMinute').nullable();
      collection.integer('breakEndMinute').nullable();
      collection.boolean('active').notNull().defaultTo(true);
      collection.integer('sortOrder').notNull().defaultTo(0);
      collection.datetimeTz('createdAt').notNull();
      collection.datetimeTz('updatedAt').notNull();
      collection.primary('id', { name: 'pk_shifts' });
      collection.index(['active', 'sortOrder', 'id'], {
        name: 'ix_shifts_active_sort_id',
      });
    });
  },
  async down({ builder }) {
    await builder.dropCollection('shifts');
  },
});

export default migration;
