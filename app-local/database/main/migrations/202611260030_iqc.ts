import { defineMigration, type MigrationDefinition } from '@nocobase/db';

/**
 * R-070 IQC：两张新表 +物料开关 +入库单回链列。
 *
 * 不建外键、不建数据库 CHECK：数量与状态规则在服务端算与校验。
 * 两张表各自的主键、唯一约束与三个索引按设计写死；`down` 先删表再删列。
 */
const migration: MigrationDefinition = defineMigration({
  name: '202611260030_iqc',
  async up({ builder }) {
    await builder.createCollection('inspectionOrders', (collection) => {
      collection.string('id', { length: 64 }).notNull();
      collection.string('docNo', { length: 32 }).notNull();
      collection.date('inspectionDate').notNull();
      collection.string('inspectorUserId', { length: 64 }).notNull();
      collection.string('purchaseOrderId', { length: 64 }).notNull();
      collection.string('supplierId', { length: 64 }).nullable();
      collection.string('status', { length: 16 }).notNull().defaultTo('pending');
      collection.string('remark', { length: 1000 }).notNull().defaultTo('');
      collection.string('createdById', { length: 64 }).notNull();
      collection.datetimeTz('completedAt').nullable();
      collection.datetimeTz('voidedAt').nullable();
      collection.datetimeTz('createdAt').notNull();
      collection.datetimeTz('updatedAt').notNull();
      collection.primary('id', { name: 'pk_inspection_orders' });
      collection.unique(['docNo'], { name: 'uq_inspection_orders_doc_no' });
      collection.index('inspectionDate', { name: 'ix_inspection_orders_date' });
      collection.index('purchaseOrderId', { name: 'ix_inspection_orders_order' });
    });

    await builder.createCollection('inspectionLines', (collection) => {
      collection.string('id', { length: 64 }).notNull();
      collection.string('orderId', { length: 64 }).notNull();
      collection.string('itemId', { length: 64 }).notNull();
      collection.decimal('purchaseQty', { precision: 18, scale: 4 }).notNull();
      collection.string('inspectionTypeCode', { length: 16 }).notNull();
      collection.decimal('receivedQty', { precision: 18, scale: 4 }).notNull();
      collection.decimal('inspectionQty', { precision: 18, scale: 4 }).notNull();
      collection.decimal('qualifiedQty', { precision: 18, scale: 4 }).notNull();
      collection.decimal('unqualifiedQty', { precision: 18, scale: 4 }).notNull();
      collection.decimal('releasableQty', { precision: 18, scale: 4 }).notNull();
      collection.decimal('returnQty', { precision: 18, scale: 4 }).notNull();
      collection.decimal('samplingQty', { precision: 18, scale: 4 }).notNull();
      collection.decimal('samplingQualifiedQty', { precision: 18, scale: 4 }).notNull();
      collection.decimal('lossQty', { precision: 18, scale: 4 }).notNull().defaultTo(0);
      collection.decimal('retainedQty', { precision: 18, scale: 4 }).notNull().defaultTo(0);
      collection.string('note', { length: 500 }).nullable();
      collection.primary('id', { name: 'pk_inspection_lines' });
      collection.index('orderId', { name: 'ix_inspection_lines_order' });
    });

    await builder.alterCollection('items', (collection) => {
      collection.boolean('inspectionRequired').notNull().defaultTo(false);
    });
    await builder.alterCollection('stockDocs', (collection) => {
      collection.string('inspectionId', { length: 64 }).nullable();
    });
  },
  async down({ builder }) {
    await builder.dropCollection('inspectionLines');
    await builder.dropCollection('inspectionOrders');
    await builder.alterCollection('items', (collection) => {
      collection.dropField('inspectionRequired');
    });
    await builder.alterCollection('stockDocs', (collection) => {
      collection.dropField('inspectionId');
    });
  },
});

export default migration;
