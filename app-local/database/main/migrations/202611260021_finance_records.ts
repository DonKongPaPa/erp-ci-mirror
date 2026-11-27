import { defineMigration, type MigrationDefinition } from '@nocobase/db';

/**
 * R-065 第一片：支出记录与到票记录各一张头表、一张明细表，采购订单补两个回写列。
 *
 * 金额 decimal(18,2)，时间戳带时区；不建外键也不建数据库 CHECK，
 * 状态、金额、引用与同一张记录的供应商一致性都在服务层守。
 * down 先删四张表，再删采购订单两列。
 */
const migration: MigrationDefinition = defineMigration({
  name: '202611260021_finance_records',
  async up({ builder }) {
    await builder.createCollection('expenseRecords', (collection) => {
      collection.string('id', { length: 64 }).notNull();
      collection.string('docNo', { length: 32 }).notNull();
      collection.date('expenseDate').notNull();
      collection.string('status', { length: 16 }).notNull().defaultTo('draft');
      collection.string('expenseTypeCode', { length: 32 }).nullable();
      collection.string('fundAccountCode', { length: 32 }).nullable();
      collection.string('payeeName', { length: 128 }).nullable();
      collection.string('supplierId', { length: 64 }).nullable();
      collection.string('payeeAccountNo', { length: 64 }).nullable();
      collection.string('payeeBankName', { length: 128 }).nullable();
      collection.string('payeeBankCode', { length: 32 }).nullable();
      collection.string('bindMode', { length: 16 }).notNull();
      collection.string('handlerUserId', { length: 64 }).nullable();
      collection.string('projectCode', { length: 32 }).nullable();
      collection.string('remark', { length: 1000 }).notNull().defaultTo('');
      collection.decimal('totalAmount', { precision: 18, scale: 2 }).notNull().defaultTo(0);
      collection.string('createdById', { length: 64 }).notNull();
      collection.datetimeTz('confirmedAt').nullable();
      collection.datetimeTz('voidedAt').nullable();
      collection.datetimeTz('createdAt').notNull();
      collection.datetimeTz('updatedAt').notNull();
      collection.primary('id', { name: 'pk_expense_records' });
      collection.unique('docNo', { name: 'uq_expense_records_doc_no' });
      collection.index('expenseDate', { name: 'ix_expense_records_date' });
      collection.index('supplierId', { name: 'ix_expense_records_supplier' });
    });

    await builder.createCollection('expenseRecordLines', (collection) => {
      collection.string('id', { length: 64 }).notNull();
      collection.string('recordId', { length: 64 }).notNull();
      collection.string('purchaseOrderId', { length: 64 }).notNull();
      collection.decimal('orderPayableAmount', { precision: 18, scale: 2 }).notNull();
      collection.decimal('paidBefore', { precision: 18, scale: 2 }).notNull().defaultTo(0);
      collection.decimal('amount', { precision: 18, scale: 2 }).notNull();
      collection.string('note', { length: 500 }).nullable();
      collection.primary('id', { name: 'pk_expense_record_lines' });
      collection.index('recordId', { name: 'ix_expense_record_lines_record' });
    });

    await builder.createCollection('invoiceReceiptRecords', (collection) => {
      collection.string('id', { length: 64 }).notNull();
      collection.string('docNo', { length: 32 }).notNull();
      collection.date('invoiceDate').notNull();
      collection.string('status', { length: 16 }).notNull().defaultTo('draft');
      collection.string('invoiceTypeCode', { length: 32 }).nullable();
      collection.string('issuerName', { length: 128 }).nullable();
      collection.string('invoiceNo', { length: 64 }).nullable();
      collection.string('supplierId', { length: 64 }).nullable();
      collection.string('bindMode', { length: 16 }).notNull();
      collection.string('handlerUserId', { length: 64 }).nullable();
      collection.string('projectCode', { length: 32 }).nullable();
      collection.string('remark', { length: 1000 }).notNull().defaultTo('');
      collection.decimal('totalAmount', { precision: 18, scale: 2 }).notNull().defaultTo(0);
      collection.string('createdById', { length: 64 }).notNull();
      collection.datetimeTz('confirmedAt').nullable();
      collection.datetimeTz('voidedAt').nullable();
      collection.datetimeTz('createdAt').notNull();
      collection.datetimeTz('updatedAt').notNull();
      collection.primary('id', { name: 'pk_invoice_receipt_records' });
      collection.unique('docNo', { name: 'uq_invoice_receipt_records_doc_no' });
      collection.index('invoiceDate', { name: 'ix_invoice_receipt_records_date' });
      collection.index('supplierId', { name: 'ix_invoice_receipt_records_supplier' });
    });

    await builder.createCollection('invoiceReceiptRecordLines', (collection) => {
      collection.string('id', { length: 64 }).notNull();
      collection.string('recordId', { length: 64 }).notNull();
      collection.string('purchaseOrderId', { length: 64 }).notNull();
      collection.decimal('orderPayableAmount', { precision: 18, scale: 2 }).notNull();
      collection.decimal('invoicedBefore', { precision: 18, scale: 2 }).notNull().defaultTo(0);
      collection.decimal('amount', { precision: 18, scale: 2 }).notNull();
      collection.string('note', { length: 500 }).nullable();
      collection.primary('id', { name: 'pk_invoice_receipt_record_lines' });
      collection.index('recordId', { name: 'ix_invoice_receipt_record_lines_record' });
    });

    await builder.alterCollection('purchaseOrders', (collection) => {
      collection.decimal('paidAmount', { precision: 18, scale: 2 }).notNull().defaultTo(0);
      collection.decimal('invoicedAmount', { precision: 18, scale: 2 }).notNull().defaultTo(0);
    });
  },
  async down({ builder }) {
    await builder.dropCollection('invoiceReceiptRecordLines');
    await builder.dropCollection('invoiceReceiptRecords');
    await builder.dropCollection('expenseRecordLines');
    await builder.dropCollection('expenseRecords');
    await builder.alterCollection('purchaseOrders', (collection) => {
      collection.dropField('paidAmount');
      collection.dropField('invoicedAmount');
    });
  },
});

export default migration;
