import { defineMigration, type MigrationDefinition } from '@nocobase/db';

/**
 * R-022 复刻波 1：报价单头与明细两张表，销售订单加一列 quotationId。
 *
 * 占位号 202611260026，排在波 0 的 202611260018 与打印的 202611260027 之间；
 * 不改已执行的 202611260013 / 202611260018。金额与交期口径照 R-021 加片的服务层算法，
 * 库里不建外键与 CHECK，引用与取值有效性由服务层守。只加可空列，不回填存量订单。
 * `down` 先删两张新表，再删订单上的列与索引。
 */
const migration: MigrationDefinition = defineMigration({
  name: '202611260026_quotations',
  async up({ builder }) {
    await builder.createCollection('quotations', (collection) => {
      collection.string('id', { length: 64 }).notNull();
      collection.string('docNo', { length: 32 }).notNull();
      collection.date('quoteDate').notNull();
      collection.date('validUntil').nullable();
      collection.string('warehouseId', { length: 64 }).nullable();
      collection.string('customerId', { length: 64 }).nullable();
      collection.string('contactName', { length: 128 }).nullable();
      collection.string('contactPhone', { length: 64 }).nullable();
      collection.string('deliveryAddress', { length: 512 }).nullable();
      collection.string('projectCode', { length: 32 }).nullable();
      collection.string('settlementCode', { length: 32 }).nullable();
      collection.string('customerOrderNo', { length: 64 }).nullable();
      collection.string('handlerUserId', { length: 64 }).nullable();
      collection.decimal('discountAmount', { precision: 18, scale: 4 }).notNull().defaultTo(0);
      collection.decimal('totalQty', { precision: 18, scale: 4 }).nullable();
      collection.decimal('taxIncludedTotal', { precision: 18, scale: 4 }).nullable();
      collection.decimal('taxExcludedTotal', { precision: 18, scale: 4 }).nullable();
      collection.decimal('taxTotal', { precision: 18, scale: 4 }).nullable();
      collection.decimal('payableTotal', { precision: 18, scale: 4 }).nullable();
      collection.string('status', { length: 16 }).notNull().defaultTo('draft');
      collection.string('convertedOrderId', { length: 64 }).nullable();
      collection.string('createdById', { length: 64 }).notNull();
      collection.datetimeTz('createdAt').notNull();
      collection.datetimeTz('updatedAt').notNull();
      collection.primary('id', { name: 'pk_quotations' });
      collection.unique('docNo', { name: 'uq_quotations_doc_no' });
      collection.index('quoteDate', { name: 'ix_quotations_date' });
      collection.index('validUntil', { name: 'ix_quotations_valid_until' });
      collection.index('customerId', { name: 'ix_quotations_customer' });
      collection.index('handlerUserId', { name: 'ix_quotations_handler' });
    });

    await builder.createCollection('quotationLines', (collection) => {
      collection.string('id', { length: 64 }).notNull();
      collection.string('quotationId', { length: 64 }).notNull();
      collection.string('itemId', { length: 64 }).notNull();
      collection.decimal('qty', { precision: 18, scale: 4 }).notNull();
      collection.decimal('price', { precision: 18, scale: 4 }).nullable();
      collection.date('deliveryDate').nullable();
      collection.decimal('taxRate', { precision: 5, scale: 2 }).nullable();
      collection.decimal('taxExcludedPrice', { precision: 18, scale: 4 }).nullable();
      collection.decimal('taxExcludedAmount', { precision: 18, scale: 4 }).nullable();
      collection.decimal('taxAmount', { precision: 18, scale: 4 }).nullable();
      collection.decimal('taxIncludedAmount', { precision: 18, scale: 4 }).nullable();
      collection.string('note', { length: 500 }).nullable();
      collection.primary('id', { name: 'pk_quotation_lines' });
      collection.index('quotationId', { name: 'ix_quotation_lines_quotation' });
    });

    await builder.alterCollection('salesOrders', (collection) => {
      collection.string('quotationId', { length: 64 }).nullable();
      collection.index('quotationId', { name: 'ix_sales_orders_quotation' });
    });
  },
  async down({ builder }) {
    await builder.dropCollection('quotationLines');
    await builder.dropCollection('quotations');
    // 分开两条 alter：同一个 alter 里 dropField 会连带删掉索引，再 dropIndex 会报不存在。
    await builder.alterCollection('salesOrders', (collection) => {
      collection.dropIndex('ix_sales_orders_quotation');
    });
    await builder.alterCollection('salesOrders', (collection) => {
      collection.dropField('quotationId');
    });
  },
});

export default migration;
