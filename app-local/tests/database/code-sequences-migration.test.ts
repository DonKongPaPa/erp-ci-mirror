import path from 'node:path';
import { describeMigration } from '@nocobase/app-testing/server';
import { describe, expect } from 'vitest';

/**
 * R-016 MVP 验收 1：发号计数器表由迁移 202611260008 一张表建出，字段逐项钉在物理结构上。
 *
 * period 不长不短：按日重置存 8 位 yyyymmdd，不带日期存空串，列宽 8 正好。
 * lastNo 默认 0 靠真插一行读回来钉住（expectCollection 不读默认值）。
 * 主键 (prefix, period) 同时是并发唯一约束：直接插两条同键的行，第二条必须被数据库拒绝。
 */
const sources = [
  {
    packageName: 'code-sequences-migration-test',
    directory: path.resolve(
      import.meta.dirname,
      '../../database/main/migrations',
    ),
  },
];

const CODE_SEQUENCE_FIELDS = ['lastNo', 'period', 'prefix'];

// 截至 202611260007 的业务表；本条迁移只再加 code_sequences 一张。
const BASELINE_TABLES = [
  'approval_records',
  'approval_rounds',
  'approvals',
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
  'positions',
  'shifts',
];

describe('R-016 MVP：发号计数器表的迁移', () => {
  describeMigration('202611260008_create_code_sequences', {
    sources,
    up: async ({ connection, expectCollection }) => {
      const sequences = await expectCollection('codeSequences').toExist();
      expect(sequences.primaryKey).toEqual(['prefix', 'period']);
      expect(Object.keys(sequences.fields).sort()).toEqual(CODE_SEQUENCE_FIELDS);
      await expectCollection('codeSequences').toHaveField('prefix', {
        type: 'string',
        length: 16,
        nullable: false,
      });
      await expectCollection('codeSequences').toHaveField('period', {
        type: 'string',
        length: 8,
        nullable: false,
      });
      await expectCollection('codeSequences').toHaveField('lastNo', {
        type: 'integer',
        nullable: false,
      });
      expect(sequences.indexes).toHaveLength(0);
      expect(sequences.foreignKeys).toHaveLength(0);

      const physical = await connection.schemaInspector.getPhysicalCollection({
        tableName: 'code_sequences',
      });
      expect(
        [...(physical?.indexes.map((index) => index.name) ?? [])].sort(),
      ).toEqual(['pk_code_sequences']);

      const tables: string[] = [];
      for await (const collection of connection.schemaInspector.scanPhysicalCollections({
        kinds: ['table'],
      })) {
        if (!collection.tableName.startsWith('__nocobase_')) {
          tables.push(collection.tableName);
        }
      }
      expect(tables.sort()).toEqual([...BASELINE_TABLES, 'code_sequences'].sort());

      // 默认 0、空表：从真库读回来。不重置的规则 period 存空串。
      expect(
        await connection.repository<Record<string, unknown>>('codeSequences').count(),
      ).toBe(0);
      await connection.query
        .insertInto('codeSequences')
        .values({ prefix: 'CU', period: '' })
        .execute();
      const row = await connection.query
        .selectFrom('codeSequences')
        .selectAll()
        .where('prefix', '=', 'CU')
        .executeTakeFirstOrThrow();
      expect(Number(row.lastNo)).toBe(0);
      expect(row.period).toBe('');

      // (prefix, period) 主键：第二条同键的行被数据库拒绝，表里还是一行。
      await expect(
        connection.query
          .insertInto('codeSequences')
          .values({ prefix: 'CU', period: '', lastNo: 5 })
          .execute(),
      ).rejects.toThrow();
      expect(
        await connection.repository<Record<string, unknown>>('codeSequences').count(),
      ).toBe(1);

      // 不同 period 同前缀可以并存：按日重置的各天是不同行。
      await connection.query
        .insertInto('codeSequences')
        .values({ prefix: 'CU', period: '20261127', lastNo: 3 })
        .execute();
      expect(
        await connection.repository<Record<string, unknown>>('codeSequences').count(),
      ).toBe(2);
    },
    down: async ({ expectCollection }) => {
      await expectCollection('codeSequences').not.toExist();
    },
  });
});
