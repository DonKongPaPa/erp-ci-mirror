// @vitest-environment node
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { describeMigration } from '@nocobase/app-testing/server';
import { describe, expect } from 'vitest';

/**
 * R-070 IQC：两张新表、两个新列的列、类型、主键、唯一约束与索引逐项钉在物理结构上。
 * 默认值从真库读回（expectCollection 不读默认值）；down 先删表再删列。
 */
const sources = [
  {
    packageName: 'iqc-migration-test',
    directory: path.resolve(import.meta.dirname, '../../database/main/migrations'),
  },
];

const ORDER_FIELDS = [
  'id', 'docNo', 'inspectionDate', 'inspectorUserId', 'purchaseOrderId',
  'supplierId', 'status', 'remark', 'createdById', 'completedAt', 'voidedAt',
  'createdAt', 'updatedAt',
].sort();
const LINE_FIELDS = [
  'id', 'orderId', 'itemId', 'purchaseQty', 'inspectionTypeCode',
  'receivedQty', 'inspectionQty', 'qualifiedQty', 'unqualifiedQty',
  'releasableQty', 'returnQty', 'samplingQty', 'samplingQualifiedQty',
  'lossQty', 'retainedQty', 'note',
].sort();
const ITEM_FIELDS = [
  'categoryCode', 'code', 'createdAt', 'createdById', 'id', 'itemType',
  'legacyCode', 'name', 'note', 'spec', 'status', 'unitCode', 'updatedAt',
  'auxUnitCode', 'basePurchasePrice', 'baseSalesPrice', 'barcode', 'brand',
  'englishName', 'manufacturerModel', 'purchaseLeadDays', 'stockMax',
  'stockMin', 'unitRatio', 'inspectionRequired',
].sort();
const DOC_FIELDS = [
  'createdAt', 'createdById', 'docNo', 'docType', 'id', 'postedAt',
  'postedById', 'reason', 'remark', 'sourceId', 'sourceType', 'status',
  'updatedAt',
  'docDate', 'partnerId', 'contactName', 'contactPhone', 'deliveryAddress',
  'customerOrderNo', 'projectCode', 'handlerUserId', 'takerDepartmentId',
  'takerUserId', 'discountAmount', 'totalQty', 'taxIncludedTotal',
  'taxExcludedTotal', 'taxTotal', 'payableTotal',
  'stocktakingId', 'transferDocId', 'returnDocId',
  'printCount', 'lastPrintedAt', 'lastPrintedBy',
  'inspectionId',
].sort();
const PREVIOUS_ITEM_FIELDS = ITEM_FIELDS.filter((field) => field !== 'inspectionRequired');
const PREVIOUS_DOC_FIELDS = DOC_FIELDS.filter((field) => field !== 'inspectionId');

describe('R-070 来料检验的迁移', () => {
  describeMigration('202611260030_iqc', {
    sources,
    up: async ({ connection, expectCollection }) => {
      const order = await expectCollection('inspectionOrders').toExist();
      expect(Object.keys(order.fields).sort(), '检验单头的列').toEqual(ORDER_FIELDS);
      expect(order.primaryKey).toEqual(['id']);
      expect(order.foreignKeys).toHaveLength(0);
      await expectCollection('inspectionOrders').toHaveField('docNo', {
        type: 'string', length: 32, nullable: false,
      });
      await expectCollection('inspectionOrders').toHaveField('status', {
        type: 'string', length: 16, nullable: false,
      });
      await expectCollection('inspectionOrders').toHaveField('inspectionDate', {
        type: 'date', nullable: false,
      });
      await expectCollection('inspectionOrders').toHaveField('completedAt', {
        type: 'datetimeTz', nullable: true,
      });
      await expectCollection('inspectionOrders').toHaveIndex(['docNo'], { unique: true });
      await expectCollection('inspectionOrders').toHaveIndex(['inspectionDate']);
      await expectCollection('inspectionOrders').toHaveIndex(['purchaseOrderId']);

      const line = await expectCollection('inspectionLines').toExist();
      expect(Object.keys(line.fields).sort(), '检验明细的列').toEqual(LINE_FIELDS);
      expect(line.primaryKey).toEqual(['id']);
      expect(line.foreignKeys).toHaveLength(0);
      await expectCollection('inspectionLines').toHaveIndex(['orderId']);

      const physical = async (tableName: string) => {
        const found = await connection.schemaInspector.getPhysicalCollection({ tableName });
        return [...(found?.indexes.map((index) => index.name) ?? [])].sort();
      };
      expect(await physical('inspection_orders')).toEqual([
        'ix_inspection_orders_date', 'ix_inspection_orders_order',
        'pk_inspection_orders', 'uq_inspection_orders_doc_no',
      ]);
      expect(await physical('inspection_lines')).toEqual([
        'ix_inspection_lines_order', 'pk_inspection_lines',
      ]);

      const items = await expectCollection('items').toExist();
      expect(Object.keys(items.fields).sort()).toEqual(ITEM_FIELDS);
      await expectCollection('items').toHaveField('inspectionRequired', {
        type: 'boolean', nullable: false,
      });
      const docs = await expectCollection('stockDocs').toExist();
      expect(Object.keys(docs.fields).sort()).toEqual(DOC_FIELDS);
      await expectCollection('stockDocs').toHaveField('inspectionId', {
        type: 'string', length: 64, nullable: true,
      });

      // 默认值从真库读：开关默认关，回链列默认空；单号全表唯一。
      const now = '2026-11-28T01:00:00.000Z';
      const unit = `U${randomUUID().replaceAll('-', '').slice(0, 12)}`;
      const itemId = randomUUID();
      const orderId = randomUUID();
      const docNo = `JY-${randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase()}`;
      await connection.query.insertInto('units')
        .values({ code: unit, name: 'Piece', createdAt: now, updatedAt: now }).execute();
      await connection.query.insertInto('items').values({
        id: itemId, code: `M${randomUUID().replaceAll('-', '').slice(0, 12)}`,
        name: 'Steel', itemType: 'material', unitCode: unit,
        createdById: 'iqc-migration-test', createdAt: now, updatedAt: now,
      }).execute();
      const itemRow = await connection.query.selectFrom('items').selectAll()
        .where('id', '=', itemId).executeTakeFirstOrThrow();
      expect(itemRow.inspectionRequired).toBe(false);

      await connection.query.insertInto('stock_docs').values({
        id: randomUUID(), doc_no: docNo, doc_type: 'in', reason: 'purchase_receipt',
        created_by_id: 'iqc-migration-test', created_at: now, updated_at: now,
      }).execute();
      const docRow = await connection.query.selectFrom('stock_docs').selectAll()
        .where('doc_no', '=', docNo).executeTakeFirstOrThrow();
      expect(docRow.inspectionId).toBeNull();

      const insertOrder = (no: string) => connection.query.insertInto('inspection_orders').values({
        id: orderId, doc_no: no, inspection_date: '2026-11-28',
        inspector_user_id: 'tester', purchase_order_id: randomUUID(),
        status: 'pending', remark: '', created_by_id: 'tester',
        created_at: now, updated_at: now,
      }).execute();
      await insertOrder(docNo);
      await expect(insertOrder(docNo), '检验单号全表唯一').rejects.toThrow();
      await connection.query.insertInto('inspection_lines').values({
        id: randomUUID(), order_id: orderId, item_id: itemId,
        purchase_qty: 10, inspection_type_code: 'full',
        received_qty: 10, inspection_qty: 8, qualified_qty: 7,
        unqualified_qty: 1, releasable_qty: 7, return_qty: 3,
        sampling_qty: 0, sampling_qualified_qty: 0, loss_qty: 0, retained_qty: 0,
      }).execute();
      const lineRow = await connection.query.selectFrom('inspection_lines').selectAll()
        .where('order_id', '=', orderId).executeTakeFirstOrThrow();
      expect(Number(lineRow.lossQty)).toBe(0);
      expect(Number(lineRow.retainedQty)).toBe(0);
      expect(lineRow.note).toBeNull();
    },
    down: async ({ expectCollection }) => {
      await expectCollection('inspectionLines').not.toExist();
      await expectCollection('inspectionOrders').not.toExist();
      expect(Object.keys((await expectCollection('items').toExist()).fields).sort())
        .toEqual(PREVIOUS_ITEM_FIELDS);
      expect(Object.keys((await expectCollection('stockDocs').toExist()).fields).sort())
        .toEqual(PREVIOUS_DOC_FIELDS);
      await expectCollection('items').not.toHaveField('inspectionRequired');
      await expectCollection('stockDocs').not.toHaveField('inspectionId');
    },
  });
});
