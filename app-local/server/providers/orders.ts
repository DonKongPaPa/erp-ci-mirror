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
  AmountRuleError,
  computeHeaderAmounts,
  computeLineAmounts,
  type AmountLineResult,
} from './doc-amounts.js';
import { assertActiveCodes, BizDictRuleError } from './biz-dict.js';
import { docFilesToken, type DocFiles, type DocFileView } from './doc-files.js';
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
  | 'warehouse-inactive'
  | 'line-price-invalid'
  | 'discount-invalid'
  | 'dict-code-invalid'
  | 'person-invalid';

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
  /** 价格与金额只在持有 viewPrice 时出现在响应里；键不出现而不是 null。 */
  readonly price?: number | null;
  readonly taxExcludedPrice?: number | null;
  readonly taxExcludedAmount?: number | null;
  readonly taxAmount?: number | null;
  readonly taxIncludedAmount?: number | null;
  readonly taxRate?: number | null;
  readonly deliveryDate: string | null;
  readonly note: string | null;
  readonly remainingQty: number;
  readonly receivedQty?: number;
  readonly shippedQty?: number;
}

export interface PersonRef {
  readonly userId: string;
  readonly name: string;
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
  readonly warehouseId: string | null;
  readonly contactName: string | null;
  readonly contactPhone: string | null;
  readonly deliveryAddress: string | null;
  readonly settlementCode: string | null;
  readonly projectCode: string | null;
  readonly customerOrderNo?: string | null;
  /** R-021 波 1 加片：请购单回链，只对生成出来的采购订单有值。 */
  readonly purchaseRequestId?: string | null;
  /** D-077：来源请购单的单据号；没有来源的订单响应里没有这个键。 */
  readonly purchaseRequestDocNo?: string;
  readonly handlerUserId: string | null;
  readonly handler: PersonRef | null;
  /** R-022 复刻波 1：报价转出的订单才有值；老订单是 null。 */
  readonly quotationId?: string | null;
  readonly totalQty: number | null;
  readonly latestDeliveryDate: string | null;
  /** 以下键只在持有 viewPrice 时出现。 */
  readonly discountAmount?: number;
  readonly taxIncludedTotal?: number | null;
  readonly taxExcludedTotal?: number | null;
  readonly taxTotal?: number | null;
  readonly payableTotal?: number | null;
  readonly paidAmount: number;
  readonly invoicedAmount: number;
  /** R-065 复刻波 2：销售订单详情多一个已收金额；采购订单响应不变。 */
  readonly receivedAmount?: number;
}

export interface PurchaseOrderRecord extends OrderHeaderView {
  readonly supplierId: string;
  readonly supplier: PartnerSummary | null;
  readonly lines: readonly OrderLineView[];
  readonly files?: readonly DocFileView[];
}
export interface SalesOrderRecord extends OrderHeaderView {
  readonly customerId: string;
  readonly customer: PartnerSummary | null;
  readonly lines: readonly OrderLineView[];
  readonly files?: readonly DocFileView[];
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
  readonly dateField?: 'orderDate';
  readonly projectCode?: string;
  readonly handlerUserId?: string;
  readonly deliveryFrom?: string;
  readonly deliveryTo?: string;
}
export interface Page<T> {
  readonly items: readonly T[];
  readonly total: number;
}

/** 仓管「从订单选择」的窄形状：没有价格、金额、备注、经办人、项目、优惠。 */
export interface NarrowOrderLine {
  readonly id: string;
  readonly orderId: string;
  readonly itemId: string;
  readonly qty: number;
  readonly remainingQty: number;
  readonly receivedQty?: number;
  readonly shippedQty?: number;
  readonly deliveryDate: string | null;
  readonly item: {
    readonly id: string; readonly code: string; readonly name: string;
    readonly spec: string | null; readonly unitCode: string;
  };
}
export interface NarrowOrder {
  readonly id: string;
  readonly orderNo: string;
  readonly orderDate: string;
  readonly status: string;
  readonly warehouseId: string | null;
  readonly latestDeliveryDate: string | null;
  readonly contactName: string | null;
  readonly contactPhone: string | null;
  readonly supplier?: NarrowPartner | null;
  readonly customer?: NarrowPartner | null;
  readonly lines: readonly NarrowOrderLine[];
}
interface NarrowPartnerRow {
  id: string; code: string; name: string; contact_name: string | null; phone: string | null;
}
interface NarrowItemRow {
  id: string; code: string; name: string; spec: string | null; unit_code: string;
}

export interface NarrowPartner {
  readonly id: string; readonly code: string; readonly name: string;
  readonly contactName: string | null; readonly phone: string | null;
}

export interface LineInput {
  readonly itemId: string;
  readonly qty: number;
  readonly price?: number | null;
  readonly taxExcludedPrice?: number | null;
  readonly taxRate?: number | null;
  readonly deliveryDate?: string | null;
  readonly note?: string | null;
}
interface HeaderExtraInput {
  readonly warehouseId?: string | null;
  readonly contactName?: string | null;
  readonly contactPhone?: string | null;
  readonly deliveryAddress?: string | null;
  readonly settlementCode?: string | null;
  readonly projectCode?: string | null;
  readonly customerOrderNo?: string | null;
  readonly purchaseRequestId?: string | null;
  readonly handlerUserId?: string | null;
  readonly discountAmount?: number;
  readonly fileIds?: readonly string[];
  /** R-022 复刻波 1：只有报价单转出的订单有值；转单在同一个事务里带进来。 */
  readonly quotationId?: string | null;
}
export interface CreateOrderInput extends HeaderExtraInput {
  readonly partnerId: string;
  readonly orderDate: string;
  readonly remark?: string;
  readonly lines: readonly LineInput[];
}
export interface UpdateOrderInput extends HeaderExtraInput {
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

const nullIfDay = (value: string | Date | null): string | null =>
  value === null ? null : dayString(value);

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
  paid_amount: string | number;
  invoiced_amount: string | number;
  received_amount?: string | number;
  warehouse_id: string | null;
  contact_name: string | null;
  contact_phone: string | null;
  delivery_address: string | null;
  settlement_code: string | null;
  project_code: string | null;
  customer_order_no?: string | null;
  purchase_request_id: string | null;
  handler_user_id: string | null;
  quotation_id?: string | null;
  discount_amount: string | number;
  total_qty: string | number | null;
  tax_included_total: string | number | null;
  tax_excluded_total: string | number | null;
  tax_total: string | number | null;
  payable_total: string | number | null;
  latest_delivery_date: string | Date | null;
}
interface LineRow {
  id: string;
  order_id: string;
  item_id: string;
  qty: string | number;
  price: string | number | null;
  received_qty: string | number;
  shipped_qty: string | number;
  delivery_date: string | Date | null;
  tax_rate: string | number | null;
  tax_excluded_price: string | number | null;
  tax_excluded_amount: string | number | null;
  tax_amount: string | number | null;
  tax_included_amount: string | number | null;
  note: string | null;
}
interface UserRow { id: string; name: string | null; }
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

function headerView(
  kind: OrderKind,
  row: HeaderRow,
  handler: PersonRef | null,
  withPrice: boolean,
): OrderHeaderView {
  const common = {
    id: row.id,
    orderNo: row.order_no,
    orderDate: dayString(row.order_date),
    status: row.status as OrderStatus,
    remark: row.remark,
    submittedAt: iso(row.submitted_at),
    paidAmount: num(row.paid_amount ?? 0),
    invoicedAmount: num(row.invoiced_amount ?? 0),
    createdAt: String(iso(row.created_at)),
    updatedAt: String(iso(row.updated_at)),
    warehouseId: row.warehouse_id ?? null,
    contactName: row.contact_name ?? null,
    contactPhone: row.contact_phone ?? null,
    deliveryAddress: row.delivery_address ?? null,
    settlementCode: row.settlement_code ?? null,
    projectCode: row.project_code ?? null,
    handlerUserId: row.handler_user_id ?? null,
    handler,
    totalQty: row.total_qty === null || row.total_qty === undefined ? null : num(row.total_qty),
    latestDeliveryDate: row.latest_delivery_date === null || row.latest_delivery_date === undefined
      ? null
      : dayString(row.latest_delivery_date),
    ...(withPrice
      ? {
          discountAmount: num(row.discount_amount ?? 0),
          taxIncludedTotal: row.tax_included_total === null || row.tax_included_total === undefined ? null : num(row.tax_included_total),
          taxExcludedTotal: row.tax_excluded_total === null || row.tax_excluded_total === undefined ? null : num(row.tax_excluded_total),
          taxTotal: row.tax_total === null || row.tax_total === undefined ? null : num(row.tax_total),
          payableTotal: row.payable_total === null || row.payable_total === undefined ? null : num(row.payable_total),
        }
      : {}),
  };
  return kind === 'purchase'
    ? {
      ...common,
      supplierId: row.supplier_id ?? '',
      purchaseRequestId: row.purchase_request_id ?? null,
    }
    : {
      ...common,
      customerId: row.customer_id ?? '',
      customerOrderNo: row.customer_order_no ?? null,
      receivedAmount: num(row.received_amount ?? 0),
      // R-022 复刻波 1：没有来源的空值保持 null，老客户端形状不变（多一个空键）。
      quotationId: row.quotation_id ?? null,
    };
}

/** 只回账号标识与姓名；人员信息不进接口，邮箱、手机号一概不读。 */
async function handlersOf(
  knex: Knex,
  userIds: readonly (string | null)[],
): Promise<Map<string, PersonRef>> {
  const ids = [...new Set(userIds.filter((id): id is string => typeof id === 'string' && id !== ''))];
  if (ids.length === 0) return new Map();
  const rows = await knex<UserRow>('user').select('id', 'name').whereIn('id', ids);
  return new Map(rows.map((row) => [row.id, { userId: row.id, name: row.name ?? row.id }]));
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
  withPrice: boolean,
): OrderLineView {
  const common = {
    id: row.id,
    orderId: row.order_id,
    itemId: row.item_id,
    qty: num(row.qty),
    deliveryDate: row.delivery_date === null || row.delivery_date === undefined
      ? null
      : dayString(row.delivery_date),
    note: row.note ?? null,
    taxRate: row.tax_rate === null || row.tax_rate === undefined ? null : num(row.tax_rate),
    remainingQty: remaining,
    ...(withPrice
      ? {
          price: row.price === null || row.price === undefined ? null : num(row.price),
          taxExcludedPrice: row.tax_excluded_price === null || row.tax_excluded_price === undefined ? null : num(row.tax_excluded_price),
          taxExcludedAmount: row.tax_excluded_amount === null || row.tax_excluded_amount === undefined ? null : num(row.tax_excluded_amount),
          taxAmount: row.tax_amount === null || row.tax_amount === undefined ? null : num(row.tax_amount),
          taxIncludedAmount: row.tax_included_amount === null || row.tax_included_amount === undefined ? null : num(row.tax_included_amount),
        }
      : {}),
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

/** 金额与字典校验的调用方统一映射成自己的规则码，不复制算法。 */
function amountError(error: unknown): never {
  if (error instanceof AmountRuleError) fail(error.code, error.detail);
  throw error;
}

function computedAmounts(
  lines: readonly LineInput[],
): readonly AmountLineResult[] {
  try {
    return lines.map((line) => computeLineAmounts({
      qty: line.qty,
      price: line.price,
      taxExcludedPrice: line.taxExcludedPrice,
      taxRate: line.taxRate,
    }));
  } catch (error) {
    return amountError(error);
  }
}

function headerTotals(
  lines: readonly AmountLineResult[],
  discount: number,
) {
  try {
    return computeHeaderAmounts(lines, discount);
  } catch (error) {
    return amountError(error);
  }
}

function latestOf(lines: readonly LineInput[]): string | null {
  const days = lines
    .map((line) => line.deliveryDate)
    .filter((day): day is string => typeof day === 'string' && day !== '');
  return days.length === 0 ? null : days.reduce((a, b) => (a > b ? a : b));
}

async function assertOrderDicts(
  tx: DatabaseConnection,
  settlementCode?: string | null,
  projectCode?: string | null,
): Promise<void> {
  try {
    if (settlementCode) await assertActiveCodes(tx, 'settlement', [settlementCode]);
    if (projectCode) await assertActiveCodes(tx, 'project', [projectCode]);
  } catch (error) {
    if (error instanceof BizDictRuleError) fail('dict-code-invalid', error.code);
    throw error;
  }
}

/** 经办人显式给出时必须是 R-011 的在职员工。 */
async function requireActivePerson(knex: Knex, userId: string): Promise<void> {
  const row = await knex<{ user_id: string; status: string }>('employees')
    .select('status')
    .where({ user_id: userId })
    .first();
  if (row === undefined || row.status !== 'active') fail('person-invalid', userId);
}

/** 缺省经办人：登录人是在职员工才填，否则留空，不写一个后面过不了校验的值。 */
async function isActivePerson(knex: Knex, userId: string): Promise<boolean> {
  const row = await knex<{ user_id: string; status: string }>('employees')
    .select('user_id').where({ user_id: userId, status: 'active' }).first();
  return row !== undefined;
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
  list(kind: OrderKind, query: OrderListQuery, withPrice?: boolean): Promise<Page<OrderSummary>>;
  detail(kind: OrderKind, id: string, withPrice?: boolean): Promise<OrderRecord | undefined>;
  receivable(kind: OrderKind, query: OrderListQuery): Promise<Page<NarrowOrder>>;
}

export interface OrderMutations {
  /** 传入事务时复用调用方的事务（转单需要同一事务）；普通建单不传。 */
  create(
    kind: OrderKind, input: CreateOrderInput, byUserId: string,
    transaction?: DatabaseConnection,
  ): Promise<OrderRecord>;
  update(kind: OrderKind, id: string, input: UpdateOrderInput, byUserId?: string): Promise<OrderRecord>;
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
  public constructor(
    private readonly database: DatabaseManager,
    private readonly docFiles: DocFiles,
  ) {}

  private async knex(): Promise<Knex> {
    return await this.database.connection().client<Knex>();
  }

  public async list(
    kind: OrderKind,
    query: OrderListQuery,
    withPrice = false,
  ): Promise<Page<OrderSummary>> {
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
      const dateColumn = query.dateField === 'orderDate' ? 'order_date' : 'created_at';
      if (query.from !== undefined) void builder.where(dateColumn, '>=', query.from);
      if (query.to !== undefined) void builder.where(dateColumn, '<=', query.to);
      if (query.projectCode !== undefined) void builder.where('project_code', query.projectCode);
      if (query.handlerUserId !== undefined) void builder.where('handler_user_id', query.handlerUserId);
      if (query.deliveryFrom !== undefined) void builder.where('latest_delivery_date', '>=', query.deliveryFrom);
      if (query.deliveryTo !== undefined) void builder.where('latest_delivery_date', '<=', query.deliveryTo);
    });
    const total = await countOf(base);
    const rows = (await base
      .clone()
      .orderBy('created_at', 'desc')
      .orderBy('id', 'asc')
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize)) as HeaderRow[];
    const handlers = await handlersOf(knex, rows.map((row) => row.handler_user_id));
    return {
      items: rows.map((row) => headerView(
        kind,
        row,
        handlers.get(row.handler_user_id ?? '') ?? null,
        withPrice,
      )),
      total,
    };
  }

  public async detail(
    kind: OrderKind,
    id: string,
    withPrice = false,
  ): Promise<OrderRecord | undefined> {
    const knex = await this.knex();
    return await readDetail(knex, kind, id, withPrice, this.docFiles);
  }

  /** 待收货/待发货清单：只选窄形状需要的列，不碰价格与备注。 */
  public async receivable(
    kind: OrderKind,
    query: OrderListQuery,
  ): Promise<Page<NarrowOrder>> {
    const config = CONFIG[kind];
    const knex = await this.knex();
    const base = knex<HeaderRow>(config.headerTable).modify((builder) => {
      void builder.whereIn('status', [...config.issuable]);
      if (query.partnerId !== undefined) void builder.where(config.headerPartner, query.partnerId);
      if (query.q !== undefined && query.q !== '') {
        void builder.where((inner) => {
          inner.whereILike('order_no', `%${query.q}%`).orWhereExists((sub) => {
            sub.select('id').from('partners')
              .whereRaw('partners.id = ??', [`${config.headerTable}.${config.headerPartner}`])
              .whereILike('name', `%${query.q}%`);
          });
        });
      }
    });
    const all = (await base.clone().orderBy('created_at', 'desc').orderBy('id', 'asc')) as HeaderRow[];
    const items: NarrowOrder[] = [];
    for (const row of all) {
      const lines = await knex<LineRow>(config.lineTable)
        .where({ order_id: row.id }).orderBy('id', 'asc');
      const issued = await issuedByItem(knex, kind, row.id);
      const remainingOf = new Map(
        lines.map((line) => [line.id, Math.max(0, num(line.qty) - (issued.get(line.item_id) ?? 0))]),
      );
      const open = lines.filter((line) => (remainingOf.get(line.id) ?? 0) > 0);
      if (open.length === 0) continue;
      const partnerId = kind === 'purchase' ? row.supplier_id : row.customer_id;
      const partner = partnerId === null
        ? undefined
        : await knex<NarrowPartnerRow>('partners')
          .select('id', 'code', 'name', 'contact_name', 'phone').where({ id: partnerId }).first();
      const itemIds = [...new Set(open.map((line) => line.item_id))];
      const itemRows = (await knex('items')
        .select('id', 'code', 'name', 'spec', 'unit_code').whereIn('id', itemIds)) as readonly NarrowItemRow[];
      const byItem = new Map(itemRows.map((item) => [item.id, {
        id: item.id, code: item.code, name: item.name,
        spec: item.spec, unitCode: item.unit_code,
      }]));
      const narrowLines: NarrowOrderLine[] = open
        .filter((line) => byItem.has(line.item_id))
        .map((line) => ({
          id: line.id,
          orderId: line.order_id,
          itemId: line.item_id,
          qty: num(line.qty),
          ...(kind === 'purchase'
            ? { receivedQty: num(line.received_qty) }
            : { shippedQty: num(line.shipped_qty) }),
          remainingQty: remainingOf.get(line.id) ?? 0,
          deliveryDate: nullIfDay(line.delivery_date ?? null),
          item: byItem.get(line.item_id)!,
        }));
      const summary: NarrowOrder = {
        id: row.id,
        orderNo: row.order_no,
        orderDate: dayString(row.order_date),
        status: row.status,
        warehouseId: row.warehouse_id ?? null,
        latestDeliveryDate: nullIfDay(row.latest_delivery_date),
        contactName: row.contact_name ?? null,
        contactPhone: row.contact_phone ?? null,
        ...(kind === 'purchase'
          ? { supplier: partner ? {
            id: partner.id, code: partner.code, name: partner.name,
            contactName: partner.contact_name ?? null,
            phone: partner.phone ?? null,
          } : null }
          : { customer: partner ? {
            id: partner.id, code: partner.code, name: partner.name,
            contactName: partner.contact_name ?? null,
            phone: partner.phone ?? null,
          } : null }),
        lines: narrowLines,
      };
      items.push(summary);
    }
    const start = (query.page - 1) * query.pageSize;
    return { items: items.slice(start, start + query.pageSize), total: items.length };
  }
}

/** 读写两侧共用：读详情（含明细、往来单位摘要与剩余数量），可用事务连接。 */
async function readDetail(
  knex: Knex,
  kind: OrderKind,
  id: string,
  withPrice: boolean,
  docFiles: DocFiles,
): Promise<OrderRecord | undefined> {
  const config = CONFIG[kind];
  const row = await knex<HeaderRow>(config.headerTable).where({ id }).first();
  if (row === undefined) return undefined;
  // D-077：回链要显示请购单的单据号，不是内部编号；只在有来源时多查这一列。
  let purchaseRequestDocNo: string | null = null;
  if (kind === 'purchase' && row.purchase_request_id !== null && row.purchase_request_id !== undefined) {
    const request = await knex<{ id: string; doc_no: string }>('purchase_requests')
      .select('doc_no').where({ id: row.purchase_request_id }).first();
    purchaseRequestDocNo = request?.doc_no ?? null;
  }
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
  const handlers = await handlersOf(knex, [row.handler_user_id]);
  const views = lines.map((line) => lineView(
    kind,
    line,
    Math.max(0, num(line.qty) - (issued.get(line.item_id) ?? 0)),
    withPrice,
  ));
  const summary = headerView(
    kind,
    row,
    handlers.get(row.handler_user_id ?? '') ?? null,
    withPrice,
  );
  const fileViews = await docFiles.filesOf(knex, kind === 'purchase' ? 'purchase_order' : 'sales_order', id);
  return kind === 'purchase'
    ? {
      ...summary,
      supplierId: row.supplier_id ?? '',
      supplier: partnerView(partner),
      ...(purchaseRequestDocNo !== null ? { purchaseRequestDocNo } : {}),
      lines: views,
      files: fileViews,
    }
    : {
      ...summary,
      customerId: row.customer_id ?? '',
      customer: partnerView(partner),
      lines: views,
      files: fileViews,
    };
}

export class DatabaseOrderMutations implements OrderMutations {
  public constructor(
    private readonly database: DatabaseManager,
    private readonly codes: CodeService,
    private readonly stock: StockMutations,
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
    amounts: readonly AmountLineResult[],
  ): Promise<void> {
    const config = CONFIG[kind];
    for (const [index, line] of lines.entries()) {
      const amount = amounts[index];
      await knex(config.lineTable).insert({
        id: randomUUID(),
        order_id: orderId,
        item_id: line.itemId.trim(),
        qty: line.qty,
        price: amount.price,
        delivery_date: line.deliveryDate ?? null,
        tax_rate: amount.taxRate,
        tax_excluded_price: amount.taxExcludedPrice,
        tax_excluded_amount: amount.taxExcludedAmount,
        tax_amount: amount.taxAmount,
        tax_included_amount: amount.taxIncludedAmount,
        note: line.note ?? null,
      });
    }
  }

  private async detailIn(
    knex: Knex,
    kind: OrderKind,
    id: string,
  ): Promise<OrderRecord> {
    const record = await readDetail(knex, kind, id, true, this.docFiles);
    if (record === undefined) return fail('order-not-found', id);
    return record;
  }

  public async create(
    kind: OrderKind,
    input: CreateOrderInput,
    byUserId: string,
    transaction?: DatabaseConnection,
  ): Promise<OrderRecord> {
    validateLines(input.lines);
    return await this.inTransaction(transaction, async (tx) => {
      const knex = await this.knex(tx);
      await this.requirePartner(knex, kind, input.partnerId);
      await assertItemsActive(knex, input.lines.map((line) => line.itemId));
      if (input.warehouseId !== undefined && input.warehouseId !== null) {
        const warehouse = await knex<{ id: string; status: string }>('warehouses')
          .select('status').where({ id: input.warehouseId }).first();
        if (warehouse === undefined) fail('warehouse-not-found', input.warehouseId);
        if (warehouse.status !== 'active') fail('warehouse-inactive', input.warehouseId);
      }
      await assertOrderDicts(tx, input.settlementCode, input.projectCode);
      let handlerUserId: string | null = null;
      if (input.handlerUserId !== undefined && input.handlerUserId !== null) {
        await requireActivePerson(knex, input.handlerUserId);
        handlerUserId = input.handlerUserId;
      } else if (input.handlerUserId === undefined && await isActivePerson(knex, byUserId)) {
        handlerUserId = byUserId;
      }
      const amounts = computedAmounts(input.lines);
      const totals = headerTotals(amounts, input.discountAmount ?? 0);
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
        warehouse_id: input.warehouseId ?? null,
        contact_name: input.contactName ?? null,
        contact_phone: input.contactPhone ?? null,
        delivery_address: input.deliveryAddress ?? null,
        settlement_code: input.settlementCode ?? null,
        project_code: input.projectCode ?? null,
        ...(config.headerPartner === 'customer_id'
          ? {
            customer_order_no: input.customerOrderNo ?? null,
            quotation_id: input.quotationId ?? null,
          }
          : {}),
        ...(kind === 'purchase'
          ? { purchase_request_id: input.purchaseRequestId ?? null }
          : {}),
        handler_user_id: handlerUserId,
        discount_amount: totals.discountAmount,
        total_qty: totals.totalQty,
        tax_included_total: totals.taxIncludedTotal,
        tax_excluded_total: totals.taxExcludedTotal,
        tax_total: totals.taxTotal,
        payable_total: totals.payableTotal,
        latest_delivery_date: latestOf(input.lines),
        created_at: now,
        updated_at: now,
      });
      await this.insertLines(knex, kind, id, input.lines, amounts);
      await this.docFiles.bind(
        knex, kind === 'purchase' ? 'purchase_order' : 'sales_order', id, input.fileIds, byUserId,
      );
      return await this.detailIn(knex, kind, id);
    });
  }

  public async update(
    kind: OrderKind,
    id: string,
    input: UpdateOrderInput,
    byUserId: string,
  ): Promise<OrderRecord> {
    return await this.inTransaction(undefined, async (tx) => {
      const knex = await this.knex(tx);
      const header = await this.requireHeader(knex, kind, id);
      if (header.status !== 'draft') return fail('not-draft');
      if (
        input.partnerId === undefined &&
        input.orderDate === undefined &&
        input.remark === undefined &&
        input.lines === undefined &&
        input.warehouseId === undefined &&
        input.contactName === undefined &&
        input.contactPhone === undefined &&
        input.deliveryAddress === undefined &&
        input.settlementCode === undefined &&
        input.projectCode === undefined &&
        input.customerOrderNo === undefined &&
        input.handlerUserId === undefined &&
        input.discountAmount === undefined &&
        input.fileIds === undefined
      ) {
        return fail('empty-update');
      }
      if (input.partnerId !== undefined) {
        await this.requirePartner(knex, kind, input.partnerId);
      }
      if (input.warehouseId !== undefined && input.warehouseId !== null) {
        const warehouse = await knex<{ id: string; status: string }>('warehouses')
          .select('status').where({ id: input.warehouseId }).first();
        if (warehouse === undefined) fail('warehouse-not-found', input.warehouseId);
        if (warehouse.status !== 'active') fail('warehouse-inactive', input.warehouseId);
      }
      await assertOrderDicts(tx, input.settlementCode, input.projectCode);
      if (input.handlerUserId !== undefined && input.handlerUserId !== null) {
        await requireActivePerson(knex, input.handlerUserId);
      }
      let amounts: readonly AmountLineResult[] | undefined;
      if (input.lines !== undefined) {
        validateLines(input.lines);
        await assertItemsActive(knex, input.lines.map((line) => line.itemId));
        amounts = computedAmounts(input.lines);
      }
      const config = CONFIG[kind];
      const patch: Record<string, unknown> = {
        ...(input.partnerId === undefined ? {} : { [config.headerPartner]: input.partnerId }),
        ...(input.orderDate === undefined ? {} : { order_date: input.orderDate }),
        ...(input.remark === undefined ? {} : { remark: input.remark }),
        ...(input.warehouseId === undefined ? {} : { warehouse_id: input.warehouseId }),
        ...(input.contactName === undefined ? {} : { contact_name: input.contactName }),
        ...(input.contactPhone === undefined ? {} : { contact_phone: input.contactPhone }),
        ...(input.deliveryAddress === undefined ? {} : { delivery_address: input.deliveryAddress }),
        ...(input.settlementCode === undefined ? {} : { settlement_code: input.settlementCode }),
        ...(input.projectCode === undefined ? {} : { project_code: input.projectCode }),
        ...(input.customerOrderNo === undefined ? {} : { customer_order_no: input.customerOrderNo }),
        ...(input.handlerUserId === undefined ? {} : { handler_user_id: input.handlerUserId }),
        updated_at: new Date(),
      };
      if (input.lines !== undefined) {
        await knex(config.lineTable).where({ order_id: id }).delete();
        await this.insertLines(knex, kind, id, input.lines, amounts ?? []);
      }
      // 头上合计每次都按最终行重算：改优惠、改行都能保持不变量。
      const finalLines = await this.linesAsInputs(knex, kind, id);
      const totals = headerTotals(
        computedAmounts(finalLines),
        input.discountAmount ?? num(header.discount_amount ?? 0),
      );
      await knex(config.headerTable).where({ id }).update({
        ...patch,
        discount_amount: totals.discountAmount,
        total_qty: totals.totalQty,
        tax_included_total: totals.taxIncludedTotal,
        tax_excluded_total: totals.taxExcludedTotal,
        tax_total: totals.taxTotal,
        payable_total: totals.payableTotal,
        latest_delivery_date: latestOf(finalLines),
      });
      await this.docFiles.bind(
        knex, kind === 'purchase' ? 'purchase_order' : 'sales_order', id, input.fileIds, byUserId,
      );
      return await this.detailIn(knex, kind, id);
    });
  }

  /** 从库里的最终行还原金额输入；存的是已算好的列，重算结果与原值一致。 */
  private async linesAsInputs(
    knex: Knex,
    kind: OrderKind,
    orderId: string,
  ): Promise<readonly LineInput[]> {
    const rows = await knex<LineRow>(CONFIG[kind].lineTable)
      .where({ order_id: orderId })
      .orderBy('id', 'asc');
    return rows.map((row) => ({
      itemId: row.item_id,
      qty: num(row.qty),
      price: row.price === null || row.price === undefined ? null : num(row.price),
      taxExcludedPrice: row.tax_excluded_price === null || row.tax_excluded_price === undefined ? null : num(row.tax_excluded_price),
      taxRate: row.tax_rate === null || row.tax_rate === undefined ? null : num(row.tax_rate),
      deliveryDate: row.delivery_date === null || row.delivery_date === undefined ? null : dayString(row.delivery_date),
      note: row.note,
    }));
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
      const today = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
      }).format(new Date());
      // 生成的草稿带头的联系信息与经办人（当前操作人，不是订单上的经办人），
      // 以及算过金额的行带来的含税单价与税率；没算金额的行不带价格。
      return await this.stock.createDoc(
        {
          docType: config.docType,
          reason: config.reason,
          sourceType: config.sourceType,
          sourceId: id,
          docDate: today,
          partnerId: (kind === 'purchase' ? header.supplier_id : header.customer_id) ?? null,
          contactName: header.contact_name,
          contactPhone: header.contact_phone,
          deliveryAddress: header.delivery_address,
          customerOrderNo: kind === 'sales' ? header.customer_order_no : null,
          projectCode: header.project_code,
          lines: selected.map((entry) => {
            const line = orderLines.find((row) => row.id === entry.lineId)!;
            const priced = line.tax_rate !== null && line.tax_rate !== undefined;
            return {
              itemId: line.item_id,
              warehouseId: input.warehouseId,
              qty: entry.qty,
              batchNo: '',
              ...(priced
                ? {
                    taxIncludedPrice: line.price === null ? null : num(line.price),
                    taxRate: num(line.tax_rate),
                    taxExcludedPrice: line.tax_excluded_price === null ? null : num(line.tax_excluded_price),
                  }
                : {}),
            };
          }),
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
      return new DatabaseOrderReader(database, this.app.container.resolve(docFilesToken));
    });
    this.app.container.singleton(orderMutationsToken, () => {
      const database = this.app.container.resolve(databaseManagerToken);
      const codes = this.app.container.resolve(codeServiceToken);
      const stock = this.app.container.resolve(stockMutationsToken);
      return new DatabaseOrderMutations(database, codes, stock, this.app.container.resolve(docFilesToken));
    });
  }
}
