// @vitest-environment node
import path from 'node:path';
import { describeMigration } from '@nocobase/app-testing/server';
import type { Knex } from 'knex';
import { describe, expect } from 'vitest';

/**
 * R-066 验收 1：一张新表的全部列、类型、可空、默认值、主键、唯一约束与两个索引
 * 逐项钉住；down 删干净；不改已执行的 expenseRecords 与 approvals。
 */
const sources = [
  {
    packageName: 'finance-request-migration-test',
    directory: path.resolve(import.meta.dirname, '../../database/main/migrations'),
  },
];

const FIELDS = [
  'id', 'docType', 'docNo', 'requestDate', 'expenseTypeCode', 'amount',
  'reason', 'handlerUserId', 'projectCode', 'status', 'approvalId',
  'expenseRecordId', 'createdById', 'createdAt', 'updatedAt',
].sort();

interface ColumnInfo {
  data_type: string;
  is_nullable: string;
  column_default: string | null;
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
    `select column_name, data_type, is_nullable, column_default,
            character_maximum_length, numeric_precision, numeric_scale
       from information_schema.columns
      where table_schema = current_schema() and table_name = ?`,
    [table],
  );
  return Object.fromEntries((result.rows ?? []).map((row) => [row.column_name, row]));
};

describe('R-066: 请款单与报销单的迁移', () => {
  describeMigration('202611260025_finance_request_docs', {
    sources,
    up: async ({ connection, expectCollection }) => {
      const docs = await expectCollection('financeRequestDocs').toExist();
      expect(Object.keys(docs.fields).sort()).toEqual(FIELDS);
      expect(docs.primaryKey).toEqual(['id']);
      expect(docs.foreignKeys).toHaveLength(0);

      await expectCollection('financeRequestDocs').toHaveIndex(['docNo'], { unique: true });
      await expectCollection('financeRequestDocs').toHaveIndex(['docType', 'requestDate']);
      await expectCollection('financeRequestDocs').toHaveIndex(['approvalId']);

      const physical = await connection.schemaInspector.getPhysicalCollection({
        tableName: 'finance_request_docs',
      });
      expect(physical?.indexes.map((index) => index.name)).toEqual(
        expect.arrayContaining([
          'uq_finance_request_docs_doc_no',
          'ix_finance_request_docs_date',
          'ix_finance_request_docs_approval',
        ]),
      );

      const c = await columnsOf(connection, 'finance_request_docs');
      expect(c.id?.character_maximum_length).toBe(64);
      expect(c.doc_type?.character_maximum_length).toBe(16);
      expect(c.doc_type?.is_nullable).toBe('NO');
      expect(c.doc_no?.character_maximum_length).toBe(32);
      expect(c.request_date?.data_type).toBe('date');
      expect(c.expense_type_code?.character_maximum_length).toBe(32);
      expect(c.expense_type_code?.is_nullable).toBe('YES');
      expect(c.reason?.character_maximum_length).toBe(1000);
      expect(c.handler_user_id?.character_maximum_length).toBe(64);
      expect(c.project_code?.is_nullable).toBe('YES');
      expect(c.status?.character_maximum_length).toBe(16);
      expect(c.status?.is_nullable).toBe('NO');
      expect(c.status?.column_default).toContain('draft');
      expect(c.approval_id?.is_nullable).toBe('YES');
      expect(c.expense_record_id?.is_nullable).toBe('YES');
      expect(c.created_by_id?.is_nullable).toBe('NO');
      expect(c.created_at?.data_type).toBe('timestamp with time zone');
      expect(c.updated_at?.data_type).toBe('timestamp with time zone');
      expect({
        precision: Number(c.amount?.numeric_precision),
        scale: Number(c.amount?.numeric_scale),
      }).toEqual({ precision: 18, scale: 2 });
      expect(c.amount?.is_nullable).toBe('NO');

      // 两张既有表保持原样，本片只建新表。
      expect((await expectCollection('expenseRecords').toExist()).primaryKey).toEqual(['id']);
      expect((await expectCollection('approvals').toExist()).primaryKey).toEqual(['id']);
    },
    down: async ({ expectCollection }) => {
      await expectCollection('financeRequestDocs').not.toExist();
      await expectCollection('expenseRecords').toExist();
      await expectCollection('approvals').toExist();
    },
  });
});
