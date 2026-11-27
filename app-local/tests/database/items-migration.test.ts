// @vitest-environment node
import path from 'node:path';
import { describeMigration } from '@nocobase/app-testing/server';
import { describe, expect } from 'vitest';

/**
 * R-019 MVP 验收 1：三张表的列、类型、长度、可空、唯一约束与索引逐项钉在物理结构上。
 *
 * 默认值靠真插一行读回来钉住（expectCollection 不读默认值）；编码与分类编码的
 * 全表唯一直接拿同码的第二条行试，第二条必须被数据库拒绝。迁移只建表、不预置数据。
 * 发号器底座的表叫 code_sequences（迁移 202611260008）。
 */
const sources = [
  {
    packageName: 'items-migration-test',
    directory: path.resolve(
      import.meta.dirname,
      '../../database/main/migrations',
    ),
  },
];

const UNIT_FIELDS = [
  'code',
  'createdAt',
  'decimals',
  'name',
  'status',
  'updatedAt',
];
const CATEGORY_FIELDS = [
  'code',
  'createdAt',
  'id',
  'name',
  'parentId',
  'status',
  'updatedAt',
];
const ITEM_FIELDS = [
  'categoryCode',
  'code',
  'createdAt',
  'createdById',
  'id',
  'itemType',
  'legacyCode',
  'name',
  'note',
  'spec',
  'status',
  'unitCode',
  'updatedAt',
];

/** 本条迁移之前的全部业务表（含发号器底座的 code_counters）；__nocobase_* 不算。 */
const BASELINE_TABLES = [
  'approval_records',
  'approval_rounds',
  'approvals',
  'code_sequences',
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

describe('R-019 MVP：物料主数据的迁移', () => {
  describeMigration('202611260010_create_items', {
    sources,
    up: async ({ connection, expectCollection }) => {
      const units = await expectCollection('units').toExist();
      expect(units.primaryKey).toEqual(['code']);
      expect(Object.keys(units.fields).sort()).toEqual(UNIT_FIELDS);
      await expectCollection('units').toHaveField('code', {
        type: 'string',
        length: 16,
        nullable: false,
      });
      await expectCollection('units').toHaveField('name', {
        type: 'string',
        length: 64,
        nullable: false,
      });
      await expectCollection('units').toHaveField('decimals', {
        type: 'integer',
        nullable: false,
      });
      await expectCollection('units').toHaveField('status', {
        type: 'string',
        length: 16,
        nullable: false,
      });
      for (const field of ['createdAt', 'updatedAt'] as const) {
        await expectCollection('units').toHaveField(field, {
          type: 'datetimeTz',
          nullable: false,
        });
      }
      expect(units.indexes).toHaveLength(0);

      const categories = await expectCollection('itemCategories').toExist();
      expect(categories.primaryKey).toEqual(['id']);
      expect(Object.keys(categories.fields).sort()).toEqual(CATEGORY_FIELDS);
      await expectCollection('itemCategories').toHaveField('id', {
        type: 'string',
        length: 64,
        nullable: false,
      });
      await expectCollection('itemCategories').toHaveField('code', {
        type: 'string',
        length: 32,
        nullable: false,
      });
      await expectCollection('itemCategories').toHaveField('name', {
        type: 'string',
        length: 64,
        nullable: false,
      });
      await expectCollection('itemCategories').toHaveField('parentId', {
        type: 'string',
        length: 64,
        nullable: true,
      });
      await expectCollection('itemCategories').toHaveField('status', {
        type: 'string',
        length: 16,
        nullable: false,
      });
      for (const field of ['createdAt', 'updatedAt'] as const) {
        await expectCollection('itemCategories').toHaveField(field, {
          type: 'datetimeTz',
          nullable: false,
        });
      }
      await expectCollection('itemCategories').toHaveIndex(['code'], {
        unique: true,
      });
      await expectCollection('itemCategories').toHaveIndex(['parentId']);
      expect(categories.indexes).toHaveLength(2);
      expect(categories.foreignKeys).toHaveLength(0);

      const items = await expectCollection('items').toExist();
      expect(items.primaryKey).toEqual(['id']);
      expect(Object.keys(items.fields).sort()).toEqual(ITEM_FIELDS);
      for (const [field, length] of [
        ['id', 64],
        ['code', 64],
        ['name', 128],
        ['itemType', 16],
        ['unitCode', 16],
        ['status', 16],
        ['createdById', 64],
      ] as const) {
        await expectCollection('items').toHaveField(field, {
          type: 'string',
          length,
          nullable: false,
        });
      }
      for (const [field, length] of [
        ['spec', 128],
        ['categoryCode', 32],
        ['legacyCode', 64],
      ] as const) {
        await expectCollection('items').toHaveField(field, {
          type: 'string',
          length,
          nullable: true,
        });
      }
      await expectCollection('items').toHaveField('note', {
        type: 'text',
        nullable: true,
      });
      for (const field of ['createdAt', 'updatedAt'] as const) {
        await expectCollection('items').toHaveField(field, {
          type: 'datetimeTz',
          nullable: false,
        });
      }
      await expectCollection('items').toHaveIndex(['code'], { unique: true });
      await expectCollection('items').toHaveIndex([
        'itemType',
        'status',
        'code',
      ]);
      await expectCollection('items').toHaveIndex(['categoryCode']);
      expect(items.indexes).toHaveLength(3);
      expect(items.foreignKeys).toHaveLength(0);

      // 物理索引名也钉住：改名对 expectCollection 不可见。
      const physicalNames = async (tableName: string) => {
        const physical = await connection.schemaInspector.getPhysicalCollection({
          tableName,
        });
        return [...(physical?.indexes.map((index) => index.name) ?? [])].sort();
      };
      expect(await physicalNames('units')).toEqual(['pk_units']);
      expect(await physicalNames('item_categories')).toEqual([
        'ix_item_categories_parent',
        'pk_item_categories',
        'uq_item_categories_code',
      ]);
      expect(await physicalNames('items')).toEqual([
        'ix_items_category',
        'ix_items_type_status_code',
        'pk_items',
        'uq_items_code',
      ]);

      // 这一条迁移只加这三张表。
      const tables: string[] = [];
      for await (const collection of connection.schemaInspector.scanPhysicalCollections({
        kinds: ['table'],
      })) {
        if (!collection.tableName.startsWith('__nocobase_')) {
          tables.push(collection.tableName);
        }
      }
      expect(tables.sort()).toEqual(
        [...BASELINE_TABLES, 'item_categories', 'items', 'units'].sort(),
      );

      // 默认值、空表与唯一约束都从真库读。
      for (const table of ['units', 'itemCategories', 'items'] as const) {
        expect(
          await connection.repository<Record<string, unknown>>(table).count(),
        ).toBe(0);
      }
      const now = '2026-11-27T01:00:00.000Z';
      await connection.query
        .insertInto('units')
        .values({ code: 'PCS', name: 'Piece', createdAt: now, updatedAt: now })
        .execute();
      const unit = await connection.query
        .selectFrom('units')
        .selectAll()
        .where('code', '=', 'PCS')
        .executeTakeFirstOrThrow();
      expect(Number(unit.decimals)).toBe(0);
      expect(unit.status).toBe('active');
      await expect(
        connection.query
          .insertInto('units')
          .values({ code: 'PCS', name: 'Duplicate', createdAt: now, updatedAt: now })
          .execute(),
      ).rejects.toThrow();

      await connection.query
        .insertInto('item_categories')
        .values({ id: 'CAT1', code: 'CAT001', name: 'Raw', createdAt: now, updatedAt: now })
        .execute();
      const category = await connection.query
        .selectFrom('item_categories')
        .selectAll()
        .where('id', '=', 'CAT1')
        .executeTakeFirstOrThrow();
      expect(category.parentId).toBeNull();
      expect(category.status).toBe('active');
      await expect(
        connection.query
          .insertInto('item_categories')
          .values({ id: 'CAT2', code: 'CAT001', name: 'Dup', createdAt: now, updatedAt: now })
          .execute(),
      ).rejects.toThrow();

      await connection.query
        .insertInto('items')
        .values({
          id: 'ITEM1',
          code: 'M2611270001',
          name: 'Steel',
          itemType: 'material',
          unitCode: 'PCS',
          createdById: 'root',
          createdAt: now,
          updatedAt: now,
        })
        .execute();
      const item = await connection.query
        .selectFrom('items')
        .selectAll()
        .where('id', '=', 'ITEM1')
        .executeTakeFirstOrThrow();
      expect(item.status).toBe('active');
      expect(item.spec).toBeNull();
      expect(item.note).toBeNull();
      await expect(
        connection.query
          .insertInto('items')
          .values({
            id: 'ITEM2',
            code: 'M2611270001',
            name: 'Dup',
            itemType: 'material',
            unitCode: 'PCS',
            createdById: 'root',
            createdAt: now,
            updatedAt: now,
          })
          .execute(),
      ).rejects.toThrow();
      expect(
        await connection.repository<Record<string, unknown>>('items').count(),
      ).toBe(1);
    },
    down: async ({ expectCollection }) => {
      await expectCollection('items').not.toExist();
      await expectCollection('itemCategories').not.toExist();
      await expectCollection('units').not.toExist();
    },
  });
});
