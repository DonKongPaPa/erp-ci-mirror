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

import { CODE_PREFIXES, codeServiceToken, type CodeService } from './codes.js';
import {
  stockMutationsToken,
  type DocReason,
  type DocType,
  type SourceType,
  type StockDocRecord,
  type StockMutations,
} from './inventory.js';

/**
 * R-021/R-022 MVP：采购与销售订单共用的读写服务。两套表、两个资源、两把授权，
 * 但数据形状与流程同构，所以实现只写一遍；调用方用 kind 指明是哪一边。
 *
 * 所有业务校验都在服务层（zod 只挡形状），这样无授权者在路由先拿到 403，
 * 拿到授权的人才有机会看到 404/422 的规则码。数量与金额是 decimal(18,4)，
 * JSON 边界统一转成 number。
 */
export type OrderKind = 'purchase' | 'sales';
export type OrderStatus =
  | 'draft'
  | 'ordered'
  | 'partially_received'
  | 'received'
  | 'partially_shipped'
  | 'shipped'
  | 'cancelled';

export type OrderRuleCode =
  | 'order-not-found'
  | 'not-draft'
  | 'not-cancellable'
  | 'not-issuable'
  | 'line-invalid'
  | 'line-duplicated'
  | 'lines-issued'
  | 'qty-exceeds'
  | 'empty-update'
  | 'partner-not-found'
  | 'partner-not-supplier'
  | 'partner-not-customer'
  | 'partner-inactive'
  | 'item-not-found'
  | 'item-inactive'
  | 'warehouse-not-found'
  | 'warehouse-inactive';

export class OrderRuleError extends Error {
  public constructor(
    readonly code: OrderRuleCode,
    readonly detail?: string,
  ) {
    super(detail === undefined ? `Order rule violated: ${code}` : `Order rule violated: ${code} (${detail})`);
    this.name = 'OrderRuleError';
  }
}

function fail(code: OrderRuleCode, detail?: string): never {
  throw new OrderRuleError(code, detail);
}

export interface PartnerSummary {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly status: 'active' | 'inactive';
}

export interface OrderLineView {
  readonly id: string;
  readonly orderId: string;
  readonly itemId: string;
  readonly qty: number;
  readonly price: number | null;
  readonly remainingQty: number;
  readonly receivedQty?: number;
  readonly shippedQty?: number;
}

export interface OrderHeaderView {
  readonly id: string;
  readonly orderNo: string;
  readonly orderDate: string;
  readonly status: OrderStatus;
  readonly remark: string;
  readonly submittedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly supplierId?: string;
  readonly customerId?: string;
}

export interface PurchaseOrderRecord extends OrderHeaderView {
  readonly supplierId: string;
  readonly supplier: PartnerSummary | null;
  readonly lines: readonly OrderLineView[];
}
export interface SalesOrderRecord extends OrderHeaderView {
  readonly customerId: string;
  readonly customer: PartnerSummary | null;
  readonly lines: readonly OrderLineView[];
}
export type OrderRecord = PurchaseOrderRecord | SalesOrderRecord;

/** 列表行不带明细与往来单位摘要。 */
export type OrderSummary = OrderHeaderView;

export interface PageQuery {
  readonly page: number;
  readonly pageSize: number;
}
export interface OrderListQuery extends PageQuery {
  readonly status?: OrderStatus;
  readonly q?: string;
  readonly partnerId?: string;
  readonly from?: string;
  readonly to?: string;
}
export interface Page<T> {
  readonly items: readonly T[];
  readonly total: number;
}

export interface LineInput {
  readonly itemId: string;
  readonly qty: number;
  readonly price?: number | null;
}
export interface CreateOrderInput {
  readonly partnerId: string;
  readonly orderDate: string;
  readonly remark?: string;
  readonly lines: readonly LineInput[];
}
export interface UpdateOrderInput {
  readonly partnerId?: string;
  readonly orderDate?: string;
  readonly remark?: string;
  readonly lines?: readonly LineInput[];
}
export interface IssueLineInput {
  readonly lineId: string;
  readonly qty: number;
}
export interface IssueInput {
  readonly warehouseId: string;
  readonly lines?: readonly IssueLineInput[];
}

interface OrderConfig {
  readonly headerCollection: string;
  readonly headerTable: string;
  readonly lineCollection: string;
  readonly lineTable: string;
  readonly headerPartner: string;
  readonly partnerKey: 'supplier' | 'customer';
  readonly partnerFlag: 'is_supplier' | 'is_customer';
  readonly wrongPartner: 'partner-not-supplier' | 'partner-not-customer';
  readonly prefix: string;
  readonly progressColumn: 'received_qty' | 'shipped_qty';
  readonly progressKey: 'receivedQty' | 'shippedQty';
  readonly completeStatus: 'received' | 'shipped';
  readonly partialStatus: 'partially_received' | 'partially_shipped';
  readonly issuable: readonly OrderStatus[];
  readonly docType: DocType;
  readonly reason: DocReason;
  readonly sourceType: SourceType;
}

const CONFIG: Readonly<Record<OrderKind, OrderConfig>> = {
  purchase: {
    headerCollection: 'purchaseOrders',
    headerTable: 'purchase_orders',
    lineCollection: 'purchaseOrderLines',
    lineTable: 'purchase_order_lines',
    headerPartner: 'supplier_id',
    partnerKey: 'supplier',
    partnerFlag: 'is_supplier',
    wrongPartner: 'partner-not-supplier',
    prefix: CODE_PREFIXES.purchaseOrder,
    progressColumn: 'received_qty',
    progressKey: 'receivedQty',
    completeStatus: 'received',
    partialStatus: 'partially_received',
    issuable: ['ordered', 'partially_received'],
    docType: 'in',
    reason: 'purchase_receipt',
    sourceType: 'purchase_order',
  },
  sales: {
    headerCollection: 'salesOrders',
    headerTable: 'sales_orders',
    lineCollection: 'salesOrderLines',
    lineTable: 'sales_order_lines',
    headerPartner: 'customer_id',
    partnerKey: 'customer',
    partnerFlag: 'is_customer',
    wrongPartner: 'partner-not-customer',
    prefix: CODE_PREFIXES.salesOrder,
    progressColumn: 'shipped_qty',
    progressKey: 'shippedQty',
    completeStatus: 'shipped',
    partialStatus: 'partially_shipped',
    issuable: ['ordered', 'partially_shipped'],
    docType: 'out',
    reason: 'sales_issue',
    sourceType: 'sales_order',
  },
};

const iso = (value: string | Date | null | undefined): string | null =>
  value === null || value === undefined
    ? null
    : value instanceof Date
      ? value.toISOString()
      : String(value);
const num = (value: unknown): number => Number(value);

/** pg 把 DATE 读成本地零点的 Date；用本地年月日取回 YYYY-MM-DD，不受进程时区偏移影响。 */
const dayString = (value: string | Date): string => {
  if (typeof value === 'string') return value.slice(0, 10);
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${value.getFullYear()}-${month}-${day}`;
};

async function countOf(base: Knex.QueryBuilder): Promise<number> {
  const row = (await base.clone().clear('select').count('* as count').first()) as
    | { count?: string | number }
    | undefined;
  return Number(row?.count ?? 0);
}

interface HeaderRow {
  id: string;
  order_no: string;
  supplier_id: string | null;
  customer_id: string | null;
  order_date: string | Date;
  status: string;
  remark: string;
  created_by_id: string;
  submitted_at: string | Date | null;
  created_at: string | Date;
  updated_at: string | Date;
}
interface LineRow {
  id: string;
  order_id: string;
  item_id: string;
  qty: string | number;
  price: string | number | null;
  received_qty: string | number;
  shipped_qty: string | number;
}
interface PartnerRow {
  id: string;
  code: string;
  name: string;
  status: string;
  is_supplier: boolean;
  is_customer: boolean;
}
interface TotalRow {
  item_id: string;
  qty: string | number;
}

function headerView(kind: OrderKind, row: HeaderRow): OrderHeaderView {
  const common = {
    id: row.id,
    orderNo: row.order_no,
    orderDate: dayString(row.order_date),
    status: row.status as OrderStatus,
    remark: row.remark,
    submittedAt: iso(row.submitted_at),
    createdAt: String(iso(row.created_at)),
    updatedAt: String(iso(row.updated_at)),
  };
  return kind === 'purchase'
    ? { ...common, supplierId: row.supplier_id ?? '' }
    : { ...common, customerId: row.customer_id ?? '' };
}

function partnerView(
  row: Pick<PartnerRow, 'id' | 'code' | 'name' | 'status'> | undefined,
): PartnerSummary | null {
  return row === undefined ? null : {
    id: row.id,
    code: row.code,
    name: row.name,
    status: row.status as PartnerSummary['status'],
  };
}

function lineView(
  kind: OrderKind,
  row: LineRow,
  remaining: number,
): OrderLineView {
  const common = {
    id: row.id,
    orderId: row.order_id,
    itemId: row.item_id,
    qty: num(row.qty),
    price: row.price === null ? null : num(row.price),
    remainingQty: remaining,
  };
  if (kind === 'purchase') {
    return { ...common, receivedQty: num(row.received_qty) };
  }
  return { ...common, shippedQty: num(row.shipped_qty) };
}

function validateLines(lines: readonly LineInput[]): void {
  if (lines.length === 0) return fail('line-invalid', 'empty');
  const seen = new Set<string>();
  for (const line of lines) {
    if (
      typeof line.itemId !== 'string' ||
      line.itemId.trim() === '' ||
      typeof line.qty !== 'number' ||
      !Number.isFinite(line.qty) ||
      line.qty <= 0 ||
      (line.price !== undefined &&
        line.price !== null &&
        (!Number.isFinite(line.price) || line.price < 0))
    ) {
      return fail('line-invalid');
    }
    if (seen.has(line.itemId)) return fail('line-duplicated', line.itemId);
    seen.add(line.itemId);
  }
}

async function assertItemsActive(knex: Knex, itemIds: readonly string[]): Promise<void> {
  const ids = [...new Set(itemIds)];
  if (ids.length === 0) return;
  const rows = await knex<{ id: string; status: string }>('items')
    .select('id', 'status')
    .whereIn('id', ids);
  const found = new Map(rows.map((row) => [row.id, row.status]));
  for (const id of ids) {
    if (!found.has(id)) return fail('item-not-found', id);
    if (found.get(id) !== 'active') return fail('item-inactive', id);
  }
}

/** 未作废库存单据已占用的数量；过账后行仍在，所以不会与 receivedQty 双重扣减。 */
async function issuedByItem(
  knex: Knex,
  kind: OrderKind,
  orderId: string,
): Promise<Map<string, number>> {
  const result = await knex.raw<{ rows?: readonly TotalRow[] }>(
    `select l.item_id, sum(l.qty) as qty
       from stock_doc_lines l
       join stock_docs d on d.id = l.doc_id
      where d.source_type = ? and d.source_id = ? and d.status <> 'void'
      group by l.item_id`,
    [CONFIG[kind].sourceType, orderId],
  );
  return new Map((result.rows ?? []).map((row) => [row.item_id, Number(row.qty)]));
}

export interface OrderReader {
  list(kind: OrderKind, query: OrderListQuery): Promise<Page<OrderSummary>>;
  detail(kind: OrderKind, id: string): Promise<OrderRecord | undefined>;
}

export interface OrderMutations {
  create(kind: OrderKind, input: CreateOrderInput, byUserId: string): Promise<OrderRecord>;
  update(kind: OrderKind, id: string, input: UpdateOrderInput): Promise<OrderRecord>;
  submit(kind: OrderKind, id: string): Promise<OrderRecord>;
  cancel(kind: OrderKind, id: string): Promise<OrderRecord>;
  issue(
    kind: OrderKind,
    id: string,
    input: IssueInput,
    byUserId: string,
  ): Promise<StockDocRecord>;
}

export class DatabaseOrderReader implements OrderReader {
  public constructor(private readonly database: DatabaseManager) {}

  private async knex(): Promise<Knex> {
    return await this.database.connection().client<Knex>();
  }

  public async list(kind: OrderKind, query: OrderListQuery): Promise<Page<OrderSummary>> {
    const config = CONFIG[kind];
    const knex = await this.knex();
    const base = knex<HeaderRow>(config.headerTable).modify((builder) => {
      if (query.status !== undefined) void builder.where('status', query.status);
      if (query.partnerId !== undefined) void builder.where(config.headerPartner, query.partnerId);
      if (query.q !== undefined && query.q !== '') {
        void builder.where((inner) => {
          inner
            .whereILike('order_no', `%${query.q}%`)
            .orWhereILike('remark', `%${query.q}%`)
            .orWhereExists((sub) => {
              sub
                .select('id')
                .from('partners')
                .whereRaw('partners.id = ??', [`${config.headerTable}.${config.headerPartner}`])
                .whereILike('name', `%${query.q}%`);
            });
        });
      }
      if (query.from !== undefined) void builder.where('created_at', '>=', query.from);
      if (query.to !== undefined) void builder.where('created_at', '<=', query.to);
    });
    const total = await countOf(base);
    const rows = (await base
      .clone()
      .orderBy('created_at', 'desc')
      .orderBy('id', 'asc')
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize)) as HeaderRow[];
    return { items: rows.map((row) => headerView(kind, row)), total };
  }

  public async detail(kind: OrderKind, id: string): Promise<OrderRecord | undefined> {
    const knex = await this.knex();
    return await readDetail(knex, kind, id);
  }
}

/** 读写两侧共用：读详情（含明细、往来单位摘要与剩余数量），可用事务连接。 */
async function readDetail(
  knex: Knex,
  kind: OrderKind,
  id: string,
): Promise<OrderRecord | undefined> {
  const config = CONFIG[kind];
  const row = await knex<HeaderRow>(config.headerTable).where({ id }).first();
  if (row === undefined) return undefined;
  const partnerId = kind === 'purchase' ? row.supplier_id : row.customer_id;
  const partner = partnerId === null
    ? undefined
    : await knex<PartnerRow>('partners')
      .select('id', 'code', 'name', 'status')
      .where({ id: partnerId })
      .first();
  const lines = await knex<LineRow>(config.lineTable)
    .where({ order_id: id })
    .orderBy('id', 'asc');
  const issued = await issuedByItem(knex, kind, id);
  const views = lines.map((line) => lineView(
    kind,
    line,
    Math.max(0, num(line.qty) - (issued.get(line.item_id) ?? 0)),
  ));
  const summary = headerView(kind, row);
  return kind === 'purchase'
    ? {
      ...summary,
      supplierId: row.supplier_id ?? '',
      supplier: partnerView(partner),
      lines: views,
    }
    : {
      ...summary,
      customerId: row.customer_id ?? '',
      customer: partnerView(partner),
      lines: views,
    };
}

export class DatabaseOrderMutations implements OrderMutations {
  public constructor(
    private readonly database: DatabaseManager,
    private readonly codes: CodeService,
    private readonly stock: StockMutations,
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

  private async requirePartner(
    knex: Knex,
    kind: OrderKind,
    partnerId: string,
  ): Promise<void> {
    const config = CONFIG[kind];
    const row = await knex<PartnerRow>('partners')
      .select('id', 'status', config.partnerFlag)
      .where({ id: partnerId })
      .first();
    if (row === undefined) return fail('partner-not-found', partnerId);
    if (row.status !== 'active') return fail('partner-inactive', partnerId);
    if (row[config.partnerFlag] !== true) return fail(config.wrongPartner, partnerId);
  }

  private async requireHeader(
    knex: Knex,
    kind: OrderKind,
    id: string,
  ): Promise<HeaderRow> {
    const row = await knex<HeaderRow>(CONFIG[kind].headerTable)
      .where({ id })
      .forUpdate()
      .first();
    if (row === undefined) return fail('order-not-found', id);
    return row;
  }

  private async insertLines(
    knex: Knex,
    kind: OrderKind,
    orderId: string,
    lines: readonly LineInput[],
  ): Promise<void> {
    const config = CONFIG[kind];
    for (const line of lines) {
      await knex(config.lineTable).insert({
        id: randomUUID(),
        order_id: orderId,
        item_id: line.itemId.trim(),
        qty: line.qty,
        price: line.price ?? null,
      });
    }
  }

  private async detailIn(
    knex: Knex,
    kind: OrderKind,
    id: string,
  ): Promise<OrderRecord> {
    const record = await readDetail(knex, kind, id);
    if (record === undefined) return fail('order-not-found', id);
    return record;
  }

  public async create(
    kind: OrderKind,
    input: CreateOrderInput,
    byUserId: string,
  ): Promise<OrderRecord> {
    validateLines(input.lines);
    return await this.inTransaction(undefined, async (tx) => {
      const knex = await this.knex(tx);
      await this.requirePartner(knex, kind, input.partnerId);
      await assertItemsActive(knex, input.lines.map((line) => line.itemId));
      const config = CONFIG[kind];
      const orderNo = await this.codes.nextCode(tx, config.prefix);
      const id = randomUUID();
      const now = new Date();
      await knex(config.headerTable).insert({
        id,
        order_no: orderNo,
        [config.headerPartner]: input.partnerId,
        order_date: input.orderDate,
        status: 'draft',
        remark: input.remark ?? '',
        created_by_id: byUserId,
        created_at: now,
        updated_at: now,
      });
      await this.insertLines(knex, kind, id, input.lines);
      return await this.detailIn(knex, kind, id);
    });
  }

  public async update(
    kind: OrderKind,
    id: string,
    input: UpdateOrderInput,
  ): Promise<OrderRecord> {
    return await this.inTransaction(undefined, async (tx) => {
      const knex = await this.knex(tx);
      const header = await this.requireHeader(knex, kind, id);
      if (header.status !== 'draft') return fail('not-draft');
      if (
        input.partnerId === undefined &&
        input.orderDate === undefined &&
        input.remark === undefined &&
        input.lines === undefined
      ) {
        return fail('empty-update');
      }
      if (input.partnerId !== undefined) {
        await this.requirePartner(knex, kind, input.partnerId);
      }
      if (input.lines !== undefined) {
        validateLines(input.lines);
        await assertItemsActive(knex, input.lines.map((line) => line.itemId));
      }
      const config = CONFIG[kind];
      await knex(config.headerTable).where({ id }).update({
        ...(input.partnerId === undefined ? {} : { [config.headerPartner]: input.partnerId }),
        ...(input.orderDate === undefined ? {} : { order_date: input.orderDate }),
        ...(input.remark === undefined ? {} : { remark: input.remark }),
        updated_at: new Date(),
      });
      if (input.lines !== undefined) {
        await knex(config.lineTable).where({ order_id: id }).delete();
        await this.insertLines(knex, kind, id, input.lines);
      }
      return await this.detailIn(knex, kind, id);
    });
  }

  public async submit(kind: OrderKind, id: string): Promise<OrderRecord> {
    return await this.inTransaction(undefined, async (tx) => {
      const knex = await this.knex(tx);
      const header = await this.requireHeader(knex, kind, id);
      if (header.status !== 'draft') return fail('not-draft');
      const at = new Date();
      await knex(CONFIG[kind].headerTable).where({ id }).update({
        status: 'ordered',
        submitted_at: at,
        updated_at: at,
      });
      return await this.detailIn(knex, kind, id);
    });
  }

  public async cancel(kind: OrderKind, id: string): Promise<OrderRecord> {
    return await this.inTransaction(undefined, async (tx) => {
      const knex = await this.knex(tx);
      const header = await this.requireHeader(knex, kind, id);
      if (
        header.status !== 'draft' &&
        header.status !== 'ordered' &&
        header.status !== CONFIG[kind].partialStatus
      ) {
        return fail('not-cancellable');
      }
      const linked = await knex<{ id: string }>('stock_docs')
        .select('id')
        .where('source_type', CONFIG[kind].sourceType)
        .where('source_id', id)
        .first();
      if (linked !== undefined) return fail('not-cancellable');
      await knex(CONFIG[kind].headerTable).where({ id }).update({
        status: 'cancelled',
        updated_at: new Date(),
      });
      return await this.detailIn(knex, kind, id);
    });
  }

  public async issue(
    kind: OrderKind,
    id: string,
    input: IssueInput,
    byUserId: string,
  ): Promise<StockDocRecord> {
    const config = CONFIG[kind];
    return await this.inTransaction(undefined, async (tx) => {
      const knex = await this.knex(tx);
      const header = await this.requireHeader(knex, kind, id);
      if (!config.issuable.includes(header.status as OrderStatus)) {
        return fail('not-issuable');
      }
      const warehouse = await knex<{ id: string; status: string }>('warehouses')
        .select('id', 'status')
        .where({ id: input.warehouseId })
        .first();
      if (warehouse === undefined) return fail('warehouse-not-found', input.warehouseId);
      if (warehouse.status !== 'active') return fail('warehouse-inactive', input.warehouseId);

      const orderLines = await knex<LineRow>(config.lineTable)
        .where({ order_id: id })
        .orderBy('id', 'asc');
      const issued = await issuedByItem(knex, kind, id);
      const remainingOf = new Map(
        orderLines.map((line) => [
          line.id,
          Math.max(0, num(line.qty) - (issued.get(line.item_id) ?? 0)),
        ]),
      );
      let selected: readonly IssueLineInput[];
      if (input.lines === undefined) {
        selected = orderLines
          .filter((line) => (remainingOf.get(line.id) ?? 0) > 0)
          .map((line) => ({ lineId: line.id, qty: remainingOf.get(line.id)! }));
      } else {
        const seen = new Set<string>();
        selected = input.lines.map((entry) => {
          if (seen.has(entry.lineId)) return fail('line-invalid', 'duplicate lineId');
          seen.add(entry.lineId);
          const remaining = remainingOf.get(entry.lineId);
          if (remaining === undefined) return fail('line-invalid', 'unknown lineId');
          if (!Number.isFinite(entry.qty) || entry.qty <= 0) return fail('line-invalid', 'qty');
          if (remaining <= 0) return fail('lines-issued', entry.lineId);
          if (entry.qty > remaining) return fail('qty-exceeds', entry.lineId);
          return entry;
        });
      }
      if (selected.length === 0) return fail('lines-issued');
      const items = selected.map((entry) =>
        orderLines.find((line) => line.id === entry.lineId)!.item_id,
      );
      await assertItemsActive(knex, items);
      return await this.stock.createDoc(
        {
          docType: config.docType,
          reason: config.reason,
          sourceType: config.sourceType,
          sourceId: id,
          lines: selected.map((entry) => ({
            itemId: orderLines.find((line) => line.id === entry.lineId)!.item_id,
            warehouseId: input.warehouseId,
            qty: entry.qty,
            batchNo: '',
          })),
        },
        byUserId,
        tx,
      );
    });
  }
}

export const orderReaderToken: ServiceToken<OrderReader> =
  createServiceToken<OrderReader>('app/order-reader');
export const orderMutationsToken: ServiceToken<OrderMutations> =
  createServiceToken<OrderMutations>('app/order-mutations');

export default class OrdersProvider extends ServiceProvider<Application> {
  public readonly name: string = 'app.orders';

  public override register(): void {
    this.app.container.singleton(orderReaderToken, () => {
      const database = this.app.container.resolve(databaseManagerToken);
      return new DatabaseOrderReader(database);
    });
    this.app.container.singleton(orderMutationsToken, () => {
      const database = this.app.container.resolve(databaseManagerToken);
      const codes = this.app.container.resolve(codeServiceToken);
      const stock = this.app.container.resolve(stockMutationsToken);
      return new DatabaseOrderMutations(database, codes, stock);
    });
  }
}
