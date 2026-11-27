// @vitest-environment node
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { describeMigration } from '@nocobase/app-testing/server';
import type { Knex } from 'knex';
import { describe, expect } from 'vitest';

/**
 * R-021 加片「单据附件」：docFiles 的九列、主键与两个索引逐项钉在物理结构上，
 * down 必须把表删干净。
 */
const sources = [
  {
    packageName: 'doc-files-migration-test',
    directory: path.resolve(import.meta.dirname, '../../database/main/migrations'),
  },
];

const FIELDS = [
  'id', 'ownerType', 'ownerId', 'name', 'contentType', 'size',
  'storageKey', 'createdById', 'createdAt',
].sort();

describe('R-021：单据附件表迁移', () => {
  describeMigration('202611260020_doc_files', {
    sources,
    up: async ({ connection, expectCollection }) => {
      const collection = await expectCollection('docFiles').toExist();
      expect(Object.keys(collection.fields).sort()).toEqual(FIELDS);
      expect(collection.primaryKey).toEqual(['id']);
      expect(collection.foreignKeys).toHaveLength(0);
      await expectCollection('docFiles').toHaveField('ownerId', {
        type: 'string', length: 64, nullable: true,
      });
      await expectCollection('docFiles').toHaveField('size', {
        type: 'integer', nullable: false,
      });
      const knex = await connection.client<Knex>();
      const types = await knex.raw<{ rows?: { column_name: string; data_type: string }[] }>(
        `select column_name, data_type from information_schema.columns
          where table_schema = current_schema() and table_name = 'doc_files'`,
      );
      const byName = new Map((types.rows ?? []).map((row) => [row.column_name, row.data_type]));
      expect(byName.get('storage_key')).toBe('character varying');
      expect(byName.get('content_type')).toBe('character varying');
      expect(byName.get('created_at')).toBe('timestamp with time zone');

      const physical = await connection.schemaInspector.getPhysicalCollection({
        tableName: 'doc_files',
      });
      expect([...(physical?.indexes.map((index) => index.name) ?? [])].sort()).toEqual([
        'ix_doc_files_owner',
        'ix_doc_files_owner_created',
        'pk_doc_files',
      ]);

      const id = `df-${randomUUID()}`;
      await connection.query.insertInto('doc_files').values({
        id,
        owner_type: 'purchase_order',
        name: '测试.pdf',
        content_type: 'application/pdf',
        size: 3,
        storage_key: `doc-files/${id}.pdf`,
        created_by_id: 'tester',
        created_at: new Date(),
      }).execute();
      const row = await connection.query.selectFrom('doc_files').selectAll()
        .where('id', '=', id).executeTakeFirstOrThrow();
      expect(row.ownerId).toBeNull();
    },
    down: async ({ expectCollection }) => {
      await expectCollection('docFiles').not.toExist();
    },
  });
});
