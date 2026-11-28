// @vitest-environment node
import path from 'node:path';
import { describeMigration } from '@nocobase/app-testing/server';
import { describe, expect } from 'vitest';

/**
 * R-019 波 2 验收 1：两张 BOM 表的列、主键、唯一约束、部分唯一索引与普通索引
 * 逐项钉在真 Postgres 的物理结构上；不给 items 加列；down 把两张表删干净。
 */
const sources = [
  {
    packageName: 'boms-migration-test',
    directory: path.resolve(
      import.meta.dirname,
      '../../database/main/migrations',
    ),
  },
];

const BOM_FIELDS = [
  'createdAt',
  'createdById',
  'dailyOutput',
  'docNo',
  'effectiveFrom',
  'effectiveTo',
  'id',
  'isDefault',
  'productId',
  'remark',
  'status',
  'updatedAt',
  'version',
];

const LINE_FIELDS = [
  'bomId',
  'childBomId',
  'id',
  'itemId',
  'lineNo',
  'lossRate',
  'note',
  'qty',
];

describe('R-019 波 2：BOM 的迁移', () => {
  describeMigration('202611260031_create_boms', {
    sources,
    up: async ({ connection, expectCollection }) => {
      const boms = await expectCollection('boms').toExist();
      expect(boms.primaryKey).toEqual(['id']);
      expect(Object.keys(boms.fields).sort()).toEqual(BOM_FIELDS);
      for (const [field, length] of [
        ['id', 64],
        ['docNo', 32],
        ['version', 16],
        ['productId', 64],
        ['status', 16],
        ['createdById', 64],
        ['remark', 1000],
      ] as const) {
        await expectCollection('boms').toHaveField(field, {
          type: 'string',
          length,
          nullable: false,
        });
      }
      await expectCollection('boms').toHaveField('isDefault', {
        type: 'boolean',
        nullable: false,
      });
      for (const field of ['effectiveFrom', 'effectiveTo'] as const) {
        await expectCollection('boms').toHaveField(field, {
          type: 'date',
          nullable: field === 'effectiveTo',
        });
      }
      await expectCollection('boms').toHaveField('dailyOutput', {
        type: 'decimal',
        nullable: true,
      });
      for (const field of ['createdAt', 'updatedAt'] as const) {
        await expectCollection('boms').toHaveField(field, {
          type: 'datetimeTz',
          nullable: false,
        });
      }
      await expectCollection('boms').toHaveIndex(['docNo'], { unique: true });
      await expectCollection('boms').toHaveIndex(['docNo', 'version'], { unique: true });
      await expectCollection('boms').toHaveIndex(['productId', 'effectiveFrom']);
      await expectCollection('boms').toHaveIndex(['productId'], {
        name: 'uq_boms_default',
        unique: true,
      });
      expect(boms.foreignKeys).toHaveLength(0);

      // 部分唯一必须真的带 WHERE，不能退化成「一个成品只能一条 BOM」。
      const knex = await connection.client<{
        raw(sql: string, bindings?: unknown[]): Promise<unknown>;
      }>();
      const raw = await knex.raw(
        `select indexdef from pg_indexes where schemaname = current_schema() and indexname = 'uq_boms_default'`,
      );
      const rows = (raw.rows ?? raw) as { indexdef?: string }[];
      expect(rows).toHaveLength(1);
      expect(rows[0]?.indexdef ?? '').toContain('WHERE');
      expect(rows[0]?.indexdef ?? '').toContain('is_default');
      expect(rows[0]?.indexdef ?? '').toContain('status');

      // 默认值靠真插一行读回来钉住。
      const now = new Date();
      await connection.query
        .insertInto('boms')
        .values({
          id: 'BOM-MIG-1',
          docNo: 'BOM-20261128-0001',
          version: 'A',
          productId: 'PROD-MIG-1',
          effectiveFrom: '2026-01-01',
          createdById: 'root',
          createdAt: now,
          updatedAt: now,
        })
        .execute();
      const saved = await connection.query
        .selectFrom('boms')
        .selectAll()
        .where('id', '=', 'BOM-MIG-1')
        .executeTakeFirstOrThrow();
      expect(saved.isDefault).toBe(false);
      expect(saved.status).toBe('active');
      expect(saved.remark).toBe('');
      expect(saved.effectiveTo).toBeNull();
      expect(saved.dailyOutput).toBeNull();

      const lines = await expectCollection('bomLines').toExist();
      expect(lines.primaryKey).toEqual(['id']);
      expect(Object.keys(lines.fields).sort()).toEqual(LINE_FIELDS);
      await expectCollection('bomLines').toHaveField('bomId', {
        type: 'string',
        length: 64,
        nullable: false,
      });
      await expectCollection('bomLines').toHaveField('itemId', {
        type: 'string',
        length: 64,
        nullable: false,
      });
      await expectCollection('bomLines').toHaveField('childBomId', {
        type: 'string',
        length: 64,
        nullable: true,
      });
      await expectCollection('bomLines').toHaveField('lineNo', {
        type: 'integer',
        nullable: false,
      });
      await expectCollection('bomLines').toHaveField('qty', {
        type: 'decimal',
        nullable: false,
      });
      const loss = lines.fields['lossRate'];
      expect(loss?.type).toBe('decimal');
      expect(loss?.nullable).toBe(false);
      await expectCollection('bomLines').toHaveField('note', {
        type: 'string',
        length: 500,
        nullable: true,
      });
      await expectCollection('bomLines').toHaveIndex(['bomId']);
      expect(lines.foreignKeys).toHaveLength(0);

      await connection.query
        .insertInto('bomLines')
        .values({
          id: 'LINE-MIG-1',
          bomId: 'BOM-MIG-1',
          lineNo: 1,
          itemId: 'ITEM-MIG-1',
          qty: 2,
        })
        .execute();
      const line = await connection.query
        .selectFrom('bomLines')
        .selectAll()
        .where('id', '=', 'LINE-MIG-1')
        .executeTakeFirstOrThrow();
      expect(Number(line.lossRate)).toBe(0);
      expect(line.childBomId).toBeNull();
      expect(line.note).toBeNull();

      // 一个成品只能有一条在用默认 BOM；非默认的多版本可以并存。
      await expect(
        connection.query
          .insertInto('boms')
          .values({
            id: 'BOM-MIG-2',
            docNo: 'BOM-20261128-0002',
            version: 'B',
            productId: 'PROD-MIG-1',
            effectiveFrom: '2026-06-01',
            isDefault: true,
            createdById: 'root',
            createdAt: now,
            updatedAt: now,
          })
          .execute(),
      ).resolves.toBeDefined();
      await expect(
        connection.query
          .updateTable('boms')
          .set({ isDefault: true })
          .where('id', '=', 'BOM-MIG-1')
          .execute(),
      ).rejects.toThrow();
      // 停用后默认位不再占唯一索引，另一条可以顶上。
      await connection.query
        .updateTable('boms')
        .set({ status: 'inactive' })
        .where('id', '=', 'BOM-MIG-2')
        .execute();

      // 同一 docNo 下版本唯一，由数据库兜底。
      await expect(
        connection.query
          .insertInto('boms')
          .values({
            id: 'BOM-MIG-3',
            docNo: 'BOM-20261128-0001',
            version: 'A',
            productId: 'PROD-MIG-2',
            effectiveFrom: '2026-01-01',
            createdById: 'root',
            createdAt: now,
            updatedAt: now,
          })
          .execute(),
      ).rejects.toThrow();

      // 本片不碰物料主档：items 的列还是波 0 加片之后的那一组。
      const items = await expectCollection('items').toExist();
      for (const field of ['bomId', 'version', 'effectiveFrom', 'isDefault']) {
        expect(Object.keys(items.fields), `items 不该新增 ${field}`).not.toContain(field);
      }
    },
    down: async ({ expectCollection }) => {
      await expectCollection('bomLines').not.toExist();
      await expectCollection('boms').not.toExist();
    },
  });
});
