import type { Application } from '@nocobase/app-server/application';
import {
  databaseManagerToken,
  type DatabaseConnection,
  type DatabaseManager,
} from '@nocobase/db';
import {
  createServiceToken,
  ServiceProvider,
  type ServiceToken,
} from '@nocobase/service-provider';
import { randomUUID } from 'node:crypto';
import type { Knex } from 'knex';

import { codeServiceToken, type CodeService } from './codes.js';
import { docFilesToken, type DocFiles, type DocFileView } from './doc-files.js';

/**
 * R-070 IQC：采购检验单的读写服务。
 *
 * 合格、不合格、可入库、退货四个数量由服务端从收货/检验/合格数量算出，请求体里的同名字段一律忽略。
 * 明细随整单替换、与头同一事务；状态只在 pending 可改。仓管建入库单时按检验行余额校验并锁行，
 * 两笔事务同时用同一行时后到的一笔会被行锁挡到前一笔提交，再按已用数量拒绝。
 */
export type InspectionStatus = 'pending' | 'passed' | 'partial' | 'failed' | 'void';
export type InspectionTypeCode = 'full' | 'sampling' | 'exempt';

export type IqcRuleCode =
  | 'iqc-not-found'
  | 'iqc-not-pending'
  | 'iqc-duplicate-item'
  | 'iqc-qty-invalid'
  | 'iqc-received-exceed'
  | 'iqc-not-releasable'
  | 'iqc-releasable-exceed'
  | 'iqc-order-invalid'
  | 'iqc-person-invalid'
  | 'item-not-found'
  | 'item-inactive'
  | 'document-not-found';

export class IqcRuleError extends Error {
  public constructor(
    readonly code: IqcRuleCode,
    readonly detail?: string,
  ) {
    super(detail ?? `IQC rule violated: ${code}`);
    this.name = 'IqcRuleError';
  }
}

function fail(code: IqcRuleCode, detail?: string): never {
  throw new IqcRuleError(code, detail);
}

export interface ItemRef {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly spec: string | null;
  readonly unitCode: string;
}
export interface PersonRef { readonly userId: string; readonly name: string; }
export interface OrderRef {
  readonly id: string;
  readonly orderNo: string;
  readonly orderDate: string;
}
export interface SupplierRef {
  readonly id: string;
  readonly code: string;
  readonly name: string;
}

export interface InspectionLineRecord {
  readonly id: string;
  readonly itemId: string;
  readonly item: ItemRef;
  readonly purchaseQty: number;
  readonly inspectionTypeCode: InspectionTypeCode;
  readonly receivedQty: number;
  readonly inspectionQty: number;
  readonly qualifiedQty: number;
  readonly unqualifiedQty: number;
  readonly releasableQty: number;
  readonly returnQty: number;
  readonly samplingQty: number;
  readonly samplingQualifiedQty: number;
  readonly lossQty: number;
  readonly retainedQty: number;
  readonly note: string | null;
}

export interface InspectionRecord {
  readonly id: string;
  readonly docNo: string;
  readonly inspectionDate: string;
  readonly status: InspectionStatus;
  readonly purchaseOrder: OrderRef;
  readonly supplier: SupplierRef | null;
  readonly inspector: PersonRef | null;
  readonly remark: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lines: readonly InspectionLineRecord[];
  readonly files: readonly DocFileView[];
}

export interface InspectionSummary {
  readonly id: string;
  readonly docNo: string;
  readonly inspectionDate: string;
  readonly status: InspectionStatus;
  readonly purchaseOrder: OrderRef;
  readonly supplier: SupplierRef | null;
  readonly inspector: PersonRef | null;
  readonly remark: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ReceivableInspection {
  readonly id: string;
  readonly docNo: string;
  readonly inspectionDate: string;
  readonly status: 'passed' | 'partial';
  readonly purchaseOrderId: string;
  readonly lines: readonly {
    readonly inspectionLineId: string;
    readonly itemId: string;
    readonly warehouseId: string;
    readonly batchNo: string;
    readonly releasableQty: number;
    readonly remainQty: number;
  }[];
}

export interface PageQuery {
  readonly page: number;
  readonly pageSize: number;
}
export interface InspectionListQuery extends PageQuery {
  readonly status?: InspectionStatus;
  readonly purchaseOrderId?: string;
  readonly supplierId?: string;
  readonly inspectorUserId?: string;
  readonly from?: string;
  readonly to?: string;
  readonly q?: string;
}
export interface ReceivableQuery extends PageQuery {
  readonly purchaseOrderId?: string;
  readonly q?: string;
}
export interface Page<T> {
  readonly items: readonly T[];
  readonly total: number;
}

export interface InspectionLineInput {
  readonly itemId: string;
  readonly inspectionTypeCode: string;
  readonly receivedQty: number;
  readonly inspectionQty: number;
  readonly qualifiedQty: number;
  readonly samplingQty: number;
  readonly samplingQualifiedQty: number;
  readonly lossQty?: number;
  readonly retainedQty?: number;
  readonly note?: string | null;
}
export interface CreateInspectionInput {
  readonly inspectionDate?: string | null;
  readonly purchaseOrderId: string;
  readonly inspectorUserId?: string | null;
  readonly remark?: string;
  readonly fileIds?: readonly string[];
  readonly lines: readonly InspectionLineInput[];
}
export interface UpdateInspectionInput {
  readonly inspectionDate?: string | null;
  readonly inspectorUserId?: string | null;
  readonly remark?: string;
  readonly fileIds?: readonly string[];
  readonly lines?: readonly InspectionLineInput[];
}

export interface InspectionReader {
  list(query: InspectionListQuery): Promise<Page<InspectionSummary>>;
  detail(id: string): Promise<InspectionRecord | undefined>;
  receivable(query: ReceivableQuery): Promise<Page<ReceivableInspection>>;
}
export interface InspectionMutations {
  create(input: CreateInspectionInput, byUserId: string): Promise<InspectionRecord>;
  update(id: string, input: UpdateInspectionInput, byUserId: string): Promise<InspectionRecord>;
  complete(id: string, byUserId: string): Promise<InspectionRecord>;
  void(id: string, byUserId: string): Promise<InspectionRecord>;
}

interface HeaderRow {
  id: string;
  doc_no: string;
  inspection_date: string | Date;
  inspector_user_id: string;
  purchase_order_id: string;
  supplier_id: string | null;
  status: string;
  remark: string;
  created_by_id: string;
  completed_at: string | Date | null;
  voided_at: string | Date | null;
  created_at: string | Date;
  updated_at: string | Date;
}
interface LineRow {
  id: string;
  order_id: string;
  item_id: string;
  purchase_qty: string | number;
  inspection_type_code: string;
  received_qty: string | number;
  inspection_qty: string | number;
  qualified_qty: string | number;
  unqualified_qty: string | number;
  releasable_qty: string | number;
  return_qty: string | number;
  sampling_qty: string | number;
  sampling_qualified_qty: string | number;
  loss_qty: string | number;
  retained_qty: string | number;
  note: string | null;
}
interface RefRow { id: string; code?: string | null; name: string | null; }
interface ItemRow {
  id: string; code: string; name: string; spec: string | null; unit_code: string;
}
interface OrderRow {
  id: string;
  order_no: string;
  order_date: string | Date;
  warehouse_id: string | null;
  supplier_id?: string | null;
}

const num = (value: string | number): number => Number(value);

function dayString(value: string | Date): string {
  if (typeof value === 'string') return value.slice(0, 10);
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${value.getFullYear()}-${month}-${day}`;
}

/** 新建不传检验日期时按 Asia/Shanghai 的当天填，与出入库单同一口径。 */
function today(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

async function countOf(base: Knex.QueryBuilder): Promise<number> {
  const row = (await base.clone().clear('select').count('* as count').first()) as
    | { count?: string | number }
    | undefined;
  return Number(row?.count ?? 0);
}

function derivedQuantities(line: InspectionLineInput) {
  return {
    unqualified: line.inspectionQty - line.qualifiedQty,
    releasable: line.qualifiedQty,
    return: line.receivedQty - line.qualifiedQty,
  };
}

/** 四个服务端算列永远由收货/检验/合格数量算，不读请求体里的同名字段。 */
function validateLines(lines: readonly InspectionLineInput[]): void {
  if (lines.length === 0) return fail('iqc-qty-invalid', 'lines');
  const seen = new Set<string>();
  for (const line of lines) {
    if (typeof line.itemId !== 'string' || line.itemId.trim() === '') {
      return fail('iqc-qty-invalid', 'itemId');
    }
    if (seen.has(line.itemId)) return fail('iqc-duplicate-item', line.itemId);
    seen.add(line.itemId);
    const values = [
      line.receivedQty, line.inspectionQty, line.qualifiedQty,
      line.samplingQty, line.samplingQualifiedQty,
      line.lossQty ?? 0, line.retainedQty ?? 0,
    ];
    if (values.some((value) => !Number.isFinite(value) || value < 0)) {
      return fail('iqc-qty-invalid', 'negative');
    }
    if (!(line.receivedQty > 0) || !(line.inspectionQty > 0)) {
      return fail('iqc-qty-invalid', 'positive');
    }
    if (line.inspectionQty > line.receivedQty || line.qualifiedQty > line.inspectionQty) {
      return fail('iqc-qty-invalid', 'qualified');
    }
    if (line.samplingQty > line.inspectionQty ||
        line.samplingQualifiedQty > line.samplingQty) {
      return fail('iqc-qty-invalid', 'sampling');
    }
    if (line.inspectionTypeCode === 'sampling' && !(line.samplingQty > 0)) {
      return fail('iqc-qty-invalid', 'sampling-required');
    }
    if ((line.note ?? '').length > 500) return fail('iqc-qty-invalid', 'note');
  }
}

async function requireActivePerson(knex: Knex, userId: string): Promise<void> {
  const row = await knex<{ user_id: string; status: string }>('employees')
    .select('user_id', 'status').where({ user_id: userId }).first();
  if (row === undefined || row.status !== 'active') return fail('iqc-person-invalid', userId);
}

async function isActivePerson(knex: Knex, userId: string): Promise<boolean> {
  const row = await knex<{ user_id: string }>('employees')
    .select('user_id').where('user_id', userId).where('status', 'active').first();
  return row !== undefined;
}

/** 同一采购订单行上其它未作废检验单已占的收货数量。 */
async function occupiedReceived(
  knex: Knex,
  purchaseOrderId: string,
  itemId: string,
  excludeOrderId?: string,
): Promise<number> {
  const result = await knex.raw<{ rows?: readonly { qty: string | number | null }[] }>(
    `select coalesce(sum(il.received_qty), 0) as qty
       from inspection_lines il
       join inspection_orders io on io.id = il.order_id
      where io.purchase_order_id = ? and il.item_id = ? and io.status <> 'void'
        and (?::text is null or io.id <> ?)`,
    [purchaseOrderId, itemId, excludeOrderId ?? null, excludeOrderId ?? null],
  );
  return num(result.rows?.[0]?.qty ?? 0);
}

async function requireOrder(
  knex: Knex,
  purchaseOrderId: string,
  lines: readonly InspectionLineInput[],
): Promise<OrderRow> {
  const order = await knex<OrderRow & { status: string }>('purchase_orders')
    .select('id', 'order_no', 'order_date', 'warehouse_id', 'status')
    .where({ id: purchaseOrderId }).first();
  if (order === undefined || order.status === 'draft' || order.status === 'cancelled') {
    return fail('iqc-order-invalid', purchaseOrderId);
  }
  for (const line of lines) {
    const poLine = await knex<{ qty: string | number }>('purchase_order_lines')
      .select('qty').where('order_id', purchaseOrderId)
      .where('item_id', line.itemId).first();
    if (poLine === undefined) return fail('iqc-order-invalid', line.itemId);
    if (line.receivedQty > num(poLine.qty)) {
      return fail('iqc-received-exceed', line.itemId);
    }
  }
  return order;
}

async function requireItems(knex: Knex, ids: readonly string[]): Promise<void> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return;
  const rows = await knex<{ id: string; status: string }>('items')
    .select('id', 'status').whereIn('id', unique);
  const found = new Map(rows.map((row) => [row.id, row.status]));
  for (const id of unique) {
    if (!found.has(id)) return fail('item-not-found', id);
    if (found.get(id) !== 'active') return fail('item-inactive', id);
  }
}

function summaryOf(
  row: HeaderRow,
  orders: Map<string, OrderRef>,
  suppliers: Map<string, SupplierRef>,
  people: Map<string, PersonRef>,
): InspectionSummary {
  const fallback: OrderRef = { id: row.purchase_order_id, orderNo: row.purchase_order_id, orderDate: '' };
  return {
    id: row.id,
    docNo: row.doc_no,
    inspectionDate: dayString(row.inspection_date),
    status: row.status as InspectionStatus,
    purchaseOrder: orders.get(row.purchase_order_id) ?? fallback,
    supplier: row.supplier_id === null ? null : (suppliers.get(row.supplier_id) ?? null),
    inspector: people.get(row.inspector_user_id) ?? null,
    remark: row.remark,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

function itemView(row: ItemRow): ItemRef {
  return {
    id: row.id, code: row.code, name: row.name,
    spec: row.spec ?? null, unitCode: row.unit_code,
  };
}

function lineView(row: LineRow, items: Map<string, ItemRef>): InspectionLineRecord {
  const fallback: ItemRef = {
    id: row.item_id, code: row.item_id, name: row.item_id, spec: null, unitCode: '',
  };
  return {
    id: row.id,
    itemId: row.item_id,
    item: items.get(row.item_id) ?? fallback,
    purchaseQty: num(row.purchase_qty),
    inspectionTypeCode: row.inspection_type_code as InspectionTypeCode,
    receivedQty: num(row.received_qty),
    inspectionQty: num(row.inspection_qty),
    qualifiedQty: num(row.qualified_qty),
    unqualifiedQty: num(row.unqualified_qty),
    releasableQty: num(row.releasable_qty),
    returnQty: num(row.return_qty),
    samplingQty: num(row.sampling_qty),
    samplingQualifiedQty: num(row.sampling_qualified_qty),
    lossQty: num(row.loss_qty),
    retainedQty: num(row.retained_qty),
    note: row.note ?? null,
  };
}

async function refsOf(knex: Knex, rows: readonly HeaderRow[]): Promise<{
  orders: Map<string, OrderRef>;
  suppliers: Map<string, SupplierRef>;
  people: Map<string, PersonRef>;
}> {
  const orderIds = [...new Set(rows.map((row) => row.purchase_order_id))];
  const supplierIds = [...new Set(rows.flatMap((row) =>
    row.supplier_id === null ? [] : [row.supplier_id]))];
  const userIds = [...new Set(rows.map((row) => row.inspector_user_id))];
  const [orders, suppliers, people] = await Promise.all([
    orderIds.length === 0 ? [] : knex<OrderRow>('purchase_orders')
      .select('id', 'order_no', 'order_date').whereIn('id', orderIds),
    supplierIds.length === 0 ? [] : knex<RefRow>('partners')
      .select('id', 'code', 'name').whereIn('id', supplierIds),
    userIds.length === 0 ? [] : knex<RefRow>('user')
      .select('id', 'name').whereIn('id', userIds),
  ]);
  const orderRefs = new Map<string, OrderRef>(orders.map((row) => [
    row.id, {
      id: row.id, orderNo: row.order_no, orderDate: dayString(row.order_date),
    },
  ]));
  return {
    orders: orderRefs,
    suppliers: new Map(suppliers.map((row) => [
      row.id, { id: row.id, code: row.code ?? row.id, name: row.name ?? row.id },
    ])),
    people: new Map(people.map((row) => [
      row.id, { userId: row.id, name: row.name ?? row.id },
    ])),
  };
}

async function readDetail(
  knex: Knex,
  docFiles: DocFiles,
  id: string,
): Promise<InspectionRecord | undefined> {
  const row = await knex<HeaderRow>('inspection_orders').where({ id }).first();
  if (row === undefined) return undefined;
  const lineRows = await knex<LineRow>('inspection_lines')
    .where({ order_id: id }).orderBy('id', 'asc');
  const refs = await refsOf(knex, [row]);
  const itemRows = await knex<ItemRow>('items')
    .select('id', 'code', 'name', 'spec', 'unit_code')
    .whereIn('id', lineRows.map((line) => line.item_id));
  const items = new Map(itemRows.map((item) => [item.id, itemView(item)]));
  return {
    ...summaryOf(row, refs.orders, refs.suppliers, refs.people),
    lines: lineRows.map((line) => lineView(line, items)),
    files: await docFiles.filesOf(knex, 'inspection', id),
  };
}

export class DatabaseInspectionReader implements InspectionReader {
  public constructor(
    private readonly database: DatabaseManager,
    private readonly docFiles: DocFiles,
  ) {}

  private async knex(): Promise<Knex> {
    return await this.database.connection().client<Knex>();
  }

  public async list(query: InspectionListQuery): Promise<Page<InspectionSummary>> {
    const knex = await this.knex();
    const base = knex<HeaderRow>('inspection_orders').modify((builder) => {
      if (query.status !== undefined) void builder.where('status', query.status);
      if (query.purchaseOrderId !== undefined) {
        void builder.where('purchase_order_id', query.purchaseOrderId);
      }
      if (query.supplierId !== undefined) void builder.where('supplier_id', query.supplierId);
      if (query.inspectorUserId !== undefined) {
        void builder.where('inspector_user_id', query.inspectorUserId);
      }
      if (query.from !== undefined) void builder.where('inspection_date', '>=', query.from);
      if (query.to !== undefined) void builder.where('inspection_date', '<=', query.to);
      if (query.q !== undefined && query.q !== '') {
        void builder.where((inner) => {
          inner.whereILike('doc_no', `%${query.q}%`).orWhereILike('remark', `%${query.q}%`);
        });
      }
    });
    const total = await countOf(base);
    const rows = (await base.clone()
      .orderBy('created_at', 'desc')
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize)) as HeaderRow[];
    const refs = await refsOf(knex, rows);
    return {
      items: rows.map((row) => summaryOf(row, refs.orders, refs.suppliers, refs.people)),
      total,
    };
  }

  public async detail(id: string): Promise<InspectionRecord | undefined> {
    return await readDetail(await this.knex(), this.docFiles, id);
  }

  public async receivable(query: ReceivableQuery): Promise<Page<ReceivableInspection>> {
    const knex = await this.knex();
    const rows = await knex<LineRow>('inspection_lines as il')
      .select('il.*', 'io.doc_no', 'io.inspection_date', 'io.status as order_status',
        'io.purchase_order_id')
      .join('inspection_orders as io', 'io.id', 'il.order_id')
      .whereIn('io.status', ['passed', 'partial'])
      .modify((builder) => {
        if (query.purchaseOrderId !== undefined) {
          void builder.where('io.purchase_order_id', query.purchaseOrderId);
        }
        if (query.q !== undefined && query.q !== '') {
          void builder.whereILike('io.doc_no', `%${query.q}%`);
        }
      })
      .orderBy('il.id', 'asc') as unknown as (LineRow & {
        doc_no: string;
        inspection_date: string | Date;
        order_status: string;
        purchase_order_id: string;
      })[];
    const orderIds = [...new Set(rows.map((row) => row.purchase_order_id))];
    const orderRows = orderIds.length === 0 ? [] : await knex<OrderRow>('purchase_orders')
      .select('id', 'warehouse_id').whereIn('id', orderIds);
    const warehouses = new Map(orderRows.map((row) => [row.id, row.warehouse_id ?? '']));

    const used = new Map<string, number>();
    if (rows.length > 0) {
  const usedRows = await knex.raw<{
    rows?: readonly { order_id: string; item_id: string; qty: string | number }[];
  }>(
    `select sd.inspection_id as order_id, sdl.item_id, sum(sdl.qty) as qty
           from stock_docs sd
           join stock_doc_lines sdl on sdl.doc_id = sd.id
          where sd.inspection_id is not null
          group by sd.inspection_id, sdl.item_id`,
      );
      for (const row of usedRows.rows ?? []) {
        used.set(`${String(row.order_id)}:${String(row.item_id)}`, Number(row.qty));
      }
    }

    const grouped = new Map<string, ReceivableInspection>();
    for (const row of rows) {
      const remain = num(row.releasable_qty) - (used.get(`${row.order_id}:${row.item_id}`) ?? 0);
      if (!(remain > 0)) continue;
      let order = grouped.get(row.order_id);
      if (order === undefined) {
        order = {
          id: row.order_id,
          docNo: row.doc_no,
          inspectionDate: dayString(row.inspection_date),
          status: row.order_status as 'passed' | 'partial',
          purchaseOrderId: row.purchase_order_id,
          lines: [],
        };
        grouped.set(row.order_id, order);
      }
      (order.lines as { inspectionLineId: string; itemId: string; warehouseId: string; batchNo: string; releasableQty: number; remainQty: number }[]).push({
        inspectionLineId: row.id,
        itemId: row.item_id,
        warehouseId: warehouses.get(row.purchase_order_id) ?? '',
        batchNo: '',
        releasableQty: num(row.releasable_qty),
        remainQty: remain,
      });
    }
    const all = [...grouped.values()];
    const offset = (query.page - 1) * query.pageSize;
    return {
      items: all.slice(offset, offset + query.pageSize),
      total: all.length,
    };
  }
}

export class DatabaseInspectionMutations implements InspectionMutations {
  public constructor(
    private readonly database: DatabaseManager,
    private readonly codes: CodeService,
    private readonly docFiles: DocFiles,
  ) {}

  private async knex(tx?: DatabaseConnection): Promise<Knex> {
    return await (tx ?? this.database.connection()).client<Knex>();
  }

  private async inTransaction<T>(
    transaction: DatabaseConnection | undefined,
    work: (tx: DatabaseConnection) => Promise<T>,
  ): Promise<T> {
    if (transaction !== undefined) return await work(transaction);
    return await this.database.transaction(work);
  }

  private async requirePending(knex: Knex, id: string): Promise<HeaderRow> {
    const result = await knex.raw<{ rows?: readonly HeaderRow[] }>(
      `select * from inspection_orders where id = ? for update`, [id],
    );
    const row = result.rows?.[0];
    if (row === undefined) return fail('iqc-not-found', id);
    if (row.status !== 'pending') return fail('iqc-not-pending', id);
    return row;
  }

  public async create(input: CreateInspectionInput, byUserId: string): Promise<InspectionRecord> {
    validateLines(input.lines);
    if ((input.remark ?? '').length > 1000) return fail('iqc-qty-invalid', 'remark');
    return await this.inTransaction(undefined, async (tx) => {
      const knex = await this.knex(tx);
      const order = await requireOrder(knex, input.purchaseOrderId, input.lines);
      await requireItems(knex, input.lines.map((line) => line.itemId));
      let inspectorUserId: string | null = null;
      if (input.inspectorUserId !== undefined && input.inspectorUserId !== null) {
        await requireActivePerson(knex, input.inspectorUserId);
        inspectorUserId = input.inspectorUserId;
      } else if (input.inspectorUserId === undefined && await isActivePerson(knex, byUserId)) {
        inspectorUserId = byUserId;
      }
      const docNo = await this.codes.nextCode(tx, 'JY');
      const id = randomUUID();
      const now = new Date();
      await knex('inspection_orders').insert({
        id,
        doc_no: docNo,
        inspection_date: input.inspectionDate ?? today(),
        inspector_user_id: inspectorUserId ?? byUserId,
        purchase_order_id: input.purchaseOrderId,
        supplier_id: order.supplier_id ?? null,
        status: 'pending',
        remark: input.remark ?? '',
        created_by_id: byUserId,
        completed_at: null,
        voided_at: null,
        created_at: now,
        updated_at: now,
      });
      await this.insertLines(knex, id, input.purchaseOrderId, input.lines);
      await this.docFiles.bind(knex, 'inspection', id, input.fileIds, byUserId);
      return await this.detailIn(tx, id);
    });
  }

  public async update(
    id: string,
    input: UpdateInspectionInput,
    byUserId: string,
  ): Promise<InspectionRecord> {
    return await this.inTransaction(undefined, async (tx) => {
      const knex = await this.knex(tx);
      const row = await this.requirePending(knex, id);
      if (input.inspectionDate === undefined && input.inspectorUserId === undefined &&
          input.remark === undefined && input.fileIds === undefined && input.lines === undefined) {
        return fail('iqc-qty-invalid', 'empty-update');
      }
      if (input.lines !== undefined) {
        validateLines(input.lines);
        await requireOrder(knex, row.purchase_order_id, input.lines);
        await requireItems(knex, input.lines.map((line) => line.itemId));
      }
      if (input.inspectorUserId !== undefined && input.inspectorUserId !== null) {
        await requireActivePerson(knex, input.inspectorUserId);
      }
      await knex('inspection_orders').where({ id }).update({
        ...(input.inspectionDate === undefined ? {} : { inspection_date: input.inspectionDate }),
        ...(input.inspectorUserId === undefined ? {} : { inspector_user_id: input.inspectorUserId }),
        ...(input.remark === undefined ? {} : { remark: input.remark }),
        updated_at: new Date(),
      });
      if (input.lines !== undefined) {
        await knex('inspection_lines').where({ order_id: id }).delete();
        await this.insertLines(knex, id, row.purchase_order_id, input.lines, id);
      }
      await this.docFiles.bind(knex, 'inspection', id, input.fileIds, byUserId);
      return await this.detailIn(tx, id);
    });
  }

  public async complete(id: string, _byUserId: string): Promise<InspectionRecord> {
    return await this.inTransaction(undefined, async (tx) => {
      const knex = await this.knex(tx);
      await this.requirePending(knex, id);
      const lines = await knex<LineRow>('inspection_lines').where({ order_id: id });
      if (lines.length === 0) return fail('iqc-qty-invalid', 'lines');
      const qualifiedAll = lines.every((line) =>
        num(line.qualified_qty) === num(line.inspection_qty));
      const qualifiedNone = lines.every((line) => num(line.qualified_qty) === 0);
      const status: InspectionStatus = qualifiedAll ? 'passed' : qualifiedNone ? 'failed' : 'partial';
      for (const line of lines) {
        const derived = derivedQuantities({
          itemId: line.item_id,
          inspectionTypeCode: line.inspection_type_code,
          receivedQty: num(line.received_qty),
          inspectionQty: num(line.inspection_qty),
          qualifiedQty: num(line.qualified_qty),
          samplingQty: num(line.sampling_qty),
          samplingQualifiedQty: num(line.sampling_qualified_qty),
        });
        await knex('inspection_lines').where({ id: line.id }).update({
          unqualified_qty: derived.unqualified,
          releasable_qty: derived.releasable,
          return_qty: derived.return,
        });
      }
      await knex('inspection_orders').where({ id }).update({
        status, completed_at: new Date(), updated_at: new Date(),
      });
      return await this.detailIn(tx, id);
    });
  }

  public async void(id: string, _byUserId: string): Promise<InspectionRecord> {
    return await this.inTransaction(undefined, async (tx) => {
      const knex = await this.knex(tx);
      await this.requirePending(knex, id);
      await knex('inspection_orders').where({ id }).update({
        status: 'void', voided_at: new Date(), updated_at: new Date(),
      });
      return await this.detailIn(tx, id);
    });
  }

  private async insertLines(
    knex: Knex,
    orderId: string,
    purchaseOrderId: string,
    lines: readonly InspectionLineInput[],
    excludeOrderId?: string,
  ): Promise<void> {
    for (const line of lines) {
      const poLine = await knex<{ qty: string | number }>('purchase_order_lines')
        .select('qty').where('order_id', purchaseOrderId)
        .where('item_id', line.itemId).first();
      if (poLine === undefined) return fail('iqc-order-invalid', line.itemId);
      const occupied = await occupiedReceived(
        knex, purchaseOrderId, line.itemId, excludeOrderId,
      );
      if (line.receivedQty > num(poLine.qty) - occupied) {
        return fail('iqc-received-exceed', line.itemId);
      }
      const derived = derivedQuantities(line);
      await knex('inspection_lines').insert({
        id: randomUUID(),
        order_id: orderId,
        item_id: line.itemId.trim(),
        purchase_qty: num(poLine.qty),
        inspection_type_code: line.inspectionTypeCode,
        received_qty: line.receivedQty,
        inspection_qty: line.inspectionQty,
        qualified_qty: line.qualifiedQty,
        unqualified_qty: derived.unqualified,
        releasable_qty: derived.releasable,
        return_qty: derived.return,
        sampling_qty: line.samplingQty,
        sampling_qualified_qty: line.samplingQualifiedQty,
        loss_qty: line.lossQty ?? 0,
        retained_qty: line.retainedQty ?? 0,
        note: line.note ?? null,
      });
    }
  }

  private async detailIn(tx: DatabaseConnection, id: string): Promise<InspectionRecord> {
    const row = await readDetail(await this.knex(tx), this.docFiles, id);
    if (row === undefined) return fail('iqc-not-found', id);
    return row;
  }
}

/**
 * 仓管建采购入库单时的挂点：只在这个键带上时才校验并锁检验行。
 * 不带 inspectionId 的调用直接返回，老路径逐字节照旧。
 */
export async function reserveInspection(
  knex: Knex,
  input: {
    readonly inspectionId?: string;
    readonly sourceId?: string;
    /** 改草稿时排除这张单自己原来的行，数量没变的保存不会被自己的占用挡住。 */
    readonly excludeDocId?: string;
    readonly lines: readonly {
      readonly itemId: string;
      readonly qty: number;
      readonly inspectionLineId?: string;
    }[];
  },
): Promise<void> {
  if (input.inspectionId === undefined) return;
  const result = await knex.raw<{ rows?: readonly HeaderRow[] }>(
    `select * from inspection_orders where id = ? for update`, [input.inspectionId],
  );
  const order = result.rows?.[0];
  if (order === undefined || (order.status !== 'passed' && order.status !== 'partial')) {
    return fail('iqc-not-releasable', input.inspectionId);
  }
  if (input.sourceId !== undefined && input.sourceId !== order.purchase_order_id) {
    return fail('iqc-not-releasable', 'purchaseOrder');
  }
  const locked = await knex.raw<{ rows?: readonly LineRow[] }>(
    `select * from inspection_lines where order_id = ? for update`, [input.inspectionId],
  );
  const lines = locked.rows ?? [];
  const usedRows = await knex.raw<{
    rows?: readonly { item_id: string; qty: string | number }[];
  }>(
    `select sdl.item_id, sum(sdl.qty) as qty
       from stock_docs sd
       join stock_doc_lines sdl on sdl.doc_id = sd.id
      where sd.inspection_id = ? and sd.status <> 'void'
        and sd.id <> ?
      group by sdl.item_id`,
    [input.inspectionId, input.excludeDocId ?? ''],
  );
  const used = new Map((usedRows.rows ?? []).map((row) => [String(row.item_id), Number(row.qty)]));
  for (const line of input.lines) {
    const inspectionLine = line.inspectionLineId === undefined
      ? lines.find((candidate) => candidate.item_id === line.itemId)
      : lines.find((candidate) => candidate.id === line.inspectionLineId);
    if (inspectionLine === undefined || inspectionLine.item_id !== line.itemId) {
      return fail('iqc-not-releasable', line.itemId);
    }
    const remain = num(inspectionLine.releasable_qty) - (used.get(line.itemId) ?? 0);
    if (line.qty > remain) return fail('iqc-releasable-exceed', line.itemId);
  }
}

export const inspectionReaderToken: ServiceToken<InspectionReader> =
  createServiceToken<InspectionReader>('app/inspection-reader');
export const inspectionMutationsToken: ServiceToken<InspectionMutations> =
  createServiceToken<InspectionMutations>('app/inspection-mutations');

export default class IqcProvider extends ServiceProvider<Application> {
  public readonly name: string = 'app.iqc';

  public override register(): void {
    this.app.container.singleton(inspectionReaderToken, () => {
      const database = this.app.container.resolve(databaseManagerToken);
      return new DatabaseInspectionReader(
        database,
        this.app.container.resolve(docFilesToken),
      );
    });
    this.app.container.singleton(inspectionMutationsToken, () => {
      const database = this.app.container.resolve(databaseManagerToken);
      return new DatabaseInspectionMutations(
        database,
        this.app.container.resolve(codeServiceToken),
        this.app.container.resolve(docFilesToken),
      );
    });
  }
}
