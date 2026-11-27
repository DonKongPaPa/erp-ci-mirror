// @vitest-environment node
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { describeMigration } from '@nocobase/app-testing/server';
import type { Knex } from 'knex';
import { describe, expect } from 'vitest';

/** expectCollection 只看字段类型；精度与时区从真库的信息模式读回来钉住。 */
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

async function expectType(
  connection: { client<T>(): Promise<T> },
  table: string,
  column: string,
  type: string,
): Promise<void> {
  const knex = await connection.client<Knex>();
  const result = await knex.raw<{ rows?: { data_type: string }[] }>(
    `select data_type from information_schema.columns
      where table_schema = current_schema() and table_name = ? and column_name = ?`,
    [table, column],
  );
  expect(result.rows?.[0]?.data_type, `${table}.${column} 必须是 ${type}`).toBe(type);
}

const sources = [
  {
    packageName: 'orders-migration-test',
    directory: path.resolve(import.meta.dirname, '../../database/main/migrations'),
  },
];

/** 迁移 202611260011（库存）之前的业务表，加上 R-020 的五张。 */
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
  'stock_balances',
  'stock_doc_lines',
  'stock_docs',
  'stock_transactions',
  'units',
  'warehouses',
];

const PURCHASE_ORDER_FIELDS = [
  'createdAt',
  'createdById',
  'id',
  'orderDate',
  'orderNo',
  'remark',
  'status',
  'submittedAt',
  'supplierId',
  'updatedAt',
];
const PURCHASE_LINE_FIELDS = [
  'id', 'itemId', 'orderId', 'price', 'qty', 'receivedQty',
];
const SALES_ORDER_FIELDS = [
  'createdAt',
  'createdById',
  'customerId',
  'id',
  'orderDate',
  'orderNo',
  'remark',
  'status',
  'submittedAt',
  'updatedAt',
];
const SALES_LINE_FIELDS = ['id', 'itemId', 'orderId', 'price', 'qty', 'shippedQty'];

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

describe('R-021：采购订单的迁移', () => {
  describeMigration('202611260012_create_purchase', {
    sources,
    up: async ({ connection, expectCollection }) => {
      const orders = await expectCollection('purchaseOrders').toExist();
      expect(Object.keys(orders.fields).sort()).toEqual(PURCHASE_ORDER_FIELDS);
      expect(orders.primaryKey).toEqual(['id']);
      expect(orders.foreignKeys).toHaveLength(0);
      await expectCollection('purchaseOrders').toHaveField('orderNo', {
        type: 'string', length: 32, nullable: false,
      });
      await expectCollection('purchaseOrders').toHaveField('supplierId', {
        type: 'string', length: 64, nullable: false,
      });
      await expectCollection('purchaseOrders').toHaveField('status', {
        type: 'string', length: 32, nullable: false,
      });
      await expectCollection('purchaseOrders').toHaveIndex(['status', 'orderDate']);
      await expectCollection('purchaseOrders').toHaveIndex(['supplierId']);
      await expectType(connection, 'purchase_orders', 'order_date', 'date');
      for (const column of ['created_at', 'updated_at', 'submitted_at']) {
        await expectType(connection, 'purchase_orders', column, 'timestamp with time zone');
      }

      const lines = await expectCollection('purchaseOrderLines').toExist();
      expect(Object.keys(lines.fields).sort()).toEqual(PURCHASE_LINE_FIELDS);
      expect(lines.primaryKey).toEqual(['id']);
      expect(lines.foreignKeys).toHaveLength(0);
      await expectCollection('purchaseOrderLines').toHaveIndex(['orderId']);
      for (const column of ['qty', 'price', 'received_qty']) {
        await expectDecimal(connection, 'purchase_order_lines', column);
      }

      const physical = await connection.schemaInspector.getPhysicalCollection({
        tableName: 'purchase_orders',
      });
      expect([...(physical?.indexes.map((index) => index.name) ?? [])].sort()).toEqual([
        'ix_purchase_orders_status_order_date',
        'ix_purchase_orders_supplier',
        'pk_purchase_orders',
        'uq_purchase_orders_order_no',
      ]);
      expect((await tableNames(connection)).sort()).toEqual(
        [...BASELINE_TABLES, 'purchase_order_lines', 'purchase_orders'].sort(),
      );

      expect(
        await connection.repository<Record<string, unknown>>('purchaseOrders').count(),
      ).toBe(0);
      expect(
        await connection.repository<Record<string, unknown>>('purchaseOrderLines').count(),
      ).toBe(0);
      await connection.query
        .insertInto('purchase_orders')
        .values({
          id: 'po-1',
          order_no: 'CG-20261127-0001',
          supplier_id: 'su-1',
          order_date: '2026-11-27',
          created_by_id: 'tester',
          created_at: '2026-11-27T01:00:00.000Z',
          updated_at: '2026-11-27T01:00:00.000Z',
        })
        .execute();
      const stored = await connection.query
        .selectFrom('purchase_orders')
        .selectAll()
        .where('id', '=', 'po-1')
        .executeTakeFirstOrThrow();
      expect(stored.status).toBe('draft');
      expect(stored.remark).toBe('');
      expect(stored.submittedAt).toBeNull();
      await connection.query
        .insertInto('purchase_order_lines')
        .values({ id: 'pol-1', order_id: 'po-1', item_id: 'item-1', qty: 3 })
        .execute();
      const line = await connection.query
        .selectFrom('purchase_order_lines')
        .selectAll()
        .where('id', '=', 'pol-1')
        .executeTakeFirstOrThrow();
      expect(Number(line.receivedQty)).toBe(0);
      expect(line.price).toBeNull();
      await expect(
        connection.query
          .insertInto('purchase_orders')
          .values({
            id: 'po-2',
            order_no: 'CG-20261127-0001',
            supplier_id: 'su-1',
            order_date: '2026-11-27',
            created_by_id: 'tester',
            created_at: '2026-11-27T01:00:00.000Z',
            updated_at: '2026-11-27T01:00:00.000Z',
          })
          .execute(),
      ).rejects.toThrow();
    },
    down: async ({ expectCollection }) => {
      await expectCollection('purchaseOrderLines').not.toExist();
      await expectCollection('purchaseOrders').not.toExist();
    },
  });
});

describe('R-022：销售订单的迁移', () => {
  describeMigration('202611260013_create_sales', {
    sources,
    up: async ({ connection, expectCollection }) => {
      const orders = await expectCollection('salesOrders').toExist();
      expect(Object.keys(orders.fields).sort()).toEqual(SALES_ORDER_FIELDS);
      expect(orders.primaryKey).toEqual(['id']);
      expect(orders.foreignKeys).toHaveLength(0);
      await expectCollection('salesOrders').toHaveField('status', {
        type: 'string', length: 32, nullable: false,
      });
      await expectCollection('salesOrders').toHaveIndex(['status', 'orderDate']);
      await expectCollection('salesOrders').toHaveIndex(['customerId']);
      await expectType(connection, 'sales_orders', 'order_date', 'date');
      for (const column of ['created_at', 'updated_at', 'submitted_at']) {
        await expectType(connection, 'sales_orders', column, 'timestamp with time zone');
      }

      const lines = await expectCollection('salesOrderLines').toExist();
      expect(Object.keys(lines.fields).sort()).toEqual(SALES_LINE_FIELDS);
      expect(lines.primaryKey).toEqual(['id']);
      expect(lines.foreignKeys).toHaveLength(0);
      await expectCollection('salesOrderLines').toHaveIndex(['orderId']);
      for (const column of ['qty', 'price', 'shipped_qty']) {
        await expectDecimal(connection, 'sales_order_lines', column);
      }

      const physical = await connection.schemaInspector.getPhysicalCollection({
        tableName: 'sales_orders',
      });
      expect([...(physical?.indexes.map((index) => index.name) ?? [])].sort()).toEqual([
        'ix_sales_orders_customer',
        'ix_sales_orders_status_order_date',
        'pk_sales_orders',
        'uq_sales_orders_order_no',
      ]);
      expect((await tableNames(connection)).sort()).toEqual(
        [
          ...BASELINE_TABLES,
          'purchase_order_lines',
          'purchase_orders',
          'sales_order_lines',
          'sales_orders',
        ].sort(),
      );

      await connection.query
        .insertInto('sales_orders')
        .values({
          id: 'so-1',
          order_no: 'XS-20261127-0001',
          customer_id: 'cu-1',
          order_date: '2026-11-27',
          created_by_id: 'tester',
          created_at: '2026-11-27T01:00:00.000Z',
          updated_at: '2026-11-27T01:00:00.000Z',
        })
        .execute();
      await connection.query
        .insertInto('sales_order_lines')
        .values({ id: 'sol-1', order_id: 'so-1', item_id: 'item-1', qty: 2 })
        .execute();
      const line = await connection.query
        .selectFrom('sales_order_lines')
        .selectAll()
        .where('id', '=', 'sol-1')
        .executeTakeFirstOrThrow();
      expect(Number(line.shippedQty)).toBe(0);
      expect(line.price).toBeNull();
    },
    down: async ({ expectCollection }) => {
      await expectCollection('salesOrderLines').not.toExist();
      await expectCollection('salesOrders').not.toExist();
    },
  });
});


/** R-021/R-022 加片：头 14/15 列、行 7 列与三个索引逐项钉住；down 还原到加片前。 */
const EXT_PURCHASE_HEADER_FIELDS = [
  ...PURCHASE_ORDER_FIELDS,
  'contactName', 'contactPhone', 'deliveryAddress', 'discountAmount',
  'handlerUserId', 'latestDeliveryDate', 'projectCode', 'settlementCode',
  'taxExcludedTotal', 'taxIncludedTotal', 'taxTotal', 'totalQty',
  'payableTotal', 'warehouseId',
].sort();
const EXT_SALES_HEADER_FIELDS = [
  ...SALES_ORDER_FIELDS,
  'contactName', 'contactPhone', 'customerOrderNo', 'deliveryAddress', 'discountAmount',
  'handlerUserId', 'latestDeliveryDate', 'projectCode', 'settlementCode',
  'taxExcludedTotal', 'taxIncludedTotal', 'taxTotal', 'totalQty',
  'payableTotal', 'warehouseId',
].sort();
const EXT_PURCHASE_LINE_FIELDS = [
  ...PURCHASE_LINE_FIELDS,
  'deliveryDate', 'note', 'taxAmount', 'taxExcludedAmount', 'taxExcludedPrice',
  'taxIncludedAmount', 'taxRate',
].sort();
const EXT_SALES_LINE_FIELDS = [
  ...SALES_LINE_FIELDS,
  'deliveryDate', 'note', 'taxAmount', 'taxExcludedAmount', 'taxExcludedPrice',
  'taxIncludedAmount', 'taxRate',
].sort();

describe('R-021/R-022 加片：订单补字段的迁移', () => {
  describeMigration('202611260018_orders_ext', {
    sources,
    up: async ({ connection, expectCollection }) => {
      const purchase = await expectCollection('purchaseOrders').toExist();
      expect(Object.keys(purchase.fields).sort()).toEqual(EXT_PURCHASE_HEADER_FIELDS);
      const sales = await expectCollection('salesOrders').toExist();
      expect(Object.keys(sales.fields).sort()).toEqual(EXT_SALES_HEADER_FIELDS);
      for (const [collection, table, fields] of [
        ['purchaseOrderLines', 'purchase_order_lines', EXT_PURCHASE_LINE_FIELDS],
        ['salesOrderLines', 'sales_order_lines', EXT_SALES_LINE_FIELDS],
      ] as const) {
        expect(Object.keys((await expectCollection(collection).toExist()).fields).sort())
          .toEqual(fields);
        await expectType(connection, table, 'delivery_date', 'date');
        await expectDecimal(connection, table, 'tax_rate', 5, 2);
        for (const column of [
          'tax_excluded_price', 'tax_excluded_amount', 'tax_amount', 'tax_included_amount',
        ]) {
          await expectDecimal(connection, table, column);
        }
      }
      await expectType(connection, 'purchase_orders', 'latest_delivery_date', 'date');
      await expectType(connection, 'sales_orders', 'latest_delivery_date', 'date');
      for (const [table, columns] of [
        ['purchase_orders', [
          'discount_amount', 'total_qty', 'tax_included_total', 'tax_excluded_total',
          'tax_total', 'payable_total',
        ]],
        ['sales_orders', [
          'discount_amount', 'total_qty', 'tax_included_total', 'tax_excluded_total',
          'tax_total', 'payable_total',
        ]],
      ] as const) {
        for (const column of columns) await expectDecimal(connection, table, column);
      }

      for (const [collection, table, prefix] of [
        ['purchaseOrders', 'purchase_orders', 'ix_purchase_orders'],
        ['salesOrders', 'sales_orders', 'ix_sales_orders'],
      ] as const) {
        await expectCollection(collection).toHaveIndex(['projectCode']);
        await expectCollection(collection).toHaveIndex(['handlerUserId']);
        await expectCollection(collection).toHaveIndex(['status', 'latestDeliveryDate']);
        const physical = await connection.schemaInspector.getPhysicalCollection({ tableName: table });
        expect([...(physical?.indexes.map((index) => index.name) ?? [])].sort()).toEqual(
          expect.arrayContaining([
            `${prefix}_project`, `${prefix}_handler`, `${prefix}_latest_delivery`,
          ]),
        );
      }

      // 默认值：新列的 discountAmount 非空默认 0，其余新列为空；存量行不回填。
      const now = '2026-11-27T02:00:00.000Z';
      const id = `po-ext-${randomUUID()}`;
      await connection.query.insertInto('purchase_orders').values({
        id,
        order_no: `PO-EXT-${randomUUID().slice(0, 6)}`,
        supplier_id: 'su-ext',
        order_date: '2026-11-27',
        created_by_id: 'tester',
        created_at: now,
        updated_at: now,
      }).execute();
      const row = await connection.query.selectFrom('purchase_orders').selectAll()
        .where('id', '=', id).executeTakeFirstOrThrow();
      expect(Number(row.discountAmount)).toBe(0);
      expect(row.latestDeliveryDate).toBeNull();
      expect(row.payableTotal).toBeNull();
    },
    down: async ({ connection, expectCollection }) => {
      expect(Object.keys((await expectCollection('purchaseOrders').toExist()).fields).sort())
        .toEqual(PURCHASE_ORDER_FIELDS);
      expect(Object.keys((await expectCollection('salesOrders').toExist()).fields).sort())
        .toEqual(SALES_ORDER_FIELDS);
      expect(Object.keys((await expectCollection('purchaseOrderLines').toExist()).fields).sort())
        .toEqual(PURCHASE_LINE_FIELDS);
      expect(Object.keys((await expectCollection('salesOrderLines').toExist()).fields).sort())
        .toEqual(SALES_LINE_FIELDS);
      const physical = await connection.schemaInspector.getPhysicalCollection({
        tableName: 'purchase_orders',
      });
      expect(physical?.indexes.map((index) => index.name)).not.toContain('ix_purchase_orders_project');
    },
  });
});
