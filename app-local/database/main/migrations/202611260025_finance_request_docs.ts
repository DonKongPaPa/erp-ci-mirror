import { defineMigration, type MigrationDefinition } from '@nocobase/db';

/**
 * R-066：请款单与报销单一表分型（docType），只建新表。
 *
 * 占位号 202611260025；不改已执行的 expenseRecords（202611260021）与 approvals
 * （202611260006）。时间戳带时区，金额 decimal(18,2)，不建外键、不建 CHECK；
 * 引用与取值一律由服务层校验。唯一约束用 collection.unique，索引名字写死供迁移测试逐项钉住。
 */
const migration: MigrationDefinition = defineMigration({
  name: '202611260025_finance_request_docs',
  async up({ builder }) {
    await builder.createCollection('financeRequestDocs', (collection) => {
      collection.string('id', { length: 64 }).notNull();
      collection.string('docType', { length: 16 }).notNull();
      collection.string('docNo', { length: 32 }).notNull();
      collection.date('requestDate').notNull();
      collection.string('expenseTypeCode', { length: 32 }).nullable();
      collection.decimal('amount', { precision: 18, scale: 2 }).notNull();
      collection.string('reason', { length: 1000 }).notNull().defaultTo('');
      collection.string('handlerUserId', { length: 64 }).notNull();
      collection.string('projectCode', { length: 32 }).nullable();
      collection.string('status', { length: 16 }).notNull().defaultTo('draft');
      collection.string('approvalId', { length: 64 }).nullable();
      collection.string('expenseRecordId', { length: 64 }).nullable();
      collection.string('createdById', { length: 64 }).notNull();
      collection.datetimeTz('createdAt').notNull();
      collection.datetimeTz('updatedAt').notNull();
      collection.primary('id', { name: 'pk_finance_request_docs' });
      collection.unique('docNo', { name: 'uq_finance_request_docs_doc_no' });
      collection.index(['docType', 'requestDate'], { name: 'ix_finance_request_docs_date' });
      collection.index('approvalId', { name: 'ix_finance_request_docs_approval' });
    });
  },
  async down({ builder }) {
    await builder.dropCollection('financeRequestDocs');
  },
});

export default migration;
