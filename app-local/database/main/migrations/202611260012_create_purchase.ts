import { defineMigration, type MigrationDefinition } from '@nocobase/db';

/**
 * R-021 MVP：采购订单头与明细两张表。编号写死，排在库存 202611260011 之后；
 * 不改任何已执行的迁移。
 *
 * 时间列带时区（datetimeTz，照 R-017/R-025）；日期列是 SQL DATE（照 R-011 的 hiredOn）；
 * 数量与金额是 decimal(18,4)，不建 CHECK —— 正数、引用有效性与同一订单内物料唯一
 * 由服务层守。不建外键：物料、往来单位、账号分别在别的模块，引用完整性在写服务里校验。
 * down 先删明细再删单据头，索引与主键随表消失。
 */
const migration: MigrationDefinition = defineMigration({
  name: '202611260012_create_purchase',
  async up({ builder }) {
    await builder.createCollection('purchaseOrders', (collection) => {
      collection.string('id', { length: 64 }).notNull();
      collection.string('orderNo', { length: 32 }).notNull();
      collection.string('supplierId', { length: 64 }).notNull();
      collection.date('orderDate').notNull();
      collection.string('status', { length: 32 }).notNull().defaultTo('draft');
      collection.string('remark', { length: 1000 }).notNull().defaultTo('');
      collection.string('createdById', { length: 64 }).notNull();
      collection.datetimeTz('submittedAt').nullable();
      collection.datetimeTz('createdAt').notNull();
      collection.datetimeTz('updatedAt').notNull();
      collection.primary('id', { name: 'pk_purchase_orders' });
      collection.unique('orderNo', { name: 'uq_purchase_orders_order_no' });
      collection.index(['status', 'orderDate'], {
        name: 'ix_purchase_orders_status_order_date',
      });
      collection.index('supplierId', { name: 'ix_purchase_orders_supplier' });
    });

    await builder.createCollection('purchaseOrderLines', (collection) => {
      collection.string('id', { length: 64 }).notNull();
      collection.string('orderId', { length: 64 }).notNull();
      collection.string('itemId', { length: 64 }).notNull();
      collection.decimal('qty', { precision: 18, scale: 4 }).notNull();
      collection.decimal('price', { precision: 18, scale: 4 }).nullable();
      collection.decimal('receivedQty', { precision: 18, scale: 4 }).notNull().defaultTo(0);
      collection.primary('id', { name: 'pk_purchase_order_lines' });
      collection.index('orderId', { name: 'ix_purchase_order_lines_order' });
    });
  },
  async down({ builder }) {
    await builder.dropCollection('purchaseOrderLines');
    await builder.dropCollection('purchaseOrders');
  },
});

export default migration;
