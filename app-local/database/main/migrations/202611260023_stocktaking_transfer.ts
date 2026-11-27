import { defineMigration, type MigrationDefinition } from '@nocobase/db';

/**
 * R-020 复刻波 1 加片：盘点单头与明细、调拨单头与明细四张表；
 * stock_docs 只加两列与两条部分唯一索引，不改已执行的 202611260011 / 202611260019。
 *
 * 盘盈盘亏、调拨出入的回链列可空，不回填；部分唯一索引由 prisma 风格的 predicate
 * 生成 `where stocktaking_id is not null` / `where transfer_doc_id is not null`。
 * 不建外键、不建 CHECK：仓库、物料、人员与状态都在服务层校验。
 * down 先删四张表，再删两条部分唯一索引与两列。
 */
const migration: MigrationDefinition = defineMigration({
  name: '202611260023_stocktaking_transfer',
  async up({ builder }) {
    await builder.createCollection('stocktakingDocs', (collection) => {
      collection.string('id', { length: 64 }).notNull();
      collection.string('docNo', { length: 32 }).notNull();
      collection.date('docDate').notNull();
      collection.string('warehouseId', { length: 64 }).notNull();
      collection.string('handlerUserId', { length: 64 }).nullable();
      collection.string('supervisorUserId', { length: 64 }).nullable();
      collection.string('status', { length: 16 }).notNull().defaultTo('staging');
      collection.string('remark', { length: 1000 }).notNull().defaultTo('');
      collection.string('createdById', { length: 64 }).notNull();
      collection.datetimeTz('createdAt').notNull();
      collection.datetimeTz('updatedAt').notNull();
      collection.primary('id', { name: 'pk_stocktaking_docs' });
      collection.unique('docNo', { name: 'uq_stocktaking_docs_doc_no' });
      collection.index(['warehouseId', 'docDate'], {
        name: 'ix_stocktaking_docs_warehouse_date',
      });
    });

    await builder.createCollection('stocktakingDocLines', (collection) => {
      collection.string('id', { length: 64 }).notNull();
      collection.string('docId', { length: 64 }).notNull();
      collection.string('itemId', { length: 64 }).notNull();
      collection.decimal('systemQty', { precision: 18, scale: 4 }).notNull();
      collection.decimal('actualQty', { precision: 18, scale: 4 }).nullable();
      collection.decimal('deltaQty', { precision: 18, scale: 4 }).nullable();
      collection.string('result', { length: 16 }).nullable();
      collection.string('note', { length: 500 }).nullable();
      collection.primary('id', { name: 'pk_stocktaking_doc_lines' });
      collection.index('docId', { name: 'ix_stocktaking_lines_doc' });
    });

    await builder.createCollection('transferDocs', (collection) => {
      collection.string('id', { length: 64 }).notNull();
      collection.string('docNo', { length: 32 }).notNull();
      collection.date('docDate').nullable();
      collection.string('transferInWarehouseId', { length: 64 }).notNull();
      collection.string('transferOutWarehouseId', { length: 64 }).nullable();
      collection.string('handlerUserId', { length: 64 }).nullable();
      collection.string('status', { length: 16 }).notNull().defaultTo('draft');
      collection.string('remark', { length: 1000 }).notNull().defaultTo('');
      collection.string('createdById', { length: 64 }).notNull();
      collection.datetimeTz('createdAt').notNull();
      collection.datetimeTz('updatedAt').notNull();
      collection.primary('id', { name: 'pk_transfer_docs' });
      collection.unique('docNo', { name: 'uq_transfer_docs_doc_no' });
      collection.index(['transferInWarehouseId', 'docDate'], {
        name: 'ix_transfer_docs_in_warehouse_date',
      });
    });

    await builder.createCollection('transferDocLines', (collection) => {
      collection.string('id', { length: 64 }).notNull();
      collection.string('docId', { length: 64 }).notNull();
      collection.string('itemId', { length: 64 }).notNull();
      collection.decimal('qty', { precision: 18, scale: 4 }).notNull();
      collection.decimal('transferQty', { precision: 18, scale: 4 }).nullable();
      collection.string('note', { length: 500 }).nullable();
      collection.primary('id', { name: 'pk_transfer_doc_lines' });
    });

    await builder.alterCollection('stockDocs', (collection) => {
      collection.string('stocktakingId', { length: 64 }).nullable();
      collection.string('transferDocId', { length: 64 }).nullable();
      collection.unique(['stocktakingId', 'docType'], {
        name: 'uq_stock_docs_stocktaking',
        predicate: { stocktakingId: { $notNull: true } },
      });
      collection.unique(['transferDocId', 'docType'], {
        name: 'uq_stock_docs_transfer',
        predicate: { transferDocId: { $notNull: true } },
      });
    });
  },
  async down({ builder }) {
    await builder.dropCollection('stocktakingDocLines');
    await builder.dropCollection('stocktakingDocs');
    await builder.dropCollection('transferDocLines');
    await builder.dropCollection('transferDocs');
    await builder.alterCollection('stockDocs', (collection) => {
      collection.dropIndex('uq_stock_docs_stocktaking');
      collection.dropIndex('uq_stock_docs_transfer');
    });
    await builder.alterCollection('stockDocs', (collection) => {
      collection.dropField('stocktakingId');
      collection.dropField('transferDocId');
    });
  },
});

export default migration;
