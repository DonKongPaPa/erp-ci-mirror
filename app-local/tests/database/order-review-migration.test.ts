// @vitest-environment node
import path from 'node:path';
import { describeMigration } from '@nocobase/app-testing/server';
import type { Knex } from 'knex';
import { describe, expect } from 'vitest';

/** R-064 验收 1：两张表的列、类型、可空、主键与三个索引逐项钉住；down 先删明细再删头。 */
const sources = [
  {
    packageName: 'order-review-migration-test',
    directory: path.resolve(import.meta.dirname, '../../database/main/migrations'),
  },
];

const REVIEW_FIELDS = [
  'id', 'salesOrderId', 'status', 'reviewerUserId', 'reviewedAt',
  'confirmedDeliveryDate', 'confirmedAt', 'createdById', 'createdAt', 'updatedAt',
].sort();
const LINE_FIELDS = ['id', 'reviewId', 'factor', 'conclusion', 'note'].sort();

interface ColumnInfo {
  data_type: string;
  is_nullable: string;
  character_maximum_length: number | null;
}

const columnsOf = async (
  connection: { client<T>(): Promise<T> },
  table: string,
): Promise<Record<string, ColumnInfo>> => {
  const knex = await connection.client<Knex>();
  const result = await knex.raw<{ rows?: (ColumnInfo & { column_name: string })[] }>(
    `select column_name, data_type, is_nullable, character_maximum_length
       from information_schema.columns
      where table_schema = current_schema() and table_name = ?`,
    [table],
  );
  return Object.fromEntries(
    (result.rows ?? []).map((row) => [row.column_name, row]),
  );
};

describe('R-064：订单评审的迁移', () => {
  describeMigration('202611260022_create_order_reviews', {
    sources,
    up: async ({ connection, expectCollection }) => {
      const review = await expectCollection('orderReviews').toExist();
      expect(Object.keys(review.fields).sort()).toEqual(REVIEW_FIELDS);
      expect(review.primaryKey).toEqual(['id']);
      expect(review.foreignKeys).toHaveLength(0);
      const line = await expectCollection('orderReviewLines').toExist();
      expect(Object.keys(line.fields).sort()).toEqual(LINE_FIELDS);
      expect(line.primaryKey).toEqual(['id']);
      expect(line.foreignKeys).toHaveLength(0);

      await expectCollection('orderReviews').toHaveIndex(['salesOrderId', 'status']);
      await expectCollection('orderReviews').toHaveIndex(['status', 'confirmedDeliveryDate']);
      await expectCollection('orderReviewLines').toHaveIndex(['reviewId']);

      const header = await columnsOf(connection, 'order_reviews');
      expect(header.id?.data_type).toBe('character varying');
      expect(header.id?.character_maximum_length).toBe(64);
      expect(header.status?.data_type).toBe('character varying');
      expect(header.status?.character_maximum_length).toBe(16);
      expect(header.status?.is_nullable).toBe('NO');
      expect(header.reviewed_at?.data_type).toBe('timestamp with time zone');
      expect(header.reviewed_at?.is_nullable).toBe('NO');
      expect(header.confirmed_delivery_date?.data_type).toBe('date');
      expect(header.confirmed_delivery_date?.is_nullable).toBe('YES');
      expect(header.confirmed_at?.data_type).toBe('timestamp with time zone');
      expect(header.confirmed_at?.is_nullable).toBe('YES');
      expect(header.created_by_id?.is_nullable).toBe('NO');

      const detail = await columnsOf(connection, 'order_review_lines');
      expect(detail.conclusion?.data_type).toBe('character varying');
      expect(detail.conclusion?.character_maximum_length).toBe(500);
      expect(detail.conclusion?.is_nullable).toBe('NO');
      expect(detail.note?.character_maximum_length).toBe(1000);
      expect(detail.note?.is_nullable).toBe('YES');

      // 这一片不给订单加列：确认交期在评审头上，不在 sales_orders。
      const orders = await expectCollection('salesOrders').toExist();
      expect(Object.keys(orders.fields)).not.toContain('confirmedDeliveryDate');
    },
    down: async ({ expectCollection }) => {
      await expectCollection('orderReviewLines').not.toExist();
      await expectCollection('orderReviews').not.toExist();
    },
  });
});
