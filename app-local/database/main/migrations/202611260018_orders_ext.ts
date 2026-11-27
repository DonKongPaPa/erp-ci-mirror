import { defineMigration, type MigrationDefinition } from '@nocobase/db';

/**
 * R-021/R-022 复刻波 0 加片：两张订单头与两张明细行补字段。
 *
 * 只加可空列与一个默认 0 的列，不回填、不改已执行的 202611260012 / 202611260013。
 * 金额与交期由服务端算好落库（见 doc-amounts.ts），库里不建 CHECK；引用与取值
 * 有效性也在服务层守。三个索引按设计逐项写死。`down` 先单独删索引，再删列 ——
 * Postgres 删列会连带删索引，顺序反了会报索引不存在。
 */
const migration: MigrationDefinition = defineMigration({
  name: '202611260018_orders_ext',
  async up({ builder }) {
    await builder.alterCollection('purchaseOrders', (collection) => {
      collection.string('warehouseId', { length: 64 }).nullable();
      collection.string('contactName', { length: 128 }).nullable();
      collection.string('contactPhone', { length: 64 }).nullable();
      collection.string('deliveryAddress', { length: 512 }).nullable();
      collection.string('settlementCode', { length: 32 }).nullable();
      collection.string('projectCode', { length: 32 }).nullable();
      collection.string('handlerUserId', { length: 64 }).nullable();
      collection.decimal('discountAmount', { precision: 18, scale: 4 }).notNull().defaultTo(0);
      collection.decimal('totalQty', { precision: 18, scale: 4 }).nullable();
      collection.decimal('taxIncludedTotal', { precision: 18, scale: 4 }).nullable();
      collection.decimal('taxExcludedTotal', { precision: 18, scale: 4 }).nullable();
      collection.decimal('taxTotal', { precision: 18, scale: 4 }).nullable();
      collection.decimal('payableTotal', { precision: 18, scale: 4 }).nullable();
      collection.date('latestDeliveryDate').nullable();
      collection.index('projectCode', { name: 'ix_purchase_orders_project' });
      collection.index('handlerUserId', { name: 'ix_purchase_orders_handler' });
      collection.index(['status', 'latestDeliveryDate'], {
        name: 'ix_purchase_orders_latest_delivery',
      });
    });

    await builder.alterCollection('purchaseOrderLines', (collection) => {
      collection.date('deliveryDate').nullable();
      collection.decimal('taxRate', { precision: 5, scale: 2 }).nullable();
      collection.decimal('taxExcludedPrice', { precision: 18, scale: 4 }).nullable();
      collection.decimal('taxExcludedAmount', { precision: 18, scale: 4 }).nullable();
      collection.decimal('taxAmount', { precision: 18, scale: 4 }).nullable();
      collection.decimal('taxIncludedAmount', { precision: 18, scale: 4 }).nullable();
      collection.string('note', { length: 500 }).nullable();
    });

    await builder.alterCollection('salesOrders', (collection) => {
      collection.string('warehouseId', { length: 64 }).nullable();
      collection.string('contactName', { length: 128 }).nullable();
      collection.string('contactPhone', { length: 64 }).nullable();
      collection.string('deliveryAddress', { length: 512 }).nullable();
      collection.string('settlementCode', { length: 32 }).nullable();
      collection.string('projectCode', { length: 32 }).nullable();
      collection.string('customerOrderNo', { length: 64 }).nullable();
      collection.string('handlerUserId', { length: 64 }).nullable();
      collection.decimal('discountAmount', { precision: 18, scale: 4 }).notNull().defaultTo(0);
      collection.decimal('totalQty', { precision: 18, scale: 4 }).nullable();
      collection.decimal('taxIncludedTotal', { precision: 18, scale: 4 }).nullable();
      collection.decimal('taxExcludedTotal', { precision: 18, scale: 4 }).nullable();
      collection.decimal('taxTotal', { precision: 18, scale: 4 }).nullable();
      collection.decimal('payableTotal', { precision: 18, scale: 4 }).nullable();
      collection.date('latestDeliveryDate').nullable();
      collection.index('projectCode', { name: 'ix_sales_orders_project' });
      collection.index('handlerUserId', { name: 'ix_sales_orders_handler' });
      collection.index(['status', 'latestDeliveryDate'], {
        name: 'ix_sales_orders_latest_delivery',
      });
    });

    await builder.alterCollection('salesOrderLines', (collection) => {
      collection.date('deliveryDate').nullable();
      collection.decimal('taxRate', { precision: 5, scale: 2 }).nullable();
      collection.decimal('taxExcludedPrice', { precision: 18, scale: 4 }).nullable();
      collection.decimal('taxExcludedAmount', { precision: 18, scale: 4 }).nullable();
      collection.decimal('taxAmount', { precision: 18, scale: 4 }).nullable();
      collection.decimal('taxIncludedAmount', { precision: 18, scale: 4 }).nullable();
      collection.string('note', { length: 500 }).nullable();
    });
  },
  async down({ builder }) {
    for (const table of ['purchaseOrders', 'salesOrders'] as const) {
      await builder.alterCollection(table, (collection) => {
        collection.dropIndex(`${table === 'purchaseOrders' ? 'ix_purchase_orders' : 'ix_sales_orders'}_project`);
        collection.dropIndex(`${table === 'purchaseOrders' ? 'ix_purchase_orders' : 'ix_sales_orders'}_handler`);
        collection.dropIndex(`${table === 'purchaseOrders' ? 'ix_purchase_orders' : 'ix_sales_orders'}_latest_delivery`);
      });
    }
    for (const table of ['salesOrderLines', 'purchaseOrderLines'] as const) {
      await builder.alterCollection(table, (collection) => {
        collection.dropField('deliveryDate');
        collection.dropField('taxRate');
        collection.dropField('taxExcludedPrice');
        collection.dropField('taxExcludedAmount');
        collection.dropField('taxAmount');
        collection.dropField('taxIncludedAmount');
        collection.dropField('note');
      });
    }
    for (const table of ['salesOrders', 'purchaseOrders'] as const) {
      await builder.alterCollection(table, (collection) => {
        for (const field of [
          'warehouseId', 'contactName', 'contactPhone', 'deliveryAddress',
          'settlementCode', 'projectCode', 'customerOrderNo', 'handlerUserId',
          'discountAmount', 'totalQty', 'taxIncludedTotal', 'taxExcludedTotal',
          'taxTotal', 'payableTotal', 'latestDeliveryDate',
        ]) {
          if (table === 'purchaseOrders' && field === 'customerOrderNo') continue;
          collection.dropField(field);
        }
      });
    }
  },
});

export default migration;
