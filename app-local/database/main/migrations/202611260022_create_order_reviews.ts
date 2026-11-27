import { defineMigration, type MigrationDefinition } from '@nocobase/db';

/**
 * R-064：订单评审的头表与五项明细表，占位 202611260022。
 *
 * 只建两张新表：不改任何已执行的迁移，不给销售订单加列。确认交期落在评审头上，
 * 与客户要求交期（R-021/R-022 的 deliveryDate / latestDeliveryDate）彼此独立。
 * 同一订单只一条 confirmed 由服务层锁订单头保证，不建部分唯一索引；库里不建外键、
 * 不建 CHECK，状态与人员有效性也在服务层守。down 先删明细再删头。
 */
const migration: MigrationDefinition = defineMigration({
  name: '202611260022_create_order_reviews',
  async up({ builder }) {
    await builder.createCollection('orderReviews', (collection) => {
      collection.string('id', { length: 64 }).notNull();
      collection.string('salesOrderId', { length: 64 }).notNull();
      collection.string('status', { length: 16 }).notNull().defaultTo('draft');
      collection.string('reviewerUserId', { length: 64 }).notNull();
      collection.datetimeTz('reviewedAt').notNull();
      collection.date('confirmedDeliveryDate').nullable();
      collection.datetimeTz('confirmedAt').nullable();
      collection.string('createdById', { length: 64 }).notNull();
      collection.datetimeTz('createdAt').notNull();
      collection.datetimeTz('updatedAt').notNull();
      collection.primary('id', { name: 'pk_order_reviews' });
      collection.index(['salesOrderId', 'status'], {
        name: 'ix_order_reviews_sales_order',
      });
      collection.index(['status', 'confirmedDeliveryDate'], {
        name: 'ix_order_reviews_confirmed_delivery',
      });
    });

    await builder.createCollection('orderReviewLines', (collection) => {
      collection.string('id', { length: 64 }).notNull();
      collection.string('reviewId', { length: 64 }).notNull();
      collection.string('factor', { length: 16 }).notNull();
      collection.string('conclusion', { length: 500 }).notNull();
      collection.string('note', { length: 1000 }).nullable();
      collection.primary('id', { name: 'pk_order_review_lines' });
      collection.index('reviewId', { name: 'ix_order_review_lines_review' });
    });
  },
  async down({ builder }) {
    await builder.dropCollection('orderReviewLines');
    await builder.dropCollection('orderReviews');
  },
});

export default migration;
