import path from 'node:path';
import { describeMigration } from '@nocobase/app-testing/server';
import { describe, expect } from 'vitest';

/**
 * R-025 S1 验收 1–3、7：班次表由迁移 202611260007 一张表建出，字段逐项钉在物理结构上。
 *
 * 起止与休息段是整数分钟数，不是 time/date/datetime；createdAt/updatedAt 带时区，
 * 照 R-017 的 datetimeTz。默认值靠真插一行读回来钉住（expectCollection 不读默认值）。
 * 编码的主键唯一约束直接拿两条同编码的行试，第二条必须被数据库拒绝；seed 没有班次，
 * 这里再确认一次空表（迁移只建表、不预置数据）。
 */
const sources = [
  {
    packageName: 'shifts-migration-test',
    directory: path.resolve(
      import.meta.dirname,
      '../../database/main/migrations',
    ),
  },
];

const SHIFT_FIELDS = [
  'active',
  'breakEndMinute',
  'breakStartMinute',
  'createdAt',
  'endMinute',
  'id',
  'sortOrder',
  'startMinute',
  'title',
  'updatedAt',
];

describe('R-025 S1：班次定义的迁移', () => {
  describeMigration('202611260007_create_shifts', {
    sources,
    up: async ({ connection, expectCollection }) => {
      const shifts = await expectCollection('shifts').toExist();
      expect(shifts.primaryKey).toEqual(['id']);
      expect(Object.keys(shifts.fields).sort()).toEqual(SHIFT_FIELDS);
      await expectCollection('shifts').toHaveField('id', {
        type: 'string',
        length: 32,
        nullable: false,
      });
      await expectCollection('shifts').toHaveField('title', {
        type: 'string',
        length: 64,
        nullable: false,
      });
      // 时间列是整数分钟数，不是框架的时间/日期类型。
      for (const field of [
        'startMinute',
        'endMinute',
        'breakStartMinute',
        'breakEndMinute',
      ] as const) {
        const expected = field.startsWith('break')
          ? { type: 'integer', nullable: true }
          : { type: 'integer', nullable: false };
        await expectCollection('shifts').toHaveField(field, expected);
      }
      await expectCollection('shifts').toHaveField('active', {
        type: 'boolean',
        nullable: false,
      });
      await expectCollection('shifts').toHaveField('sortOrder', {
        type: 'integer',
        nullable: false,
      });
      for (const field of ['createdAt', 'updatedAt'] as const) {
        await expectCollection('shifts').toHaveField(field, {
          type: 'datetimeTz',
          nullable: false,
        });
      }
      await expectCollection('shifts').toHaveIndex([
        'active',
        'sortOrder',
        'id',
      ]);
      expect(shifts.indexes).toHaveLength(1);
      expect(shifts.foreignKeys).toHaveLength(0);

      const physical = await connection.schemaInspector.getPhysicalCollection({
        tableName: 'shifts',
      });
      expect(
        [...(physical?.indexes.map((index) => index.name) ?? [])].sort(),
      ).toEqual(['ix_shifts_active_sort_id', 'pk_shifts']);

      // 这一条迁移只加这一张表：相对本分支的基线（截至 202611260006）没有别的新表。
      // __nocobase_* 是框架的迁移与元数据表，不算业务表。
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
      ];
      const tables: string[] = [];
      for await (const collection of connection.schemaInspector.scanPhysicalCollections({
        kinds: ['table'],
      })) {
        if (!collection.tableName.startsWith('__nocobase_')) {
          tables.push(collection.tableName);
        }
      }
      expect(tables.sort()).toEqual([...BASELINE_TABLES, 'shifts'].sort());

      // 默认值与空表都从真库读：active 真、sortOrder 0，休息段空，且没有任何预置班次。
      expect(
        await connection.repository<Record<string, unknown>>('shifts').count(),
      ).toBe(0);
      await connection.query
        .insertInto('shifts')
        .values({
          id: 'EARLY',
          title: '早班',
          startMinute: 480,
          endMinute: 1020,
          createdAt: '2026-11-27T01:00:00.000Z',
          updatedAt: '2026-11-27T01:00:00.000Z',
        })
        .execute();
      const row = await connection.query
        .selectFrom('shifts')
        .selectAll()
        .where('id', '=', 'EARLY')
        .executeTakeFirstOrThrow();
      expect(row.active).toBe(true);
      expect(Number(row.sortOrder)).toBe(0);
      expect(row.breakStartMinute).toBeNull();
      expect(row.breakEndMinute).toBeNull();

      // 编码全表唯一：第二条同编码的行被数据库拒绝，表里还是只有一行。
      await expect(
        connection.query
          .insertInto('shifts')
          .values({
            id: 'EARLY',
            title: '另一个早班',
            startMinute: 540,
            endMinute: 1080,
            createdAt: '2026-11-27T02:00:00.000Z',
            updatedAt: '2026-11-27T02:00:00.000Z',
          })
          .execute(),
      ).rejects.toThrow();
      expect(
        await connection.repository<Record<string, unknown>>('shifts').count(),
      ).toBe(1);
    },
    down: async ({ expectCollection }) => {
      await expectCollection('shifts').not.toExist();
    },
  });
});
