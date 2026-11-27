import { defineMigration, type MigrationDefinition } from '@nocobase/db';

/**
 * R-019 MVP 第一片：物料主数据三张表。
 *
 * 一条新迁移，排在未合并的发号器（code_counters）之后，不改任何已执行的迁移。
 * 表照 R-019.md 的数据模型：
 *
 * - units         计量单位。code 是短码主键（PCS、KG），建时定、不改、不复用；
 *                 decimals 默认 0；status 默认 active。
 * - itemCategories 物料分类。id 是 UUID 主键，code 全表唯一；parentId 可空、自引用，
 *                 MVP 只用一层但列要留；不建外键，关系由服务层校验（同部门表）。
 * - items         物料与产品同表。id 是 UUID，code 由 R-016 的发号服务按 itemType 发
 *                 （M / P），全表唯一、不可改；legacyCode 存旧系统编码，不进 code。
 *
 * 所有时间列带时区（datetimeTz，照 R-017 / R-025）。状态与类型是字符串枚举，
 * 不建 DB 枚举列；合法值在服务层与路由校验器里守。三张表都不建外键：
 * 引用（unitCode、categoryCode、parentId）由服务层按码读回校验。
 *
 * 约束一次建齐：`items.code`、`item_categories.code` 全表唯一；
 * `items` 的 (itemType, status, code) 供默认列表、(categoryCode) 供按分类筛；
 * `item_categories.parentId` 供按父读取。`down` 按相反顺序显式删三张表。
 */
const migration: MigrationDefinition = defineMigration({
  name: '202611260010_create_items',
  async up({ builder }) {
    await builder.createCollection('units', (collection) => {
      collection.string('code', { length: 16 }).notNull();
      collection.string('name', { length: 64 }).notNull();
      collection.integer('decimals').notNull().defaultTo(0);
      collection.string('status', { length: 16 }).notNull().defaultTo('active');
      collection.datetimeTz('createdAt').notNull();
      collection.datetimeTz('updatedAt').notNull();
      collection.primary('code', { name: 'pk_units' });
    });

    await builder.createCollection('itemCategories', (collection) => {
      collection.string('id', { length: 64 }).notNull();
      collection.string('code', { length: 32 }).notNull();
      collection.string('name', { length: 64 }).notNull();
      collection.string('parentId', { length: 64 }).nullable();
      collection.string('status', { length: 16 }).notNull().defaultTo('active');
      collection.datetimeTz('createdAt').notNull();
      collection.datetimeTz('updatedAt').notNull();
      collection.primary('id', { name: 'pk_item_categories' });
      collection.unique('code', { name: 'uq_item_categories_code' });
      collection.index('parentId', { name: 'ix_item_categories_parent' });
    });

    await builder.createCollection('items', (collection) => {
      collection.string('id', { length: 64 }).notNull();
      collection.string('code', { length: 64 }).notNull();
      collection.string('name', { length: 128 }).notNull();
      collection.string('spec', { length: 128 }).nullable();
      collection.string('itemType', { length: 16 }).notNull();
      collection.string('categoryCode', { length: 32 }).nullable();
      collection.string('unitCode', { length: 16 }).notNull();
      collection.string('status', { length: 16 }).notNull().defaultTo('active');
      collection.string('legacyCode', { length: 64 }).nullable();
      collection.text('note').nullable();
      collection.string('createdById', { length: 64 }).notNull();
      collection.datetimeTz('createdAt').notNull();
      collection.datetimeTz('updatedAt').notNull();
      collection.primary('id', { name: 'pk_items' });
      collection.unique('code', { name: 'uq_items_code' });
      collection.index(['itemType', 'status', 'code'], {
        name: 'ix_items_type_status_code',
      });
      collection.index('categoryCode', { name: 'ix_items_category' });
    });
  },
  async down({ builder }) {
    await builder.dropCollection('items');
    await builder.dropCollection('itemCategories');
    await builder.dropCollection('units');
  },
});

export default migration;
