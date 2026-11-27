// @vitest-environment node
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { describeMigration } from '@nocobase/app-testing/server';
import type { Knex } from 'knex';
import { describe, expect } from 'vitest';

/** expectCollection 只看字段类型，精度要从真库的信息模式读回来钉住。 */
async function expectDecimal(
  connection: { client<T>(): Promise<T> },
  table: string,
  column: string,
  precision = 18,
  scale = 4,
): Promise<void> {
  const knex = await connection.client<Knex>();
  const result = await knex.raw<{
    rows?: { numeric_precision: number; numeric_scale: number }[];
  }>(
    `select numeric_precision, numeric_scale from information_schema.columns
      where table_schema = current_schema() and table_name = ? and column_name = ?`,
    [table, column],
  );
  const row = result.rows?.[0];
  expect(
    {
      precision: Number(row?.numeric_precision),
      scale: Number(row?.numeric_scale),
    },
    `${table}.${column} 必须是 decimal(${precision},${scale})`,
  ).toEqual({ precision, scale });
}

/**
 * R-020：迁移 202611260011 一次建五张表。字段、主键、索引、唯一约束逐项钉在物理结构上；
 * 数量列是 decimal(18,4)，时间戳列带时区（datetimeTz）。down 必须把五张表都删掉。
 */
const sources = [
  {
    packageName: 'inventory-migration-test',
    directory: path.resolve(
      import.meta.dirname,
      '../../database/main/migrations',
    ),
  },
];

/** 截至 202611260010（发号器 + 物料）的业务表；本条迁移只再加下面五张。 */
const BASELINE_TABLES = [
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
  'shifts',
  'units',
];

const WAREHOUSE_FIELDS = [
  'code',
  'createdAt',
  'id',
  'name',
  'note',
  'status',
  'updatedAt',
];
const DOC_FIELDS = [
  'createdAt',
  'createdById',
  'docNo',
  'docType',
  'id',
  'postedAt',
  'postedById',
  'reason',
  'remark',
  'sourceId',
  'sourceType',
  'status',
  'updatedAt',
];
const LINE_FIELDS = [
  'batchNo',
  'docId',
  'id',
  'itemId',
  'qty',
  'warehouseId',
];
const BALANCE_FIELDS = ['batchNo', 'itemId', 'qty', 'warehouseId'];
const TRANSACTION_FIELDS = [
  'at',
  'balanceAfter',
  'batchNo',
  'byUserId',
  'docId',
  'docLineId',
  'docNo',
  'id',
  'itemId',
  'qtyDelta',
  'warehouseId',
];

describe('R-020：仓库与库存的迁移', () => {
  describeMigration('202611260011_create_inventory', {
    sources,
    up: async ({ connection, expectCollection }) => {
      const warehouses = await expectCollection('warehouses').toExist();
      expect(Object.keys(warehouses.fields).sort()).toEqual(WAREHOUSE_FIELDS);
      expect(warehouses.primaryKey).toEqual(['id']);
      expect(warehouses.foreignKeys).toHaveLength(0);
      await expectCollection('warehouses').toHaveField('code', {
        type: 'string',
        length: 32,
        nullable: false,
      });
      await expectCollection('warehouses').toHaveField('name', {
        type: 'string',
        length: 128,
        nullable: false,
      });
      await expectCollection('warehouses').toHaveField('status', {
        type: 'string',
        length: 16,
        nullable: false,
      });
      await expectCollection('warehouses').toHaveField('note', {
        type: 'string',
        length: 500,
        nullable: false,
      });

      const docs = await expectCollection('stockDocs').toExist();
      expect(Object.keys(docs.fields).sort()).toEqual(DOC_FIELDS);
      expect(docs.primaryKey).toEqual(['id']);
      expect(docs.foreignKeys).toHaveLength(0);
      await expectCollection('stockDocs').toHaveIndex(['docType', 'status', 'createdAt']);
      await expectCollection('stockDocs').toHaveIndex(['sourceType', 'sourceId']);

      const lines = await expectCollection('stockDocLines').toExist();
      expect(Object.keys(lines.fields).sort()).toEqual(LINE_FIELDS);
      expect(lines.primaryKey).toEqual(['id']);
      expect(lines.foreignKeys).toHaveLength(0);
      await expectCollection('stockDocLines').toHaveField('qty', {
        type: 'decimal',
        nullable: false,
      });
      await expectDecimal(connection, 'stock_doc_lines', 'qty');
      await expectCollection('stockDocLines').toHaveIndex(['docId']);

      const balances = await expectCollection('stockBalances').toExist();
      expect(Object.keys(balances.fields).sort()).toEqual(BALANCE_FIELDS);
      expect(balances.primaryKey).toEqual(['itemId', 'warehouseId', 'batchNo']);
      expect(balances.foreignKeys).toHaveLength(0);
      await expectCollection('stockBalances').toHaveField('qty', {
        type: 'decimal',
        nullable: false,
      });
      await expectDecimal(connection, 'stock_balances', 'qty');

      const transactions = await expectCollection('stockTransactions').toExist();
      expect(Object.keys(transactions.fields).sort()).toEqual(TRANSACTION_FIELDS);
      expect(transactions.primaryKey).toEqual(['id']);
      expect(transactions.foreignKeys).toHaveLength(0);
      for (const field of ['qty_delta', 'balance_after'] as const) {
        await expectCollection('stockTransactions').toHaveField(
          field === 'qty_delta' ? 'qtyDelta' : 'balanceAfter',
          { type: 'decimal', nullable: false },
        );
        await expectDecimal(connection, 'stock_transactions', field);
      }
      await expectCollection('stockTransactions').toHaveIndex([
        'itemId',
        'warehouseId',
        'at',
      ]);

      const physical = await connection.schemaInspector.getPhysicalCollection({
        tableName: 'stock_docs',
      });
      expect(
        [...(physical?.indexes.map((index) => index.name) ?? [])].sort(),
      ).toEqual([
        'ix_stock_docs_source',
        'ix_stock_docs_type_status_created',
        'pk_stock_docs',
        'uq_stock_docs_doc_no',
      ]);

      const tables: string[] = [];
      for await (const collection of connection.schemaInspector.scanPhysicalCollections({
        kinds: ['table'],
      })) {
        if (!collection.tableName.startsWith('__nocobase_')) {
          tables.push(collection.tableName);
        }
      }
      expect(tables.sort()).toEqual(
        [
          ...BASELINE_TABLES,
          'stock_balances',
          'stock_doc_lines',
          'stock_docs',
          'stock_transactions',
          'warehouses',
        ].sort(),
      );

      // 默认值、唯一约束与空表都从真库读。
      for (const name of [
        'warehouses',
        'stockDocs',
        'stockDocLines',
        'stockBalances',
        'stockTransactions',
      ]) {
        expect(
          await connection.repository<Record<string, unknown>>(name).count(),
          `${name} 不该预置数据`,
        ).toBe(0);
      }
      await connection.query
        .insertInto('warehouses')
        .values({
          id: 'wh-1',
          code: 'WH1',
          name: '一号仓',
          createdAt: '2026-11-27T01:00:00.000Z',
          updatedAt: '2026-11-27T01:00:00.000Z',
        })
        .execute();
      const stored = await connection.query
        .selectFrom('warehouses')
        .selectAll()
        .where('id', '=', 'wh-1')
        .executeTakeFirstOrThrow();
      expect(stored.status).toBe('active');
      expect(stored.note).toBe('');
      await expect(
        connection.query
          .insertInto('warehouses')
          .values({
            id: 'wh-2',
            code: 'WH1',
            name: '冒名仓',
            createdAt: '2026-11-27T01:00:00.000Z',
            updatedAt: '2026-11-27T01:00:00.000Z',
          })
          .execute(),
      ).rejects.toThrow();
      expect(
        await connection.repository<Record<string, unknown>>('warehouses').count(),
      ).toBe(1);
    },
    down: async ({ expectCollection }) => {
      await expectCollection('warehouses').not.toExist();
      await expectCollection('stockDocs').not.toExist();
      await expectCollection('stockDocLines').not.toExist();
      await expectCollection('stockBalances').not.toExist();
      await expectCollection('stockTransactions').not.toExist();
    },
  });
});


/** R-020 加片：头 16 列、行 9 列、三个索引逐项钉住；down 还原到加片前。 */
const EXT_DOC_FIELDS = [
  ...DOC_FIELDS,
  'docDate', 'partnerId', 'contactName', 'contactPhone', 'deliveryAddress',
  'customerOrderNo', 'projectCode', 'handlerUserId', 'takerDepartmentId',
  'takerUserId', 'discountAmount', 'totalQty', 'taxIncludedTotal',
  'taxExcludedTotal', 'taxTotal', 'payableTotal',
].sort();
const EXT_LINE_FIELDS = [
  ...LINE_FIELDS,
  'taxIncludedPrice', 'taxExcludedPrice', 'taxRate', 'taxExcludedAmount',
  'taxAmount', 'taxIncludedAmount', 'productionDate', 'expiryDate', 'note',
].sort();

describe('R-020 加片：出入库补字段的迁移', () => {
  describeMigration('202611260019_stock_docs_ext', {
    sources,
    up: async ({ connection, expectCollection }) => {
      const docs = await expectCollection('stockDocs').toExist();
      expect(Object.keys(docs.fields).sort()).toEqual(EXT_DOC_FIELDS);
      const lines = await expectCollection('stockDocLines').toExist();
      expect(Object.keys(lines.fields).sort()).toEqual(EXT_LINE_FIELDS);
      for (const [table, columns] of [
        ['stock_docs', [
          'discount_amount', 'total_qty', 'tax_included_total', 'tax_excluded_total',
          'tax_total', 'payable_total',
        ]],
        ['stock_doc_lines', [
          'tax_included_price', 'tax_excluded_price', 'tax_excluded_amount',
          'tax_amount', 'tax_included_amount',
        ]],
      ] as const) {
        for (const column of columns) await expectDecimal(connection, table, column);
      }
      await expectDecimal(connection, 'stock_doc_lines', 'tax_rate', 5, 2);
      await expectCollection('stockDocs').toHaveIndex(['docType', 'docDate']);
      await expectCollection('stockDocs').toHaveIndex(['partnerId']);
      await expectCollection('stockDocs').toHaveIndex(['projectCode']);
      const physical = await connection.schemaInspector.getPhysicalCollection({
        tableName: 'stock_docs',
      });
      expect([...(physical?.indexes.map((index) => index.name) ?? [])].sort()).toEqual(
        expect.arrayContaining([
          'ix_stock_docs_doc_date', 'ix_stock_docs_partner', 'ix_stock_docs_project',
        ]),
      );
      const insertedId = `sd-ext-${randomUUID()}`;
      await connection.query.insertInto('stock_docs').values({
        id: insertedId, doc_no: `IN-EXT-${randomUUID().slice(0, 6)}`, doc_type: 'in', reason: 'purchase_receipt',
        created_by_id: 'tester', created_at: '2026-11-27T01:00:00.000Z',
        updated_at: '2026-11-27T01:00:00.000Z',
      }).execute();
      const row = await connection.query.selectFrom('stock_docs').selectAll()
        .where('id', '=', insertedId).executeTakeFirstOrThrow();
      expect(Number(row.discountAmount)).toBe(0);
      expect(row.docDate).toBeNull();
      expect(row.payableTotal).toBeNull();
    },
    down: async ({ connection, expectCollection }) => {
      expect(Object.keys((await expectCollection('stockDocs').toExist()).fields).sort())
        .toEqual(DOC_FIELDS);
      expect(Object.keys((await expectCollection('stockDocLines').toExist()).fields).sort())
        .toEqual(LINE_FIELDS);
      const physical = await connection.schemaInspector.getPhysicalCollection({
        tableName: 'stock_docs',
      });
      expect(physical?.indexes.map((index) => index.name)).not.toContain('ix_stock_docs_project');
    },
  });
});

/** R-020 波 1：四张表的列、主键、索引与 stock_docs 两列逐项钉住。 */
const STOCKTAKING_FIELDS = [
  'id', 'docNo', 'docDate', 'warehouseId', 'handlerUserId', 'supervisorUserId',
  'status', 'remark', 'createdById', 'createdAt', 'updatedAt',
].sort();
const STOCKTAKING_LINE_FIELDS = [
  'id', 'docId', 'itemId', 'systemQty', 'actualQty', 'deltaQty', 'result', 'note',
].sort();
const TRANSFER_FIELDS = [
  'id', 'docNo', 'docDate', 'transferInWarehouseId', 'transferOutWarehouseId',
  'handlerUserId', 'status', 'remark', 'createdById', 'createdAt', 'updatedAt',
].sort();
const TRANSFER_LINE_FIELDS = [
  'id', 'docId', 'itemId', 'qty', 'transferQty', 'note',
].sort();
const ADDON_DOC_FIELDS = [...EXT_DOC_FIELDS, 'stocktakingId', 'transferDocId'].sort();

describe('R-020 波 1：盘点单与调拨单的迁移', () => {
  describeMigration('202611260023_stocktaking_transfer', {
    sources,
    up: async ({ connection, expectCollection }) => {
      const stocktaking = await expectCollection('stocktakingDocs').toExist();
      expect(Object.keys(stocktaking.fields).sort()).toEqual(STOCKTAKING_FIELDS);
      expect(stocktaking.primaryKey).toEqual(['id']);
      expect(stocktaking.foreignKeys).toHaveLength(0);
      await expectCollection('stocktakingDocs').toHaveField('docNo', {
        type: 'string', length: 32, nullable: false,
      });
      await expectCollection('stocktakingDocs').toHaveField('status', {
        type: 'string', length: 16, nullable: false,
      });
      await expectCollection('stocktakingDocs').toHaveIndex(['warehouseId', 'docDate']);

      const stocktakingLines = await expectCollection('stocktakingDocLines').toExist();
      expect(Object.keys(stocktakingLines.fields).sort()).toEqual(STOCKTAKING_LINE_FIELDS);
      expect(stocktakingLines.primaryKey).toEqual(['id']);
      expect(stocktakingLines.foreignKeys).toHaveLength(0);
      await expectDecimal(connection, 'stocktaking_doc_lines', 'system_qty');
      await expectDecimal(connection, 'stocktaking_doc_lines', 'actual_qty');
      await expectDecimal(connection, 'stocktaking_doc_lines', 'delta_qty');
      await expectCollection('stocktakingDocLines').toHaveIndex(['docId']);

      const transfer = await expectCollection('transferDocs').toExist();
      expect(Object.keys(transfer.fields).sort()).toEqual(TRANSFER_FIELDS);
      expect(transfer.primaryKey).toEqual(['id']);
      expect(transfer.foreignKeys).toHaveLength(0);
      await expectCollection('transferDocs').toHaveIndex(['transferInWarehouseId', 'docDate']);

      const transferLines = await expectCollection('transferDocLines').toExist();
      expect(Object.keys(transferLines.fields).sort()).toEqual(TRANSFER_LINE_FIELDS);
      expect(transferLines.primaryKey).toEqual(['id']);
      expect(transferLines.foreignKeys).toHaveLength(0);
      await expectDecimal(connection, 'transfer_doc_lines', 'qty');
      await expectDecimal(connection, 'transfer_doc_lines', 'transfer_qty');

      const docs = await expectCollection('stockDocs').toExist();
      expect(Object.keys(docs.fields).sort()).toEqual(ADDON_DOC_FIELDS);
      await expectCollection('stockDocs').toHaveField('stocktakingId', {
        type: 'string', length: 64, nullable: true,
      });
      await expectCollection('stockDocs').toHaveField('transferDocId', {
        type: 'string', length: 64, nullable: true,
      });
      const physical = await connection.schemaInspector.getPhysicalCollection({
        tableName: 'stock_docs',
      });
      const names = [...(physical?.indexes.map((index) => index.name) ?? [])].sort();
      expect(names).toEqual(expect.arrayContaining([
        'uq_stock_docs_stocktaking', 'uq_stock_docs_transfer',
      ]));

      const insertDoc = async (id: string, stocktakingId: string | null, docType: string) =>
        connection.query.insertInto('stock_docs').values({
          id,
          doc_no: `PD-${randomUUID().slice(0, 8)}`,
          doc_type: docType,
          reason: docType === 'in' ? 'other_in' : 'other_out',
          created_by_id: 'migration-test',
          created_at: '2026-11-28T01:00:00.000Z',
          updated_at: '2026-11-28T01:00:00.000Z',
          stocktakingId,
        }).execute();
      const before = await connection.repository<Record<string, unknown>>('stockDocs').count();
      const linkId = `st-${randomUUID()}`;
      await insertDoc(`sd-${randomUUID()}`, linkId, 'in');
      await expect(
        insertDoc(`sd-${randomUUID()}`, linkId, 'in'),
        '同一盘点单的同类单据只能有一张',
      ).rejects.toThrow();
      // 部分索引：不回链的老单据不受影响。
      await insertDoc(`sd-${randomUUID()}`, null, 'in');
      await insertDoc(`sd-${randomUUID()}`, null, 'in');
      expect(
        await connection.repository<Record<string, unknown>>('stockDocs').count(),
      ).toBe(before + 3);
    },
    down: async ({ connection, expectCollection }) => {
      await expectCollection('stocktakingDocLines').not.toExist();
      await expectCollection('stocktakingDocs').not.toExist();
      await expectCollection('transferDocLines').not.toExist();
      await expectCollection('transferDocs').not.toExist();
      expect(Object.keys((await expectCollection('stockDocs').toExist()).fields).sort())
        .toEqual(EXT_DOC_FIELDS);
      const physical = await connection.schemaInspector.getPhysicalCollection({
        tableName: 'stock_docs',
      });
      const names = physical?.indexes.map((index) => index.name) ?? [];
      expect(names).not.toContain('uq_stock_docs_stocktaking');
      expect(names).not.toContain('uq_stock_docs_transfer');
    },
  });
});
