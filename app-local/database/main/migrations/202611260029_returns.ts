import { defineMigration, type MigrationDefinition } from '@nocobase/db';

/**
 * R-020 复刻波 2 加片二：采购退货单与销售退货单各一张表；stock_docs 只加一列
 * returnDocId 与一条部分唯一索引。不改已执行的迁移、八种出入库原因、现存量与流水表。
 * 数量用 decimal(18,4)，时间戳带时区；不建外键、不建 CHECK，校验都在服务层。
 * down 先删两张新表，再删索引与列。
 */
const migration: MigrationDefinition = defineMigration({
  name: '202611260029_returns',
  async up({ builder }) {
    await builder.createCollection('returnDocs', (collection) => {
      collection.string('id', { length: 64 }).notNull();
      collection.string('docNo', { length: 32 }).notNull();
      collection.string('docType', { length: 8 }).notNull();
      collection.string('sourceType', { length: 16 }).notNull();
      collection.string('sourceId', { length: 64 }).notNull();
      collection.string('partnerId', { length: 64 }).nullable();
      collection.string('handlerUserId', { length: 64 }).nullable();
      collection.string('status', { length: 16 }).notNull().defaultTo('draft');
      collection.string('remark', { length: 1000 }).notNull().defaultTo('');
      collection.string('createdById', { length: 64 }).notNull();
      collection.datetimeTz('postedAt').nullable();
      collection.string('postedById', { length: 64 }).nullable();
      collection.datetimeTz('createdAt').notNull();
      collection.datetimeTz('updatedAt').notNull();
      collection.primary('id', { name: 'pk_return_docs' });
      collection.unique('docNo', { name: 'uq_return_docs_doc_no' });
      collection.index(['docType', 'status', 'createdAt'], {
        name: 'ix_return_docs_type_status_created',
      });
      collection.index(['sourceType', 'sourceId'], {
        name: 'ix_return_docs_source',
      });
    });

    await builder.createCollection('returnDocLines', (collection) => {
      collection.string('id', { length: 64 }).notNull();
      collection.string('docId', { length: 64 }).notNull();
      collection.string('sourceLineId', { length: 64 }).nullable();
      collection.string('itemId', { length: 64 }).notNull();
      collection.string('warehouseId', { length: 64 }).notNull();
      collection.string('batchNo', { length: 64 }).notNull().defaultTo('');
      collection.decimal('qty', { precision: 18, scale: 4 }).notNull();
      collection.decimal('returnQty', { precision: 18, scale: 4 }).notNull();
      collection.string('note', { length: 500 }).nullable();
      collection.primary('id', { name: 'pk_return_doc_lines' });
      collection.index('docId', { name: 'ix_return_lines_doc' });
    });

    await builder.alterCollection('stockDocs', (collection) => {
      collection.string('returnDocId', { length: 64 }).nullable();
      collection.unique('returnDocId', {
        name: 'uq_stock_docs_return',
        predicate: { returnDocId: { $notNull: true } },
      });
    });
  },
  async down({ builder }) {
    await builder.dropCollection('returnDocLines');
    await builder.dropCollection('returnDocs');
    await builder.alterCollection('stockDocs', (collection) => {
      collection.dropIndex('uq_stock_docs_return');
    });
    await builder.alterCollection('stockDocs', (collection) => {
      collection.dropField('returnDocId');
    });
  },
});

export default migration;
