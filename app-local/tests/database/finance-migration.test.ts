// @vitest-environment node
import path from 'node:path';
import { describeMigration } from '@nocobase/app-testing/server';
import type { Knex } from 'knex';
import { describe, expect } from 'vitest';

/** R-065 验收 1：四张表的列、主键、唯一约束与索引逐项钉住；订单两列默认 0。 */
const sources = [
  {
    packageName: 'finance-migration-test',
    directory: path.resolve(import.meta.dirname, '../../database/main/migrations'),
  },
];

const HEADER = [
  'id', 'docNo', 'expenseDate', 'status', 'expenseTypeCode', 'fundAccountCode',
  'payeeName', 'supplierId', 'payeeAccountNo', 'payeeBankName', 'payeeBankCode',
  'bindMode', 'handlerUserId', 'projectCode', 'remark', 'totalAmount',
  'createdById', 'confirmedAt', 'voidedAt', 'createdAt', 'updatedAt',
].sort();
const EXPENSE_LINES = [
  'id', 'recordId', 'purchaseOrderId', 'orderPayableAmount', 'paidBefore', 'amount', 'note',
].sort();
const INVOICE_HEADER = HEADER
  .filter((field) => !['expenseDate', 'expenseTypeCode', 'fundAccountCode', 'payeeName',
    'payeeAccountNo', 'payeeBankName', 'payeeBankCode'].includes(field))
  .concat(['invoiceDate', 'invoiceTypeCode', 'issuerName', 'invoiceNo'])
  .sort();
const INVOICE_LINES = [
  'id', 'recordId', 'purchaseOrderId', 'orderPayableAmount', 'invoicedBefore', 'amount', 'note',
].sort();

describe('R-065：支出与到票的迁移', () => {
  describeMigration('202611260021_finance_records', {
    sources,
    up: async ({ connection, expectCollection }) => {
      for (const [collection, table, fields] of [
        ['expenseRecords', 'expense_records', HEADER],
        ['expenseRecordLines', 'expense_record_lines', EXPENSE_LINES],
        ['invoiceReceiptRecords', 'invoice_receipt_records', INVOICE_HEADER],
        ['invoiceReceiptRecordLines', 'invoice_receipt_record_lines', INVOICE_LINES],
      ] as const) {
        const found = await expectCollection(collection).toExist();
        expect(Object.keys(found.fields).sort()).toEqual(fields);
        expect(found.primaryKey).toEqual(['id']);
        expect(found.foreignKeys).toHaveLength(0);
        const physical = await connection.schemaInspector.getPhysicalCollection({ tableName: table });
        expect(physical?.indexes.map((index) => index.name)).toContain(`pk_${table}`);
      }
      await expectCollection('expenseRecords').toHaveIndex(['expenseDate']);
      await expectCollection('expenseRecords').toHaveIndex(['supplierId']);
      await expectCollection('expenseRecordLines').toHaveIndex(['recordId']);
      await expectCollection('invoiceReceiptRecords').toHaveIndex(['invoiceDate']);
      await expectCollection('invoiceReceiptRecords').toHaveIndex(['supplierId']);
      await expectCollection('invoiceReceiptRecordLines').toHaveIndex(['recordId']);

      const knex = await connection.client<Knex>();
      const result = await knex.raw<{ rows?: { numeric_precision: number; numeric_scale: number }[] }>(
        `select numeric_precision, numeric_scale from information_schema.columns
          where table_schema = current_schema() and table_name = 'expense_records'
            and column_name = 'total_amount'`,
      );
      expect({
        precision: Number(result.rows?.[0]?.numeric_precision),
        scale: Number(result.rows?.[0]?.numeric_scale),
      }).toEqual({ precision: 18, scale: 2 });

      const orders = await expectCollection('purchaseOrders').toExist();
      expect(Object.keys(orders.fields)).toContain('paidAmount');
      expect(Object.keys(orders.fields)).toContain('invoicedAmount');
      await connection.query.insertInto('purchase_orders').values({
        id: `po-fin-${Date.now()}`,
        order_no: `PO-FIN-${Date.now()}`,
        supplier_id: 'su-fin',
        order_date: '2026-11-28',
        created_by_id: 'tester',
        created_at: new Date(),
        updated_at: new Date(),
      }).execute();
      const row = await connection.query.selectFrom('purchase_orders').selectAll().limit(1).executeTakeFirstOrThrow();
      expect(Number(row.paidAmount)).toBe(0);
      expect(Number(row.invoicedAmount)).toBe(0);
    },
    down: async ({ expectCollection }) => {
      for (const collection of ['expenseRecordLines', 'expenseRecords',
        'invoiceReceiptRecordLines', 'invoiceReceiptRecords'] as const) {
        await expectCollection(collection).not.toExist();
      }
      const orders = await expectCollection('purchaseOrders').toExist();
      expect(Object.keys(orders.fields)).not.toContain('paidAmount');
      expect(Object.keys(orders.fields)).not.toContain('invoicedAmount');
    },
  });
});
