import { defineMigration, type MigrationDefinition } from '@nocobase/db';

/**
 * R-020 复刻波 0 加片：出入库单据头补 16 列、明细补 9 列。
 *
 * 只加可空列与一个默认 0 的列，不回填、不改已执行的 202611260011。
 * 原因扩四个取值只改服务层枚举（库里 reason 是 string(32)，列宽够用）。
 * 三个索引按设计写死。`down` 先单独删索引，再删列：Postgres 删列会连带删索引。
 */
const migration: MigrationDefinition = defineMigration({
  name: '202611260019_stock_docs_ext',
  async up({ builder }) {
    await builder.alterCollection('stockDocs', (collection) => {
      collection.date('docDate').nullable();
      collection.string('partnerId', { length: 64 }).nullable();
      collection.string('contactName', { length: 128 }).nullable();
      collection.string('contactPhone', { length: 64 }).nullable();
      collection.string('deliveryAddress', { length: 512 }).nullable();
      collection.string('customerOrderNo', { length: 64 }).nullable();
      collection.string('projectCode', { length: 32 }).nullable();
      collection.string('handlerUserId', { length: 64 }).nullable();
      collection.string('takerDepartmentId', { length: 64 }).nullable();
      collection.string('takerUserId', { length: 64 }).nullable();
      collection.decimal('discountAmount', { precision: 18, scale: 4 }).notNull().defaultTo(0);
      collection.decimal('totalQty', { precision: 18, scale: 4 }).nullable();
      collection.decimal('taxIncludedTotal', { precision: 18, scale: 4 }).nullable();
      collection.decimal('taxExcludedTotal', { precision: 18, scale: 4 }).nullable();
      collection.decimal('taxTotal', { precision: 18, scale: 4 }).nullable();
      collection.decimal('payableTotal', { precision: 18, scale: 4 }).nullable();
      collection.index(['docType', 'docDate'], { name: 'ix_stock_docs_doc_date' });
      collection.index('partnerId', { name: 'ix_stock_docs_partner' });
      collection.index('projectCode', { name: 'ix_stock_docs_project' });
    });

    await builder.alterCollection('stockDocLines', (collection) => {
      collection.decimal('taxIncludedPrice', { precision: 18, scale: 4 }).nullable();
      collection.decimal('taxExcludedPrice', { precision: 18, scale: 4 }).nullable();
      collection.decimal('taxRate', { precision: 5, scale: 2 }).nullable();
      collection.decimal('taxExcludedAmount', { precision: 18, scale: 4 }).nullable();
      collection.decimal('taxAmount', { precision: 18, scale: 4 }).nullable();
      collection.decimal('taxIncludedAmount', { precision: 18, scale: 4 }).nullable();
      collection.date('productionDate').nullable();
      collection.date('expiryDate').nullable();
      collection.string('note', { length: 500 }).nullable();
    });
  },
  async down({ builder }) {
    await builder.alterCollection('stockDocs', (collection) => {
      collection.dropIndex('ix_stock_docs_doc_date');
      collection.dropIndex('ix_stock_docs_partner');
      collection.dropIndex('ix_stock_docs_project');
    });
    await builder.alterCollection('stockDocLines', (collection) => {
      for (const field of [
        'taxIncludedPrice', 'taxExcludedPrice', 'taxRate', 'taxExcludedAmount',
        'taxAmount', 'taxIncludedAmount', 'productionDate', 'expiryDate', 'note',
      ]) {
        collection.dropField(field);
      }
    });
    await builder.alterCollection('stockDocs', (collection) => {
      for (const field of [
        'docDate', 'partnerId', 'contactName', 'contactPhone', 'deliveryAddress',
        'customerOrderNo', 'projectCode', 'handlerUserId', 'takerDepartmentId',
        'takerUserId', 'discountAmount', 'totalQty', 'taxIncludedTotal',
        'taxExcludedTotal', 'taxTotal', 'payableTotal',
      ]) {
        collection.dropField(field);
      }
    });
  },
});

export default migration;
