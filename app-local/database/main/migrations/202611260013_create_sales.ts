import { defineMigration, type MigrationDefinition } from '@nocobase/db';

/**
 * R-022 MVP：销售订单头与明细两张表。编号写死，排在采购 202611260012 之后；
 * 不改任何已执行的迁移。
 *
 * 形状与采购订单同构：时间列带时区、日期列是 SQL DATE、数量与金额是 decimal(18,4)，
 * 不建外键与 CHECK。回写列是 shippedQty——库存出库单过账后由 order-progress 在事务里更新。
 */
const migration: MigrationDefinition = defineMigration({
  name: '202611260013_create_sales',
  async up({ builder }) {
    await builder.createCollection('salesOrders', (collection) => {
      collection.string('id', { length: 64 }).notNull();
      collection.string('orderNo', { length: 32 }).notNull();
      collection.string('customerId', { length: 64 }).notNull();
      collection.date('orderDate').notNull();
      collection.string('status', { length: 32 }).notNull().defaultTo('draft');
      collection.string('remark', { length: 1000 }).notNull().defaultTo('');
      collection.string('createdById', { length: 64 }).notNull();
      collection.datetimeTz('submittedAt').nullable();
      collection.datetimeTz('createdAt').notNull();
      collection.datetimeTz('updatedAt').notNull();
      collection.primary('id', { name: 'pk_sales_orders' });
      collection.unique('orderNo', { name: 'uq_sales_orders_order_no' });
      collection.index(['status', 'orderDate'], {
        name: 'ix_sales_orders_status_order_date',
      });
      collection.index('customerId', { name: 'ix_sales_orders_customer' });
    });

    await builder.createCollection('salesOrderLines', (collection) => {
      collection.string('id', { length: 64 }).notNull();
      collection.string('orderId', { length: 64 }).notNull();
      collection.string('itemId', { length: 64 }).notNull();
      collection.decimal('qty', { precision: 18, scale: 4 }).notNull();
      collection.decimal('price', { precision: 18, scale: 4 }).nullable();
      collection.decimal('shippedQty', { precision: 18, scale: 4 }).notNull().defaultTo(0);
      collection.primary('id', { name: 'pk_sales_order_lines' });
      collection.index('orderId', { name: 'ix_sales_order_lines_order' });
    });
  },
  async down({ builder }) {
    await builder.dropCollection('salesOrderLines');
    await builder.dropCollection('salesOrders');
  },
});

export default migration;
