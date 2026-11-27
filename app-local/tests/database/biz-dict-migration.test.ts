// @vitest-environment node
import path from 'node:path';
import { describeMigration } from '@nocobase/app-testing/server';
import type { Knex } from 'knex';
import { describe, expect } from 'vitest';

/** 值的默认值从真库的信息模式读回来钉住；expectCollection 只看类型与可空。 */
async function expectDefault(
  connection: { client<T>(): Promise<T> },
  table: string,
  column: string,
  expected: string,
): Promise<void> {
  const knex = await connection.client<Knex>();
  const result = await knex.raw<{
    rows?: { column_default: string | null }[];
  }>(
    `select column_default from information_schema.columns
      where table_schema = current_schema() and table_name = ? and column_name = ?`,
    [table, column],
  );
  const raw = result.rows?.[0]?.column_default ?? '';
  const value = raw.replace(/::[a-zA-Z ]+/gu, '').replace(/'/gu, '');
  expect(value, `${table}.${column} 默认值`).toBe(expected);
}

async function expectDecimal(
  connection: { client<T>(): Promise<T> },
  table: string,
  column: string,
  precision: number,
  scale: number,
): Promise<void> {
  const knex = await connection.client<Knex>();
  const result = await knex.raw<{
    rows?: { numeric_precision: number; numeric_scale: number }[];
  }>(
    `select numeric_precision, numeric_scale from information_schema.columns
      where table_schema = current_schema() and table_name = ? and column_name = ?`,
    [table, column],
  );
  expect(
    {
      precision: Number(result.rows?.[0]?.numeric_precision),
      scale: Number(result.rows?.[0]?.numeric_scale),
    },
    `${table}.${column} 必须是 decimal(${precision},${scale})`,
  ).toEqual({ precision, scale });
}

async function tableNames(
  connection: { schemaInspector: { scanPhysicalCollections(options: unknown): AsyncIterable<{ tableName: string }> } },
): Promise<string[]> {
  const tables: string[] = [];
  for await (const collection of connection.schemaInspector.scanPhysicalCollections({
    kinds: ['table'],
  })) {
    if (!collection.tableName.startsWith('__nocobase_')) {
      tables.push(collection.tableName);
    }
  }
  return tables;
}

const sources = [
  {
    packageName: 'biz-dict-migration-test',
    directory: path.resolve(import.meta.dirname, '../../database/main/migrations'),
  },
];

/** 迁移 202611260015 之前已有的全部业务表（含采购、销售订单）。 */
const PREVIOUS_TABLES = [
  'approval_records',
  'approval_rounds',
  'approvals',
  'code_sequences',
  'item_categories',
  'items',
  'department_member_history',
  'department_members',
  'departments',
  'device_code',
  'employee_changes',
  'employees',
  'fqc_feedback_files',
  'fqc_feedback_reminders',
  'fqc_messages',
  'fqc_routing_rules',
  'fqc_screening_reviews',
  'fqc_screenings',
  'fqc_tickets',
  'job_grades',
  'lifecycle_effect_runs',
  'lifecycle_transitions',
  'mutation_receipts',
  'partner_contacts',
  'partners',
  'positions',
  'purchase_order_lines',
  'purchase_orders',
  'sales_order_lines',
  'sales_orders',
  'shifts',
  'stock_balances',
  'stock_doc_lines',
  'stock_docs',
  'stock_transactions',
  'units',
  'warehouses',
];

const ENTRY_FIELDS = [
  'code',
  'createdAt',
  'createdById',
  'description',
  'dictType',
  'endDate',
  'id',
  'isDefault',
  'name',
  'rate',
  'sort',
  'startDate',
  'status',
  'updatedAt',
];

describe('R-072：业务字典的迁移', () => {
  describeMigration('202611260015_create_biz_dict', {
    sources,
    up: async ({ connection, expectCollection }) => {
      const entries = await expectCollection('bizDictEntries').toExist();
      expect(Object.keys(entries.fields).sort(), '14 列').toEqual(ENTRY_FIELDS);
      expect(entries.primaryKey).toEqual(['id']);
      expect(entries.foreignKeys).toHaveLength(0);

      await expectCollection('bizDictEntries').toHaveField('id', {
        type: 'string', length: 64, nullable: false,
      });
      await expectCollection('bizDictEntries').toHaveField('dictType', {
        type: 'string', length: 32, nullable: false,
      });
      await expectCollection('bizDictEntries').toHaveField('code', {
        type: 'string', length: 64, nullable: false,
      });
      await expectCollection('bizDictEntries').toHaveField('name', {
        type: 'string', length: 128, nullable: false,
      });
      await expectCollection('bizDictEntries').toHaveField('rate', {
        type: 'decimal', nullable: true,
      });
      await expectDecimal(connection, 'biz_dict_entries', 'rate', 5, 2);
      for (const field of ['startDate', 'endDate'] as const) {
        await expectCollection('bizDictEntries').toHaveField(field, {
          type: 'date', nullable: true,
        });
      }
      await expectCollection('bizDictEntries').toHaveField('description', {
        type: 'text', nullable: true,
      });
      await expectCollection('bizDictEntries').toHaveField('isDefault', {
        type: 'boolean', nullable: false,
      });
      await expectCollection('bizDictEntries').toHaveField('sort', {
        type: 'integer', nullable: false,
      });
      await expectCollection('bizDictEntries').toHaveField('status', {
        type: 'string', length: 16, nullable: false,
      });
      await expectCollection('bizDictEntries').toHaveField('createdById', {
        type: 'string', length: 64, nullable: false,
      });
      for (const field of ['createdAt', 'updatedAt'] as const) {
        await expectCollection('bizDictEntries').toHaveField(field, {
          type: 'datetimeTz', nullable: false,
        });
      }

      await expectDefault(connection, 'biz_dict_entries', 'is_default', 'false');
      await expectDefault(connection, 'biz_dict_entries', 'sort', '0');
      await expectDefault(connection, 'biz_dict_entries', 'status', 'active');

      await expectCollection('bizDictEntries').toHaveIndex(['dictType', 'code'], {
        unique: true,
      });
      await expectCollection('bizDictEntries').toHaveIndex(
        ['dictType', 'status', 'sort'],
        { unique: false },
      );
      const physical = await connection.schemaInspector.getPhysicalCollection({
        tableName: 'biz_dict_entries',
      });
      expect([...(physical?.indexes.map((index) => index.name) ?? [])].sort()).toEqual([
        'ix_biz_dict_type_status_sort',
        'pk_biz_dict_entries',
        'uq_biz_dict_type_code',
      ]);
      expect((await tableNames(connection)).sort()).toEqual(
        [...PREVIOUS_TABLES, 'biz_dict_entries'].sort(),
      );
      expect(
        await connection.repository<Record<string, unknown>>('bizDictEntries').count(),
      ).toBe(0);

      const values = {
        id: 'bd-1',
        dict_type: 'tax_rate',
        code: 'RATE-13',
        name: '测试税率',
        created_by_id: 'tester',
        created_at: '2026-11-27T01:00:00.000Z',
        updated_at: '2026-11-27T01:00:00.000Z',
      };
      await connection.query.insertInto('biz_dict_entries').values(values).execute();
      const stored = await connection.query
        .selectFrom('biz_dict_entries')
        .selectAll()
        .where('id', '=', 'bd-1')
        .executeTakeFirstOrThrow();
      expect(stored.isDefault).toBe(false);
      expect(Number(stored.sort)).toBe(0);
      expect(stored.status).toBe('active');
      expect(stored.rate).toBeNull();
      expect(stored.startDate).toBeNull();

      // 直接插两条同 (dictType, code) 的行：第二条必须被数据库拒绝。
      await expect(
        connection.query
          .insertInto('biz_dict_entries')
          .values({ ...values, id: 'bd-2' })
          .execute(),
      ).rejects.toThrow();
    },
    down: async ({ expectCollection }) => {
      await expectCollection('bizDictEntries').not.toExist();
    },
  });
});
