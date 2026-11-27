import { defineMigration, type MigrationDefinition } from '@nocobase/db';

/**
 * R-072 波 0 第一片：业务字典的空表。14 列，排在销售订单 202611260013 之后
 * （202611260014 留给 BOM）；不改任何已执行的迁移，也不预置任何取值 —— 取值是客户数据。
 *
 * 九种类型共用一张表，只 tax_rate 用 rate、只 project 用起止日期与描述；那些列的
 * 适用性在服务端校验，库里用可空列。唯一约束用 collection.unique，不是带 unique 的索引。
 * 不建外键；单据存码引用，停用的取值不删。
 */
const migration: MigrationDefinition = defineMigration({
  name: '202611260015_create_biz_dict',
  async up({ builder }) {
    await builder.createCollection('bizDictEntries', (collection) => {
      collection.string('id', { length: 64 }).notNull();
      collection.string('dictType', { length: 32 }).notNull();
      collection.string('code', { length: 64 }).notNull();
      collection.string('name', { length: 128 }).notNull();
      collection.decimal('rate', { precision: 5, scale: 2 }).nullable();
      collection.date('startDate').nullable();
      collection.date('endDate').nullable();
      collection.text('description').nullable();
      collection.boolean('isDefault').notNull().defaultTo(false);
      collection.integer('sort').notNull().defaultTo(0);
      collection.string('status', { length: 16 }).notNull().defaultTo('active');
      collection.string('createdById', { length: 64 }).notNull();
      collection.datetimeTz('createdAt').notNull();
      collection.datetimeTz('updatedAt').notNull();
      collection.primary('id', { name: 'pk_biz_dict_entries' });
      collection.unique(['dictType', 'code'], {
        name: 'uq_biz_dict_type_code',
      });
      collection.index(['dictType', 'status', 'sort'], {
        name: 'ix_biz_dict_type_status_sort',
      });
    });
  },
  async down({ builder }) {
    await builder.dropCollection('bizDictEntries');
  },
});

export default migration;
