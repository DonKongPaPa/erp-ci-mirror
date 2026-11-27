// @vitest-environment node
import path from 'node:path';
import { describeMigration } from '@nocobase/app-testing/server';
import type { Knex } from 'knex';
import { describe, expect } from 'vitest';

/**
 * R-021 波 1 加片验收 1：两张表的列、类型、主键、唯一约束、索引逐项钉住，
 * 采购订单多一列与一个索引；down 先删两张表再删列。
 */
const sources = [
  {
    packageName: 'purchase-request-migration-test',
    directory: path.resolve(import.meta.dirname, '../../database/main/migrations'),
  },
];

const REQUEST_FIELDS = [
  'id', 'docNo', 'requestDate', 'departmentId', 'requesterUserId',
  'projectCode', 'customText1', 'customText2', 'description', 'status',
  'approvalId', 'convertedOrderId', 'totalQty', 'estimatedTotal',
  'createdById', 'createdAt', 'updatedAt',
].sort();
const LINE_FIELDS = [
  'id', 'requestId', 'itemId', 'qty', 'expectedPrice', 'expectedAmount',
].sort();

interface ColumnInfo {
  data_type: string;
  is_nullable: string;
  character_maximum_length: number | null;
  numeric_precision: number | null;
  numeric_scale: number | null;
}

const columnsOf = async (
  connection: { client<T>(): Promise<T> },
  table: string,
): Promise<Record<string, ColumnInfo>> => {
  const knex = await connection.client<Knex>();
  const result = await knex.raw<{ rows?: (ColumnInfo & { column_name: string })[] }>(
    `select column_name, data_type, is_nullable, character_maximum_length,
            numeric_precision, numeric_scale
       from information_schema.columns
      where table_schema = current_schema() and table_name = ?`,
    [table],
  );
  return Object.fromEntries(
    (result.rows ?? []).map((row) => [row.column_name, row]),
  );
};

describe('R-021 波 1 加片：请购单的迁移', () => {
  describeMigration('202611260024_purchase_requests', {
    sources,
    up: async ({ connection, expectCollection }) => {
      const header = await expectCollection('purchaseRequests').toExist();
      expect(Object.keys(header.fields).sort()).toEqual(REQUEST_FIELDS);
      expect(header.primaryKey).toEqual(['id']);
      expect(header.foreignKeys).toHaveLength(0);
      const lines = await expectCollection('purchaseRequestLines').toExist();
      expect(Object.keys(lines.fields).sort()).toEqual(LINE_FIELDS);
      expect(lines.primaryKey).toEqual(['id']);
      expect(lines.foreignKeys).toHaveLength(0);

      await expectCollection('purchaseRequests').toHaveIndex(['docNo'], { unique: true });
      await expectCollection('purchaseRequests').toHaveIndex(['requestDate']);
      await expectCollection('purchaseRequests').toHaveIndex(['projectCode']);
      await expectCollection('purchaseRequests').toHaveIndex(['approvalId']);
      await expectCollection('purchaseRequestLines').toHaveIndex(['requestId']);

      const request = await columnsOf(connection, 'purchase_requests');
      expect(request.id?.character_maximum_length).toBe(64);
      expect(request.doc_no?.character_maximum_length).toBe(32);
      expect(request.status?.character_maximum_length).toBe(16);
      expect(request.status?.is_nullable).toBe('NO');
      expect(request.created_by_id?.is_nullable).toBe('NO');
      expect(request.request_date?.data_type).toBe('date');
      expect(request.created_at?.data_type).toBe('timestamp with time zone');
      expect(request.approval_id?.is_nullable).toBe('YES');
      expect(request.converted_order_id?.is_nullable).toBe('YES');
      expect(request.description?.character_maximum_length).toBe(2000);
      expect(request.description?.is_nullable).toBe('NO');
      expect({
        precision: Number(request.total_qty?.numeric_precision),
        scale: Number(request.total_qty?.numeric_scale),
      }).toEqual({ precision: 18, scale: 4 });
      expect({
        precision: Number(request.estimated_total?.numeric_precision),
        scale: Number(request.estimated_total?.numeric_scale),
      }).toEqual({ precision: 18, scale: 2 });

      const line = await columnsOf(connection, 'purchase_request_lines');
      expect({
        precision: Number(line.qty?.numeric_precision),
        scale: Number(line.qty?.numeric_scale),
      }).toEqual({ precision: 18, scale: 4 });
      expect({
        precision: Number(line.expected_price?.numeric_precision),
        scale: Number(line.expected_price?.numeric_scale),
      }).toEqual({ precision: 18, scale: 2 });
      expect(line.expected_amount?.is_nullable).toBe('YES');

      const orders = await expectCollection('purchaseOrders').toExist();
      expect(Object.keys(orders.fields)).toContain('purchaseRequestId');
      await expectCollection('purchaseOrders').toHaveIndex(['purchaseRequestId']);
      const orderColumns = await columnsOf(connection, 'purchase_orders');
      expect(orderColumns.purchase_request_id?.character_maximum_length).toBe(64);
      expect(orderColumns.purchase_request_id?.is_nullable).toBe('YES');
      const physical = await connection.schemaInspector.getPhysicalCollection({
        tableName: 'purchase_orders',
      });
      expect(physical?.indexes.map((index) => index.name)).toContain('ix_purchase_orders_request');
    },
    down: async ({ expectCollection }) => {
      await expectCollection('purchaseRequestLines').not.toExist();
      await expectCollection('purchaseRequests').not.toExist();
      const orders = await expectCollection('purchaseOrders').toExist();
      expect(Object.keys(orders.fields)).not.toContain('purchaseRequestId');
    },
  });
});
