// @vitest-environment node
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { describeMigration } from '@nocobase/app-testing/server';
import { describe, expect } from 'vitest';

/** R-076：只加三列、不回填；down 删干净。字段清单在加片之后逐项钉住。 */
const sources = [
  {
    packageName: 'doc-print-migration-test',
    directory: path.resolve(import.meta.dirname, '../../database/main/migrations'),
  },
];

const BASE_DOC_FIELDS = [
  'createdAt', 'createdById', 'docNo', 'docType', 'id', 'postedAt',
  'postedById', 'reason', 'remark', 'sourceId', 'sourceType', 'status',
  'updatedAt',
];
const EXT_FIELDS = [
  'docDate', 'partnerId', 'contactName', 'contactPhone', 'deliveryAddress',
  'customerOrderNo', 'projectCode', 'handlerUserId', 'takerDepartmentId',
  'takerUserId', 'discountAmount', 'totalQty', 'taxIncludedTotal',
  'taxExcludedTotal', 'taxTotal', 'payableTotal',
];
const PRINT_FIELDS = ['printCount', 'lastPrintedAt', 'lastPrintedBy'];
const EXPECTED = [...BASE_DOC_FIELDS, ...EXT_FIELDS, ...PRINT_FIELDS].sort();
const BEFORE = [...BASE_DOC_FIELDS, ...EXT_FIELDS].sort();

describe('R-076：单据打印痕迹的迁移', () => {
  describeMigration('202611260027_doc_print_trace', {
    sources,
    up: async ({ connection, expectCollection }) => {
      const docs = await expectCollection('stockDocs').toExist();
      expect(Object.keys(docs.fields).sort(), '三列全部加上，既有列不变').toEqual(EXPECTED);
      // 只加列、不回填：打印次数默认 0，两个痕迹列为空。
      const id = `sd-print-${randomUUID()}`;
      await connection.query
        .insertInto('stock_docs')
        .values({
          id,
          doc_no: `RK-PRINT-${randomUUID().slice(0, 6)}`,
          doc_type: 'in',
          reason: 'purchase_receipt',
          created_by_id: 'tester',
          created_at: '2026-11-27T01:00:00.000Z',
          updated_at: '2026-11-27T01:00:00.000Z',
        })
        .execute();
      const row = await connection.query
        .selectFrom('stock_docs')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirstOrThrow();
      expect(Number(row.printCount)).toBe(0);
      expect(row.lastPrintedAt).toBeNull();
      expect(row.lastPrintedBy).toBeNull();
    },
    down: async ({ expectCollection }) => {
      const docs = await expectCollection('stockDocs').toExist();
      expect(Object.keys(docs.fields).sort(), 'down 把三列删干净').toEqual(BEFORE);
    },
  });
});
