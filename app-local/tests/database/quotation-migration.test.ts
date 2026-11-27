// @vitest-environment node
import path from 'node:path';
import { describeMigration } from '@nocobase/app-testing/server';
import type { Knex } from 'knex';
import { describe, expect } from 'vitest';

/** expectCollection 只看字段；精度与时区从真库的信息模式读回来钉住。 */
async function expectDecimal(
  connection: { client<T>(): Promise<T> },
  table: string,
  column: string,
  precision = 18,
  scale = 4,
): Promise<void> {
  const knex = await connection.client<Knex>();
  const result = await knex.raw<{
    rows?: { numeric_precision: number; numeric_scale: number }[];
  }>(
    `select numeric_precision, numeric_scale from information_schema.columns
      where table_schema = current_schema() and table_name = ? and column_name = ?`,
    [table, column],
  );
  const row = result.rows?.[0];
  expect({ precision: Number(row?.numeric_precision), scale: Number(row?.numeric_scale) },
    `${table}.${column} 必须是 decimal(${precision},${scale})`)
    .toEqual({ precision, scale });
}

async function expectType(
  connection: { client<T>(): Promise<T> },
  table: string,
  column: string,
  type: string,
): Promise<void> {
  const knex = await connection.client<Knex>();
  const result = await knex.raw<{ rows?: { data_type: string }[] }>(
    `select data_type from information_schema.columns
      where table_schema = current_schema() and table_name = ? and column_name = ?`,
    [table, column],
  );
  expect(result.rows?.[0]?.data_type, `${table}.${column} 必须是 ${type}`).toBe(type);
}

const sources = [{
  packageName: 'quotations-migration-test',
  directory: path.resolve(import.meta.dirname, '../../database/main/migrations'),
}];

const QUOTATION_FIELDS = [
  'contactName', 'contactPhone', 'convertedOrderId', 'createdAt', 'createdById',
  'customerId', 'customerOrderNo', 'deliveryAddress', 'discountAmount', 'docNo',
  'handlerUserId', 'id', 'payableTotal', 'projectCode', 'quoteDate', 'settlementCode',
  'status', 'taxExcludedTotal', 'taxIncludedTotal', 'taxTotal', 'totalQty',
  'updatedAt', 'validUntil', 'warehouseId',
].sort();
const LINE_FIELDS = [
  'deliveryDate', 'id', 'itemId', 'note', 'price', 'qty', 'quotationId',
  'taxAmount', 'taxExcludedAmount', 'taxExcludedPrice',
  'taxIncludedAmount', 'taxRate',
].sort();
/** 销售订单在波 0 的 24 列基础上只多一列，不回填。 */
const SALES_FIELDS_WITH_QUOTATION = [
  'createdAt', 'createdById', 'customerId', 'id', 'orderDate', 'orderNo',
  'remark', 'status', 'submittedAt', 'updatedAt',
  'contactName', 'contactPhone', 'customerOrderNo', 'deliveryAddress',
  'discountAmount', 'handlerUserId', 'latestDeliveryDate', 'projectCode',
  'settlementCode', 'taxExcludedTotal', 'taxIncludedTotal', 'taxTotal',
  'totalQty', 'payableTotal', 'warehouseId',
  'quotationId',
].sort();

describe('R-022 复刻波 1：报价单的迁移', () => {
  describeMigration('202611260026_quotations', {
    sources,
    up: async ({ connection, expectCollection }) => {
      const header = await expectCollection('quotations').toExist();
      expect(Object.keys(header.fields).sort()).toEqual(QUOTATION_FIELDS);
      expect(header.primaryKey).toEqual(['id']);
      expect(header.foreignKeys).toHaveLength(0);
      await expectCollection('quotations').toHaveField('docNo', {
        type: 'string', length: 32, nullable: false,
      });
      await expectCollection('quotations').toHaveField('status', {
        type: 'string', length: 16, nullable: false,
      });
      for (const index of ['quoteDate', 'validUntil', 'customerId', 'handlerUserId']) {
        await expectCollection('quotations').toHaveIndex([index]);
      }
      await expectType(connection, 'quotations', 'quote_date', 'date');
      await expectType(connection, 'quotations', 'valid_until', 'date');
      for (const column of ['created_at', 'updated_at']) {
        await expectType(connection, 'quotations', column, 'timestamp with time zone');
      }
      for (const column of [
        'discount_amount', 'total_qty', 'tax_included_total', 'tax_excluded_total',
        'tax_total', 'payable_total',
      ]) {
        await expectDecimal(connection, 'quotations', column);
      }
      const physical = await connection.schemaInspector.getPhysicalCollection({ tableName: 'quotations' });
      expect([...(physical?.indexes.map((index) => index.name) ?? [])].sort()).toEqual([
        'ix_quotations_customer', 'ix_quotations_date', 'ix_quotations_handler',
        'ix_quotations_valid_until', 'pk_quotations', 'uq_quotations_doc_no',
      ]);

      const lines = await expectCollection('quotationLines').toExist();
      expect(Object.keys(lines.fields).sort()).toEqual(LINE_FIELDS);
      expect(lines.primaryKey).toEqual(['id']);
      expect(lines.foreignKeys).toHaveLength(0);
      await expectCollection('quotationLines').toHaveIndex(['quotationId']);
      await expectDecimal(connection, 'quotation_lines', 'tax_rate', 5, 2);
      for (const column of [
        'qty', 'price', 'tax_excluded_price', 'tax_excluded_amount',
        'tax_amount', 'tax_included_amount',
      ]) {
        await expectDecimal(connection, 'quotation_lines', column);
      }

      const sales = await expectCollection('salesOrders').toExist();
      expect(Object.keys(sales.fields).sort()).toEqual(SALES_FIELDS_WITH_QUOTATION);
      await expectCollection('salesOrders').toHaveIndex(['quotationId']);
      const salesPhysical = await connection.schemaInspector.getPhysicalCollection({
        tableName: 'sales_orders',
      });
      expect(salesPhysical?.indexes.map((index) => index.name)).toContain('ix_sales_orders_quotation');

      // 只加列不回填：存量行读回 null；新行默认 status=draft、discountAmount=0。
      const now = '2026-11-28T02:00:00.000Z';
      await connection.query.insertInto('sales_orders').values({
        id: `so-before-${randomId()}`,
        order_no: `XS-OLD-${randomId()}`,
        customer_id: `cu-${randomId()}`,
        order_date: '2026-11-27',
        created_by_id: 'tester',
        created_at: now,
        updated_at: now,
      }).execute();
      const stored = await connection.query.selectFrom('sales_orders')
        .selectAll().where('order_no', 'like', 'XS-OLD-%').executeTakeFirstOrThrow();
      expect(stored.quotationId).toBeNull();
      await connection.query.insertInto('quotations').values({
        id: `q-${randomId()}`,
        doc_no: `QT-OLD-${randomId()}`,
        quote_date: '2026-11-28',
        created_by_id: 'tester',
        created_at: now,
        updated_at: now,
      }).execute();
      const quote = await connection.query.selectFrom('quotations')
        .selectAll().where('doc_no', 'like', 'QT-OLD-%').executeTakeFirstOrThrow();
      expect(quote.status).toBe('draft');
      expect(Number(quote.discountAmount)).toBe(0);
      expect(quote.validUntil).toBeNull();
      expect(quote.convertedOrderId).toBeNull();
    },
    down: async ({ connection, expectCollection }) => {
      await expectCollection('quotationLines').not.toExist();
      await expectCollection('quotations').not.toExist();
      const sales = await expectCollection('salesOrders').toExist();
      expect(Object.keys(sales.fields)).not.toContain('quotationId');
      const physical = await connection.schemaInspector.getPhysicalCollection({ tableName: 'sales_orders' });
      expect(physical?.indexes.map((index) => index.name)).not.toContain('ix_sales_orders_quotation');
    },
  });
});

function randomId(): string {
  return Math.random().toString(36).slice(2, 10);
}
