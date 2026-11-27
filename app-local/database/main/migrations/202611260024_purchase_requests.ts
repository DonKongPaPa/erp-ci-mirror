import { defineMigration, type MigrationDefinition } from '@nocobase/db';

/**
 * R-021 复刻波 1 加片：请购单头与明细，加采购订单一列。
 *
 * 占位号 202611260024；不改已执行的 202611260012 / 202611260018。金额 decimal(18,2)，
 * 数量 decimal(18,4)，时间戳带时区；不建外键、不建 CHECK，引用与取值由服务层守。
 * 唯一约束用 collection.unique(...)，索引名字写死供迁移测试逐项钉住。
 * down 先删两张表，再删采购订单的列（与索引）。
 */
const migration: MigrationDefinition = defineMigration({
  name: '202611260024_purchase_requests',
  async up({ builder }) {
    await builder.createCollection('purchaseRequests', (collection) => {
      collection.string('id', { length: 64 }).notNull();
      collection.string('docNo', { length: 32 }).notNull();
      collection.date('requestDate').notNull();
      collection.string('departmentId', { length: 64 }).notNull();
      collection.string('requesterUserId', { length: 64 }).notNull();
      collection.string('projectCode', { length: 32 }).nullable();
      collection.string('customText1', { length: 255 }).nullable();
      collection.string('customText2', { length: 255 }).nullable();
      collection.string('description', { length: 2000 }).notNull().defaultTo('');
      collection.string('status', { length: 16 }).notNull().defaultTo('draft');
      collection.string('approvalId', { length: 64 }).nullable();
      collection.string('convertedOrderId', { length: 64 }).nullable();
      collection.decimal('totalQty', { precision: 18, scale: 4 }).nullable();
      collection.decimal('estimatedTotal', { precision: 18, scale: 2 }).nullable();
      collection.string('createdById', { length: 64 }).notNull();
      collection.datetimeTz('createdAt').notNull();
      collection.datetimeTz('updatedAt').notNull();
      collection.primary('id', { name: 'pk_purchase_requests' });
      collection.unique('docNo', { name: 'uq_purchase_requests_doc_no' });
      collection.index('requestDate', { name: 'ix_purchase_requests_date' });
      collection.index('projectCode', { name: 'ix_purchase_requests_project' });
      collection.index('approvalId', { name: 'ix_purchase_requests_approval' });
    });

    await builder.createCollection('purchaseRequestLines', (collection) => {
      collection.string('id', { length: 64 }).notNull();
      collection.string('requestId', { length: 64 }).notNull();
      collection.string('itemId', { length: 64 }).notNull();
      collection.decimal('qty', { precision: 18, scale: 4 }).notNull();
      collection.decimal('expectedPrice', { precision: 18, scale: 2 }).nullable();
      collection.decimal('expectedAmount', { precision: 18, scale: 2 }).nullable();
      collection.primary('id', { name: 'pk_purchase_request_lines' });
      collection.index('requestId', { name: 'ix_purchase_request_lines_request' });
    });

    await builder.alterCollection('purchaseOrders', (collection) => {
      collection.string('purchaseRequestId', { length: 64 }).nullable();
      collection.index('purchaseRequestId', { name: 'ix_purchase_orders_request' });
    });
  },
  async down({ builder }) {
    await builder.dropCollection('purchaseRequestLines');
    await builder.dropCollection('purchaseRequests');
    await builder.alterCollection('purchaseOrders', (collection) => {
      collection.dropField('purchaseRequestId');
    });
  },
});

export default migration;
