import { defineMigration, type MigrationDefinition } from '@nocobase/db';

/**
 * R-020 MVP：仓库与库存的五张表。编号写死，排在发号器 202611260008 之后；
 * 不改任何已执行的迁移。
 *
 * 时间列带时区（datetimeTz，照 R-017/R-025）；数量是 decimal(18,4)，不建 CHECK，
 * 正数与出库余额由服务层守。批号用空串占位（不用 NULL），所以现存量主键
 * (itemId, warehouseId, batchNo) 的唯一性不会被 NULL 破坏。
 *
 * 没有外键：单据行引用物料、仓库、账号，但物料表在另一条分支上，账号由平台管；
 * 引用完整性在写服务里校验。down 按依赖顺序删表，索引与主键随表一起消失。
 */
const migration: MigrationDefinition = defineMigration({
  name: '202611260011_create_inventory',
  async up({ builder }) {
    await builder.createCollection('warehouses', (collection) => {
      collection.string('id', { length: 64 }).notNull();
      collection.string('code', { length: 32 }).notNull();
      collection.string('name', { length: 128 }).notNull();
      collection.string('status', { length: 16 }).notNull().defaultTo('active');
      collection.string('note', { length: 500 }).notNull().defaultTo('');
      collection.datetimeTz('createdAt').notNull();
      collection.datetimeTz('updatedAt').notNull();
      collection.primary('id', { name: 'pk_warehouses' });
      collection.unique('code', { name: 'uq_warehouses_code' });
    });

    await builder.createCollection('stockDocs', (collection) => {
      collection.string('id', { length: 64 }).notNull();
      collection.string('docNo', { length: 64 }).notNull();
      collection.string('docType', { length: 8 }).notNull();
      collection.string('reason', { length: 32 }).notNull();
      collection.string('status', { length: 16 }).notNull().defaultTo('draft');
      collection.string('remark', { length: 1000 }).notNull().defaultTo('');
      collection.string('sourceType', { length: 32 }).nullable();
      collection.string('sourceId', { length: 64 }).nullable();
      collection.string('createdById', { length: 64 }).notNull();
      collection.datetimeTz('postedAt').nullable();
      collection.string('postedById', { length: 64 }).nullable();
      collection.datetimeTz('createdAt').notNull();
      collection.datetimeTz('updatedAt').notNull();
      collection.primary('id', { name: 'pk_stock_docs' });
      collection.unique('docNo', { name: 'uq_stock_docs_doc_no' });
      collection.index(['docType', 'status', 'createdAt'], {
        name: 'ix_stock_docs_type_status_created',
      });
      collection.index(['sourceType', 'sourceId'], {
        name: 'ix_stock_docs_source',
      });
    });

    await builder.createCollection('stockDocLines', (collection) => {
      collection.string('id', { length: 64 }).notNull();
      collection.string('docId', { length: 64 }).notNull();
      collection.string('itemId', { length: 64 }).notNull();
      collection.string('warehouseId', { length: 64 }).notNull();
      collection.string('batchNo', { length: 64 }).notNull().defaultTo('');
      collection.decimal('qty', { precision: 18, scale: 4 }).notNull();
      collection.primary('id', { name: 'pk_stock_doc_lines' });
      collection.index('docId', { name: 'ix_stock_doc_lines_doc' });
    });

    await builder.createCollection('stockBalances', (collection) => {
      collection.string('itemId', { length: 64 }).notNull();
      collection.string('warehouseId', { length: 64 }).notNull();
      collection.string('batchNo', { length: 64 }).notNull().defaultTo('');
      collection.decimal('qty', { precision: 18, scale: 4 }).notNull().defaultTo(0);
      collection.primary(['itemId', 'warehouseId', 'batchNo'], {
        name: 'pk_stock_balances',
      });
    });

    await builder.createCollection('stockTransactions', (collection) => {
      collection.string('id', { length: 64 }).notNull();
      collection.string('docId', { length: 64 }).notNull();
      collection.string('docLineId', { length: 64 }).notNull();
      collection.string('docNo', { length: 64 }).notNull();
      collection.string('itemId', { length: 64 }).notNull();
      collection.string('warehouseId', { length: 64 }).notNull();
      collection.string('batchNo', { length: 64 }).notNull();
      collection.decimal('qtyDelta', { precision: 18, scale: 4 }).notNull();
      collection.decimal('balanceAfter', { precision: 18, scale: 4 }).notNull();
      collection.datetimeTz('at').notNull();
      collection.string('byUserId', { length: 64 }).notNull();
      collection.primary('id', { name: 'pk_stock_transactions' });
      collection.index(['itemId', 'warehouseId', 'at'], {
        name: 'ix_stock_transactions_item_warehouse_at',
      });
    });
  },
  async down({ builder }) {
    await builder.dropCollection('stockTransactions');
    await builder.dropCollection('stockBalances');
    await builder.dropCollection('stockDocLines');
    await builder.dropCollection('stockDocs');
    await builder.dropCollection('warehouses');
  },
});

export default migration;
