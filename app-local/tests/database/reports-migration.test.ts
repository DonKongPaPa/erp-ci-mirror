// @vitest-environment node
import path from 'node:path';
import { describeMigration } from '@nocobase/app-testing/server';
import { describe, expect } from 'vitest';

/**
 * R-078 验收 1：三张报表的列、主键、唯一约束与索引逐项钉在真 Postgres 的物理结构上；
 * down 删三表；不建外键与 CHECK。
 */
const sources = [
  {
    packageName: 'reports-migration-test',
    directory: path.resolve(import.meta.dirname, '../../database/main/migrations'),
  },
];

const DEFINITION_FIELDS = [
  'baseActions', 'category', 'columns', 'createdAt', 'dimensions', 'id',
  'key', 'measures', 'source', 'status', 'titleKey', 'updatedAt',
];
const FAVORITE_FIELDS = ['createdAt', 'id', 'reportKey', 'userId'];
const TRACE_FIELDS = ['at', 'filtersHash', 'format', 'id', 'reportKey', 'rowCount', 'userId'];

describe('R-078：报表中心底座的迁移', () => {
  describeMigration('202611260032_reports', {
    sources,
    up: async ({ connection, expectCollection }) => {
      const definitions = await expectCollection('reportDefinitions').toExist();
      expect(definitions.primaryKey).toEqual(['id']);
      expect(Object.keys(definitions.fields).sort()).toEqual(DEFINITION_FIELDS);
      for (const field of ['id', 'key', 'titleKey', 'category', 'source', 'status'] as const) {
        expect(definitions.fields[field]?.nullable, `${field} 不可空`).toBe(false);
      }
      for (const field of ['dimensions', 'measures', 'columns', 'baseActions'] as const) {
        expect(definitions.fields[field]?.type, `${field} 是 JSON 文本`).toBe('text');
        expect(definitions.fields[field]?.nullable, `${field} 不可空`).toBe(false);
      }
      await expectCollection('reportDefinitions').toHaveIndex(['key'], { unique: true });
      expect(definitions.foreignKeys).toHaveLength(0);

      const favorites = await expectCollection('reportFavorites').toExist();
      expect(favorites.primaryKey).toEqual(['id']);
      expect(Object.keys(favorites.fields).sort()).toEqual(FAVORITE_FIELDS);
      await expectCollection('reportFavorites').toHaveIndex(['userId', 'reportKey'], { unique: true });
      expect(favorites.foreignKeys).toHaveLength(0);

      const traces = await expectCollection('reportExportTraces').toExist();
      expect(traces.primaryKey).toEqual(['id']);
      expect(Object.keys(traces.fields).sort()).toEqual(TRACE_FIELDS);
      for (const field of ['id', 'userId', 'reportKey', 'at', 'format', 'filtersHash'] as const) {
        expect(traces.fields[field]?.nullable, `${field} 不可空`).toBe(false);
      }
      await expectCollection('reportExportTraces').toHaveIndex(['userId', 'at']);
      await expectCollection('reportExportTraces').toHaveIndex(['reportKey', 'at']);
      expect(traces.foreignKeys).toHaveLength(0);

      // 默认值与唯一约束靠真插一行读回来钉住。
      const now = new Date();
      await connection.query.insertInto('reportDefinitions').values({
        id: 'DEF-MIG-1', key: 'migration_probe', titleKey: 'reporting.titles.migration_probe',
        category: 'finance', dimensions: '[]', measures: '[]', columns: '[]',
        baseActions: '[]', source: 'financeRecords', createdAt: now, updatedAt: now,
      }).execute();
      const saved = await connection.query.selectFrom('reportDefinitions')
        .selectAll().where('id', '=', 'DEF-MIG-1').executeTakeFirstOrThrow();
      expect(saved.status).toBe('active');
      await expect(connection.query.insertInto('reportDefinitions').values({
        id: 'DEF-MIG-2', key: 'migration_probe', titleKey: 'reporting.titles.migration_probe',
        category: 'finance', dimensions: '[]', measures: '[]', columns: '[]',
        baseActions: '[]', source: 'financeRecords', createdAt: now, updatedAt: now,
      }).execute()).rejects.toThrow();

      await connection.query.insertInto('reportFavorites').values({
        id: 'FAV-MIG-1', userId: 'user-mig-1', reportKey: 'migration_probe', createdAt: now,
      }).execute();
      await expect(connection.query.insertInto('reportFavorites').values({
        id: 'FAV-MIG-2', userId: 'user-mig-1', reportKey: 'migration_probe', createdAt: now,
      }).execute()).rejects.toThrow();

      await connection.query.insertInto('reportExportTraces').values({
        id: 'TRACE-MIG-1', userId: 'user-mig-1', reportKey: 'migration_probe',
        at: now, format: 'csv', filtersHash: 'a'.repeat(64), rowCount: 3,
      }).execute();
      const trace = await connection.query.selectFrom('reportExportTraces')
        .selectAll().where('id', '=', 'TRACE-MIG-1').executeTakeFirstOrThrow();
      expect(trace.rowCount).toBe(3);
      expect(trace.format).toBe('csv');
    },
    down: async ({ expectCollection }) => {
      await expectCollection('reportExportTraces').not.toExist();
      await expectCollection('reportFavorites').not.toExist();
      await expectCollection('reportDefinitions').not.toExist();
    },
  });
});
