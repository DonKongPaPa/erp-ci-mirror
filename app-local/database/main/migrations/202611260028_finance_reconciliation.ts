import { defineMigration, type MigrationDefinition } from '@nocobase/db';

/**
 * R-065 复刻波 2 加片：收入、开票、应收应付对账的六张单据表 + 一张对账快照表。
 *
 * 金额 decimal(18,2)，时间戳带时区；不建外键也不建数据库 CHECK，
 * 状态、绑定方式、金额与同一张记录的往来单位一致性都在服务层守。
 * sales_orders 补两个回写列；第一片两张明细表补可空的 payableReconId，既有口径不变。
 * down 先删新表，再删两处的列。
 */
const migration: MigrationDefinition = defineMigration({
  name: '202611260028_finance_reconciliation',
  async up({ builder }) {
    await builder.createCollection('incomeRecords', (collection) => {
      collection.string('id', { length: 64 }).notNull();
      collection.string('docNo', { length: 32 }).notNull();
      collection.date('incomeDate').notNull();
      collection.string('status', { length: 16 }).notNull().defaultTo('draft');
      collection.string('incomeTypeCode', { length: 32 }).nullable();
      collection.string('fundAccountCode', { length: 32 }).nullable();
      collection.string('payerName', { length: 128 }).nullable();
      collection.string('customerId', { length: 64 }).nullable();
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
      collection.primary('id', { name: 'pk_income_records' });
      collection.unique('docNo', { name: 'uq_income_records_doc_no' });
      collection.index('incomeDate', { name: 'ix_income_records_date' });
      collection.index('customerId', { name: 'ix_income_records_customer' });
    });

    await builder.createCollection('incomeRecordLines', (collection) => {
      collection.string('id', { length: 64 }).notNull();
      collection.string('recordId', { length: 64 }).notNull();
      collection.string('salesOrderId', { length: 64 }).nullable();
      collection.string('receivableReconId', { length: 64 }).nullable();
      collection.decimal('orderPayableAmount', { precision: 18, scale: 2 }).notNull().defaultTo(0);
      collection.decimal('receivedBefore', { precision: 18, scale: 2 }).notNull().defaultTo(0);
      collection.decimal('amount', { precision: 18, scale: 2 }).notNull();
      collection.string('note', { length: 500 }).nullable();
      collection.primary('id', { name: 'pk_income_record_lines' });
      collection.index('recordId', { name: 'ix_income_record_lines_record' });
    });

    await builder.createCollection('saleInvoiceRecords', (collection) => {
      collection.string('id', { length: 64 }).notNull();
      collection.string('docNo', { length: 32 }).notNull();
      collection.date('invoiceDate').notNull();
      collection.string('status', { length: 16 }).notNull().defaultTo('draft');
      collection.string('invoiceTypeCode', { length: 32 }).nullable();
      collection.string('invoiceToName', { length: 128 }).nullable();
      collection.string('invoiceNo', { length: 64 }).nullable();
      collection.string('customerId', { length: 64 }).nullable();
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
      collection.primary('id', { name: 'pk_sale_invoice_records' });
      collection.unique('docNo', { name: 'uq_sale_invoice_records_doc_no' });
      collection.index('invoiceDate', { name: 'ix_sale_invoice_records_date' });
      collection.index('customerId', { name: 'ix_sale_invoice_records_customer' });
    });

    await builder.createCollection('saleInvoiceRecordLines', (collection) => {
      collection.string('id', { length: 64 }).notNull();
      collection.string('recordId', { length: 64 }).notNull();
      collection.string('salesOrderId', { length: 64 }).nullable();
      collection.string('receivableReconId', { length: 64 }).nullable();
      collection.decimal('orderPayableAmount', { precision: 18, scale: 2 }).notNull().defaultTo(0);
      collection.decimal('invoicedBefore', { precision: 18, scale: 2 }).notNull().defaultTo(0);
      collection.decimal('amount', { precision: 18, scale: 2 }).notNull();
      collection.string('note', { length: 500 }).nullable();
      collection.primary('id', { name: 'pk_sale_invoice_record_lines' });
      collection.index('recordId', { name: 'ix_sale_invoice_record_lines_record' });
    });

    await builder.createCollection('receivableRecons', (collection) => {
      collection.string('id', { length: 64 }).notNull();
      collection.string('docNo', { length: 32 }).notNull();
      collection.date('reconDate').notNull();
      collection.date('expectedPayDate').nullable();
      collection.string('customerId', { length: 64 }).notNull();
      collection.string('contactName', { length: 128 }).nullable();
      collection.string('phone', { length: 64 }).nullable();
      collection.decimal('periodAmount', { precision: 18, scale: 2 }).notNull();
      collection.string('status', { length: 16 }).notNull().defaultTo('draft');
      collection.string('reconStatus', { length: 16 }).notNull().defaultTo('unsettled');
      collection.decimal('reconciledIncomeAmount', { precision: 18, scale: 2 }).notNull().defaultTo(0);
      collection.decimal('reconciledInvoiceAmount', { precision: 18, scale: 2 }).notNull().defaultTo(0);
      collection.string('handlerUserId', { length: 64 }).nullable();
      collection.string('projectCode', { length: 32 }).nullable();
      collection.string('remark', { length: 1000 }).notNull().defaultTo('');
      collection.string('createdById', { length: 64 }).notNull();
      collection.datetimeTz('confirmedAt').nullable();
      collection.datetimeTz('voidedAt').nullable();
      collection.datetimeTz('createdAt').notNull();
      collection.datetimeTz('updatedAt').notNull();
      collection.primary('id', { name: 'pk_receivable_recons' });
      collection.unique('docNo', { name: 'uq_receivable_recons_doc_no' });
      collection.index('reconDate', { name: 'ix_receivable_recons_date' });
      collection.index('customerId', { name: 'ix_receivable_recons_customer' });
    });

    await builder.createCollection('payableRecons', (collection) => {
      collection.string('id', { length: 64 }).notNull();
      collection.string('docNo', { length: 32 }).notNull();
      collection.date('reconDate').notNull();
      collection.date('expectedPayDate').nullable();
      collection.string('supplierId', { length: 64 }).notNull();
      collection.string('invoiceTypeCode', { length: 32 }).nullable();
      collection.string('contactName', { length: 128 }).nullable();
      collection.string('phone', { length: 64 }).nullable();
      collection.decimal('periodAmount', { precision: 18, scale: 2 }).notNull();
      collection.string('status', { length: 16 }).notNull().defaultTo('draft');
      collection.string('reconStatus', { length: 16 }).notNull().defaultTo('unsettled');
      collection.decimal('reconciledPaidAmount', { precision: 18, scale: 2 }).notNull().defaultTo(0);
      collection.decimal('reconciledInvoiceAmount', { precision: 18, scale: 2 }).notNull().defaultTo(0);
      collection.string('handlerUserId', { length: 64 }).nullable();
      collection.string('projectCode', { length: 32 }).nullable();
      collection.string('remark', { length: 1000 }).notNull().defaultTo('');
      collection.string('createdById', { length: 64 }).notNull();
      collection.datetimeTz('confirmedAt').nullable();
      collection.datetimeTz('voidedAt').nullable();
      collection.datetimeTz('createdAt').notNull();
      collection.datetimeTz('updatedAt').notNull();
      collection.primary('id', { name: 'pk_payable_recons' });
      collection.unique('docNo', { name: 'uq_payable_recons_doc_no' });
      collection.index('reconDate', { name: 'ix_payable_recons_date' });
      collection.index('supplierId', { name: 'ix_payable_recons_supplier' });
    });

    // 对账快照：只读，随对账单建单摊开，上游再变不改历史。
    await builder.createCollection('reconSnapshotLines', (collection) => {
      collection.string('id', { length: 64 }).notNull();
      collection.string('reconId', { length: 64 }).notNull();
      collection.string('side', { length: 8 }).notNull();
      collection.string('sourceDocId', { length: 64 }).notNull();
      collection.string('itemId', { length: 64 }).notNull();
      collection.string('itemCode', { length: 64 }).notNull();
      collection.string('itemName', { length: 128 }).notNull();
      collection.string('itemSpec', { length: 128 }).nullable();
      collection.string('unitCode', { length: 32 }).notNull();
      collection.decimal('qty', { precision: 18, scale: 4 }).notNull().defaultTo(0);
      collection.decimal('taxRate', { precision: 5, scale: 2 }).nullable();
      collection.decimal('taxIncludedPrice', { precision: 18, scale: 4 }).nullable();
      collection.decimal('taxIncludedAmount', { precision: 18, scale: 2 }).nullable();
      collection.string('note', { length: 500 }).nullable();
      collection.primary('id', { name: 'pk_recon_snapshot_lines' });
      collection.index('reconId', { name: 'ix_recon_snapshot_lines_recon' });
    });

    await builder.alterCollection('salesOrders', (collection) => {
      collection.decimal('receivedAmount', { precision: 18, scale: 2 }).notNull().defaultTo(0);
      collection.decimal('invoicedAmount', { precision: 18, scale: 2 }).notNull().defaultTo(0);
    });

    await builder.alterCollection('expenseRecordLines', (collection) => {
      collection.string('payableReconId', { length: 64 }).nullable();
    });
    await builder.alterCollection('invoiceReceiptRecordLines', (collection) => {
      collection.string('payableReconId', { length: 64 }).nullable();
    });
  },
  async down({ builder }) {
    await builder.dropCollection('reconSnapshotLines');
    await builder.dropCollection('payableRecons');
    await builder.dropCollection('receivableRecons');
    await builder.dropCollection('saleInvoiceRecordLines');
    await builder.dropCollection('saleInvoiceRecords');
    await builder.dropCollection('incomeRecordLines');
    await builder.dropCollection('incomeRecords');
    await builder.alterCollection('salesOrders', (collection) => {
      collection.dropField('receivedAmount');
      collection.dropField('invoicedAmount');
    });
    await builder.alterCollection('invoiceReceiptRecordLines', (collection) => {
      collection.dropField('payableReconId');
    });
    await builder.alterCollection('expenseRecordLines', (collection) => {
      collection.dropField('payableReconId');
    });
  },
});

export default migration;
