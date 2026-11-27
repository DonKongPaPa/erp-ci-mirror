import type { Application } from '@nocobase/app-server/application';
import {
  databaseManagerToken,
  isUniqueConstraintViolation,
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
import { syncOrderProgress } from './order-progress.js';

/**
 * R-020 MVP：仓库、单据、现存量与流水的读写服务。
 *
 * 过账是唯一的库存写入口：事务里先锁单据头，再逐行锁现存量行（没有就先插零行再锁），
 * 入加出减，写带过账后余额的流水，最后把单据置 posted。出库不够抛 `insufficient`，
 * 整单回滚。两个并发过账因此串行，余额不会变负。
 *
 * 单据引用的物料在 main 的 `items` 表里：`assertItemsActive()` 校验物料存在且在用，
 * 不合法抛 item-not-found / item-inactive。库存维度只存 id 字符串，不存物料快照。
 */
export type StockRuleCode =
  | 'warehouse-invalid'
  | 'warehouse-code-exists'
  | 'warehouse-not-found'
  | 'warehouse-code-immutable'
  | 'warehouse-inactive'
  | 'item-inactive'
  | 'item-not-found'
  | 'line-invalid'
  | 'doc-invalid'
  | 'doc-reason-invalid'
  | 'doc-not-found'
  | 'doc-not-draft'
  | 'insufficient'
  | 'empty-update'
  | 'source-required'
  | 'source-invalid'
  | 'source-line-invalid'
  | 'source-qty-exceeds'
  | 'source-not-allowed'
  | 'taker-required'
  | 'partner-mismatch'
  | 'line-price-invalid'
  | 'discount-invalid'
  | 'dict-code-invalid'
  | 'person-invalid';

export class StockRuleError extends Error {
  public constructor(
    readonly code: StockRuleCode,
    readonly detail?: string,
  ) {
    super(detail ?? `Stock rule violated: ${code}`);
    this.name = 'StockRuleError';
  }
}

function fail(code: StockRuleCode, detail?: string): never {
  throw new StockRuleError(code, detail);
}

export type DocType = 'in' | 'out';
export type DocStatus = 'draft' | 'posted' | 'void';
export type DocReason =
  | 'purchase_receipt'
  | 'production_receipt'
  | 'sales_return'
  | 'other_in'
  | 'sales_issue'
  | 'internal_use'
  | 'purchase_return'
  | 'other_out';
export type SourceType = 'purchase_order' | 'sales_order';
export type WarehouseStatus = 'active' | 'inactive';

export interface WarehouseRecord {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly status: WarehouseStatus;
  readonly note: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface PersonRef { readonly userId: string; readonly name: string; }
export interface PartnerRef {
  readonly id: string; readonly code: string; readonly name: string;
}
export interface DepartmentRef { readonly id: string; readonly name: string; }

export interface StockDocLineRecord {
  readonly id: string;
  readonly docId: string;
  readonly itemId: string;
  readonly warehouseId: string;
  readonly batchNo: string;
  readonly qty: number;
  readonly productionDate: string | null;
  readonly expiryDate: string | null;
  readonly note: string | null;
  readonly taxRate: number | null;
  /** 价格与金额只在持有 stockPriceView 时出现。 */
  readonly taxIncludedPrice?: number | null;
  readonly taxExcludedPrice?: number | null;
  readonly taxExcludedAmount?: number | null;
  readonly taxAmount?: number | null;
  readonly taxIncludedAmount?: number | null;
}

export interface StockDocRecord {
  readonly id: string;
  readonly docNo: string;
  readonly docType: DocType;
  readonly reason: DocReason;
  readonly status: DocStatus;
  readonly remark: string;
  readonly sourceType: SourceType | null;
  readonly sourceId: string | null;
  readonly createdById: string;
  readonly postedAt: string | null;
  readonly postedById: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly docDate: string | null;
  readonly partnerId: string | null;
  readonly contactName: string | null;
  readonly contactPhone: string | null;
  readonly deliveryAddress: string | null;
  readonly customerOrderNo: string | null;
  readonly projectCode: string | null;
  readonly handlerUserId: string | null;
  readonly handler: PersonRef | null;
  readonly takerDepartmentId: string | null;
  readonly takerUserId: string | null;
  readonly taker: PersonRef | null;
  readonly takerDepartment: DepartmentRef | null;
  readonly partner: PartnerRef | null;
  readonly totalQty: number | null;
  /** 价格与金额只在持有 stockPriceView 时出现。 */
  readonly discountAmount?: number;
  readonly taxIncludedTotal?: number | null;
  readonly taxExcludedTotal?: number | null;
  readonly taxTotal?: number | null;
  readonly payableTotal?: number | null;
  /** 回链列只在生成单据上出现；普通单据的响应与波 0 加片前一致。 */
  readonly stocktakingId?: string;
  readonly transferDocId?: string;
  readonly files?: readonly DocFileView[];
  readonly lines: readonly StockDocLineRecord[];
}

export interface BalanceRecord {
  readonly itemId: string;
  readonly warehouseId: string;
  readonly batchNo: string;
  readonly qty: number;
}

export interface TransactionRecord {
  readonly id: string;
  readonly docId: string;
  readonly docLineId: string;
  readonly docNo: string;
  readonly itemId: string;
  readonly warehouseId: string;
  readonly batchNo: string;
  readonly qtyDelta: number;
  readonly balanceAfter: number;
  readonly at: string;
  readonly byUserId: string;
}

export interface PageQuery {
  readonly page: number;
  readonly pageSize: number;
}
export interface WarehouseListQuery extends PageQuery {
  readonly status?: WarehouseStatus;
  readonly q?: string;
}
export interface DocListQuery extends PageQuery {
  readonly docType?: DocType;
  readonly status?: DocStatus;
  readonly q?: string;
  readonly from?: string;
  readonly to?: string;
  readonly dateField?: 'docDate';
  readonly reason?: DocReason;
  readonly partnerId?: string;
  readonly projectCode?: string;
  readonly handlerUserId?: string;
  readonly takerDepartmentId?: string;
  readonly stocktakingId?: string;
  readonly transferDocId?: string;
}
export interface BalanceListQuery extends PageQuery {
  readonly itemId?: string;
  readonly warehouseId?: string;
  readonly q?: string;
}
export interface TransactionListQuery extends PageQuery {
  readonly itemId?: string;
  readonly warehouseId?: string;
  readonly from?: string;
  readonly to?: string;
}
export interface Page<T> {
  readonly items: readonly T[];
  readonly total: number;
}

export interface CreateWarehouseInput {
  readonly code: string;
  readonly name: string;
  readonly status?: WarehouseStatus;
  readonly note?: string;
}
export interface UpdateWarehouseInput {
  readonly name?: string;
  readonly status?: WarehouseStatus;
  readonly note?: string;
}
export interface StockLineInput {
  readonly itemId: string;
  readonly warehouseId: string;
  readonly batchNo?: string;
  readonly qty: number;
  readonly taxIncludedPrice?: number | null;
  readonly taxExcludedPrice?: number | null;
  readonly taxRate?: number | null;
  readonly productionDate?: string | null;
  readonly expiryDate?: string | null;
  readonly note?: string | null;
}
interface DocExtraInput {
  readonly docDate?: string | null;
  readonly partnerId?: string | null;
  readonly contactName?: string | null;
  readonly contactPhone?: string | null;
  readonly deliveryAddress?: string | null;
  readonly customerOrderNo?: string | null;
  readonly projectCode?: string | null;
  readonly handlerUserId?: string | null;
  readonly takerDepartmentId?: string | null;
  readonly takerUserId?: string | null;
  readonly discountAmount?: number;
  readonly fileIds?: readonly string[];
  readonly stocktakingId?: string;
  readonly transferDocId?: string;
}
export interface CreateDocInput extends DocExtraInput {
  readonly docType: DocType;
  readonly reason: DocReason;
  readonly remark?: string;
  readonly sourceType?: SourceType;
  readonly sourceId?: string;
  readonly lines: readonly StockLineInput[];
}
export interface UpdateDocInput extends DocExtraInput {
  readonly remark?: string;
  readonly reason?: DocReason;
  readonly sourceType?: SourceType;
  readonly sourceId?: string;
  readonly lines: readonly StockLineInput[];
}

export interface StockReader {
  listWarehouses(query: WarehouseListQuery): Promise<Page<WarehouseRecord>>;
  detailWarehouse(id: string): Promise<WarehouseRecord | undefined>;
  listDocs(query: DocListQuery, withPrice?: boolean): Promise<Page<Omit<StockDocRecord, 'lines'>>>;
  detailDoc(id: string, withPrice?: boolean): Promise<StockDocRecord | undefined>;
  listBalances(query: BalanceListQuery): Promise<Page<BalanceRecord>>;
  listTransactions(query: TransactionListQuery): Promise<Page<TransactionRecord>>;
}

export interface StockMutations {
  createWarehouse(
    input: CreateWarehouseInput,
    transaction?: DatabaseConnection,
  ): Promise<WarehouseRecord>;
  updateWarehouse(
    id: string,
    input: UpdateWarehouseInput,
    transaction?: DatabaseConnection,
  ): Promise<WarehouseRecord>;
  createDoc(
    input: CreateDocInput,
    byUserId: string,
    transaction?: DatabaseConnection,
  ): Promise<StockDocRecord>;
  updateDoc(id: string, input: UpdateDocInput, byUserId: string): Promise<StockDocRecord>;
  post(id: string, byUserId: string, transaction?: DatabaseConnection): Promise<StockDocRecord>;
  void(id: string, byUserId: string): Promise<StockDocRecord>;
}

const iso = (value: string | Date | null | undefined): string | null =>
  value === null || value === undefined
    ? null
    : value instanceof Date
      ? value.toISOString()
      : String(value);
const num = (value: unknown): number => Number(value);

/** pg 把 DATE 读成本地零点的 Date；用本地年月日取回 YYYY-MM-DD。 */
function dayString(value: string | Date): string {
  if (typeof value === 'string') return value.slice(0, 10);
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${value.getFullYear()}-${month}-${day}`;
}

/** 新建不传单据日期时按 Asia/Shanghai 的当天填；不依赖进程时区。 */
function today(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

/** knex 的 clone()/raw() 都回 any；在边界处显式标注形状，不让 any 流进业务代码。 */
async function countOf(base: Knex.QueryBuilder): Promise<number> {
  const row = (await base.clone().clear('select').count('* as count').first()) as
    | { count?: string | number }
    | undefined;
  return Number(row?.count ?? 0);
}

interface WarehouseRow {
  id: string;
  code: string;
  name: string;
  status: string;
  note: string;
  created_at: string | Date;
  updated_at: string | Date;
}
interface DocRow {
  id: string;
  doc_no: string;
  doc_type: string;
  reason: string;
  status: string;
  remark: string;
  source_type: string | null;
  source_id: string | null;
  created_by_id: string;
  posted_at: string | Date | null;
  posted_by_id: string | null;
  created_at: string | Date;
  updated_at: string | Date;
  doc_date: string | Date | null;
  partner_id: string | null;
  contact_name: string | null;
  contact_phone: string | null;
  delivery_address: string | null;
  customer_order_no: string | null;
  project_code: string | null;
  handler_user_id: string | null;
  taker_department_id: string | null;
  taker_user_id: string | null;
  discount_amount: string | number;
  total_qty: string | number | null;
  tax_included_total: string | number | null;
  tax_excluded_total: string | number | null;
  tax_total: string | number | null;
  payable_total: string | number | null;
  stocktaking_id: string | null;
  transfer_doc_id: string | null;
}
interface LineRow {
  id: string;
  doc_id: string;
  item_id: string;
  warehouse_id: string;
  batch_no: string;
  qty: string | number;
  production_date: string | Date | null;
  expiry_date: string | Date | null;
  note: string | null;
  tax_rate: string | number | null;
  tax_included_price: string | number | null;
  tax_excluded_price: string | number | null;
  tax_excluded_amount: string | number | null;
  tax_amount: string | number | null;
  tax_included_amount: string | number | null;
}
interface RefRow { id: string; name: string | null; code?: string; }
interface Refs {
  handlers: Map<string, PersonRef>;
  partners: Map<string, PartnerRef>;
  departments: Map<string, DepartmentRef>;
}
interface BalanceRow {
  item_id: string;
  warehouse_id: string;
  batch_no: string;
  qty: string | number;
}
interface TransactionRow {
  id: string;
  doc_id: string;
  doc_line_id: string;
  doc_no: string;
  item_id: string;
  warehouse_id: string;
  batch_no: string;
  qty_delta: string | number;
  balance_after: string | number;
  at: string | Date;
  by_user_id: string;
}

function warehouseView(row: WarehouseRow): WarehouseRecord {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    status: row.status as WarehouseStatus,
    note: row.note,
    createdAt: String(iso(row.created_at)),
    updatedAt: String(iso(row.updated_at)),
  };
}

const nullIfDate = (value: string | Date | null | undefined): string | null =>
  value === null || value === undefined ? null : dayString(value);
const nullableNum = (value: string | number | null | undefined): number | null =>
  value === null || value === undefined ? null : num(value);

function lineView(row: LineRow, withPrice: boolean): StockDocLineRecord {
  return {
    id: row.id,
    docId: row.doc_id,
    itemId: row.item_id,
    warehouseId: row.warehouse_id,
    batchNo: row.batch_no,
    qty: num(row.qty),
    productionDate: nullIfDate(row.production_date),
    expiryDate: nullIfDate(row.expiry_date),
    note: row.note ?? null,
    taxRate: nullableNum(row.tax_rate),
    ...(withPrice
      ? {
          taxIncludedPrice: nullableNum(row.tax_included_price),
          taxExcludedPrice: nullableNum(row.tax_excluded_price),
          taxExcludedAmount: nullableNum(row.tax_excluded_amount),
          taxAmount: nullableNum(row.tax_amount),
          taxIncludedAmount: nullableNum(row.tax_included_amount),
        }
      : {}),
  };
}

/** 人员只回账号标识与姓名，部门只回标识与名称，往来单位只回三列。 */
async function refsOf(knex: Knex, rows: readonly DocRow[]): Promise<Refs> {
  const ids = (pick: (row: DocRow) => string | null): string[] =>
    [...new Set(rows.map(pick).filter((id): id is string => typeof id === 'string' && id !== ''))];
  const handlerIds = [
    ...new Set([...ids((row) => row.handler_user_id), ...ids((row) => row.taker_user_id)]),
  ];
  const partnerIds = ids((row) => row.partner_id);
  const departmentIds = ids((row) => row.taker_department_id);
  const [users, partners, departments] = await Promise.all([
    handlerIds.length === 0
      ? []
      : knex<RefRow>('user').select('id', 'name').whereIn('id', handlerIds),
    partnerIds.length === 0
      ? []
      : knex<RefRow & { code: string }>('partners').select('id', 'code', 'name').whereIn('id', partnerIds),
    departmentIds.length === 0
      ? []
      : knex<{ id: string; title: string }>('departments').select('id', 'title').whereIn('id', departmentIds),
  ]);
  const handlerMap = new Map(users.map((row) => [row.id, { userId: row.id, name: row.name ?? row.id }]));
  for (const id of handlerIds) {
    if (!handlerMap.has(id)) handlerMap.set(id, { userId: id, name: id });
  }
  return {
    handlers: handlerMap,
    partners: new Map(partners.map((row) => [row.id, { id: row.id, code: row.code, name: row.name ?? '' }])),
    departments: new Map(departments.map((row) => [row.id, { id: row.id, name: row.title }])),
  };
}

function docView(
  row: DocRow,
  lines: readonly LineRow[],
  refs: Refs,
  withPrice: boolean,
): StockDocRecord {
  return {
    id: row.id,
    docNo: row.doc_no,
    docType: row.doc_type as DocType,
    reason: row.reason as DocReason,
    status: row.status as DocStatus,
    remark: row.remark,
    sourceType: row.source_type as SourceType | null,
    sourceId: row.source_id,
    createdById: row.created_by_id,
    postedAt: iso(row.posted_at),
    postedById: row.posted_by_id,
    createdAt: String(iso(row.created_at)),
    updatedAt: String(iso(row.updated_at)),
    docDate: nullIfDate(row.doc_date),
    partnerId: row.partner_id,
    contactName: row.contact_name,
    contactPhone: row.contact_phone,
    deliveryAddress: row.delivery_address,
    customerOrderNo: row.customer_order_no,
    projectCode: row.project_code,
    handlerUserId: row.handler_user_id,
    handler: refs.handlers.get(row.handler_user_id ?? '') ?? null,
    takerDepartmentId: row.taker_department_id,
    takerUserId: row.taker_user_id,
    taker: refs.handlers.get(row.taker_user_id ?? '') ?? null,
    takerDepartment: refs.departments.get(row.taker_department_id ?? '') ?? null,
    partner: refs.partners.get(row.partner_id ?? '') ?? null,
    totalQty: nullableNum(row.total_qty),
    ...(row.stocktaking_id === null ? {} : { stocktakingId: row.stocktaking_id }),
    ...(row.transfer_doc_id === null ? {} : { transferDocId: row.transfer_doc_id }),
    ...(withPrice
      ? {
          discountAmount: num(row.discount_amount ?? 0),
          taxIncludedTotal: nullableNum(row.tax_included_total),
          taxExcludedTotal: nullableNum(row.tax_excluded_total),
          taxTotal: nullableNum(row.tax_total),
          payableTotal: nullableNum(row.payable_total),
        }
      : {}),
    lines: lines.map((line) => lineView(line, withPrice)),
  };
}

/** 列表行不带明细：详情才带。两处视图不共用，免得列表无意间把明细也带出来。 */
function docSummaryView(row: DocRow, refs: Refs, withPrice: boolean): Omit<StockDocRecord, 'lines'> {
  const { lines: _lines, ...summary } = docView(row, [], refs, withPrice);
  return summary;
}

function balanceView(row: BalanceRow): BalanceRecord {
  return {
    itemId: row.item_id,
    warehouseId: row.warehouse_id,
    batchNo: row.batch_no,
    qty: num(row.qty),
  };
}

function transactionView(row: TransactionRow): TransactionRecord {
  return {
    id: row.id,
    docId: row.doc_id,
    docLineId: row.doc_line_id,
    docNo: row.doc_no,
    itemId: row.item_id,
    warehouseId: row.warehouse_id,
    batchNo: row.batch_no,
    qtyDelta: num(row.qty_delta),
    balanceAfter: num(row.balance_after),
    at: String(iso(row.at)),
    byUserId: row.by_user_id,
  };
}

const WAREHOUSE_CODE = /^[A-Z0-9][A-Z0-9_-]{0,31}$/u;
const DOC_TYPES = ['in', 'out'] as const;
const REASONS = [
  'purchase_receipt', 'production_receipt', 'sales_return', 'other_in',
  'sales_issue', 'internal_use', 'purchase_return', 'other_out',
] as const;
const SOURCE_TYPES = ['purchase_order', 'sales_order'] as const;
const WAREHOUSE_STATUSES = ['active', 'inactive'] as const;
const IN_REASONS: readonly DocReason[] = [
  'purchase_receipt', 'production_receipt', 'sales_return', 'other_in',
];
const OUT_REASONS: readonly DocReason[] = [
  'sales_issue', 'internal_use', 'purchase_return', 'other_out',
];
const SOURCE_ALLOWED: readonly DocReason[] = ['purchase_receipt', 'sales_issue'];

function validateWarehouseCode(input: string): string {
  const code = input.trim();
  if (!WAREHOUSE_CODE.test(code)) return fail('warehouse-invalid', 'code');
  return code;
}
function validateWarehouseName(input: string): string {
  const name = input.trim();
  if (name.length < 1 || name.length > 128) return fail('warehouse-invalid', 'name');
  return name;
}
function validateWarehouseStatus(input: string | undefined): WarehouseStatus {
  const status = input ?? 'active';
  if (!WAREHOUSE_STATUSES.includes(status as WarehouseStatus)) {
    return fail('warehouse-invalid', 'status');
  }
  return status as WarehouseStatus;
}
function validateNote(input: string | undefined): string {
  const note = input ?? '';
  if (note.length > 500) return fail('warehouse-invalid', 'note');
  return note;
}

function validateDoc(input: CreateDocInput | UpdateDocInput, docType?: DocType): void {
  if (docType !== undefined && !DOC_TYPES.includes(docType)) {
    return fail('doc-invalid', 'docType');
  }
  const reason = input.reason;
  if (reason !== undefined && !REASONS.includes(reason)) {
    return fail('doc-invalid', 'reason');
  }
  if (docType !== undefined && reason !== undefined) {
    const allowed = docType === 'in' ? IN_REASONS : OUT_REASONS;
    if (!allowed.includes(reason)) return fail('doc-reason-invalid');
  }
  const hasSourceType = input.sourceType !== undefined;
  const hasSourceId = input.sourceId !== undefined;
  if (hasSourceType !== hasSourceId) return fail('doc-invalid', 'source');
  if (hasSourceType && !SOURCE_TYPES.includes(input.sourceType)) {
    return fail('doc-invalid', 'sourceType');
  }
  if (input.remark !== undefined && input.remark.length > 1000) {
    return fail('doc-invalid', 'remark');
  }
  validateLines(input.lines);
}

function validateLines(lines: readonly StockLineInput[]): void {
  if (lines.length === 0) return fail('line-invalid', 'empty');
  for (const line of lines) {
    if (
      typeof line.itemId !== 'string' ||
      line.itemId.trim() === '' ||
      typeof line.warehouseId !== 'string' ||
      line.warehouseId.trim() === '' ||
      typeof line.qty !== 'number' ||
      !Number.isFinite(line.qty) ||
      line.qty <= 0 ||
      (line.batchNo ?? '').length > 64 ||
      (line.note ?? '').length > 500
    ) {
      return fail('line-invalid');
    }
    if (
      line.productionDate !== undefined && line.productionDate !== null &&
      line.expiryDate !== undefined && line.expiryDate !== null &&
      line.expiryDate < line.productionDate
    ) {
      return fail('line-invalid', 'expiry-before-production');
    }
  }
}

function amountError(error: unknown): never {
  if (error instanceof AmountRuleError) fail(error.code, error.detail);
  throw error;
}

function computedAmounts(lines: readonly StockLineInput[]): readonly AmountLineResult[] {
  try {
    return lines.map((line) => computeLineAmounts({
      qty: line.qty,
      price: line.taxIncludedPrice,
      taxExcludedPrice: line.taxExcludedPrice,
      taxRate: line.taxRate,
    }));
  } catch (error) {
    return amountError(error);
  }
}

function headerTotals(lines: readonly AmountLineResult[], discount: number) {
  try {
    return computeHeaderAmounts(lines, discount);
  } catch (error) {
    return amountError(error);
  }
}

async function assertStockDicts(tx: DatabaseConnection, projectCode?: string | null): Promise<void> {
  if (!projectCode) return;
  try {
    await assertActiveCodes(tx, 'project', [projectCode]);
  } catch (error) {
    if (error instanceof BizDictRuleError) fail('dict-code-invalid', error.code);
    throw error;
  }
}

async function requireActivePerson(knex: Knex, userId: string): Promise<void> {
  const row = await knex<{ user_id: string; status: string }>('employees')
    .select('user_id', 'status').where({ user_id: userId }).first();
  if (row === undefined || row.status !== 'active') fail('person-invalid', userId);
}

async function requireDepartment(knex: Knex, departmentId: string): Promise<void> {
  const row = await knex<{ id: string; active: boolean }>('departments')
    .select('id', 'active').where({ id: departmentId }).first();
  if (row === undefined || row.active !== true) fail('person-invalid', departmentId);
}

/** 对方与原因必须相合；内部领用与生产入库不允许带往来单位。 */
async function assertPartnerReason(
  knex: Knex,
  reason: DocReason,
  partnerId?: string | null,
): Promise<void> {
  if (partnerId === undefined || partnerId === null) return;
  const partner = await knex<{ id: string; is_supplier: boolean; is_customer: boolean }>('partners')
    .select('is_supplier', 'is_customer').where({ id: partnerId }).first();
  if (partner === undefined) return fail('partner-mismatch', partnerId);
  const supplier = ['purchase_receipt', 'purchase_return'].includes(reason);
  const customer = ['sales_issue', 'sales_return'].includes(reason);
  const forbidden = ['production_receipt', 'internal_use'].includes(reason);
  if (forbidden || (supplier && partner.is_supplier !== true) ||
      (customer && partner.is_customer !== true) ||
      (!supplier && !customer && partner.is_supplier !== true && partner.is_customer !== true)) {
    return fail('partner-mismatch', partnerId);
  }
}

/** R2：带来源的单据，行必须在来源订单里，累计数量不超过订单剩余。 */
async function assertSourceRules(
  knex: Knex,
  input: CreateDocInput | UpdateDocInput,
  excludeDocId?: string,
): Promise<void> {
  if (input.reason !== undefined && !SOURCE_ALLOWED.includes(input.reason) && input.sourceType !== undefined) {
    return fail('source-not-allowed', input.reason);
  }
  if (input.sourceType === undefined || input.sourceId === undefined) return;
  const config = input.sourceType === 'purchase_order'
    ? { header: 'purchase_orders', lines: 'purchase_order_lines' }
    : { header: 'sales_orders', lines: 'sales_order_lines' };
  const header = await knex<{ id: string; status: string }>(config.header)
    .select('id', 'status').where({ id: input.sourceId }).first();
  if (header === undefined || header.status === 'cancelled') return fail('source-invalid', input.sourceId);
  const orderLines = await knex<{ item_id: string; order_id: string; qty: string | number }>(config.lines)
    .select('item_id', 'qty').where({ order_id: input.sourceId });
  const ordered = new Map(orderLines.map((line) => [line.item_id, num(line.qty)]));
  const issuedRows = await knex.raw<{ rows?: readonly { item_id: string; qty: string | number }[] }>(
    `select l.item_id, sum(l.qty) as qty
       from stock_doc_lines l join stock_docs d on d.id = l.doc_id
      where d.source_type = ? and d.source_id = ? and d.status <> 'void' and d.id <> ?
      group by l.item_id`,
    [input.sourceType, input.sourceId, excludeDocId ?? ''],
  );
  const issued = new Map((issuedRows.rows ?? []).map((row) => [row.item_id, num(row.qty)]));
  const wanted = new Map<string, number>();
  for (const line of input.lines) {
    if (!ordered.has(line.itemId)) return fail('source-line-invalid', line.itemId);
    wanted.set(line.itemId, (wanted.get(line.itemId) ?? 0) + line.qty);
  }
  for (const [itemId, qty] of wanted) {
    if (qty > Math.max(0, (ordered.get(itemId) ?? 0) - (issued.get(itemId) ?? 0))) {
      return fail('source-qty-exceeds', itemId);
    }
  }
}

/**
 * 物料在 main 的 `items` 表里：单据行引用的物料必须存在且在用。
 * 规则码与物料服务保持一致（item-not-found / item-inactive），端点映射成
 * ITEM_NOT_FOUND / ITEM_INACTIVE。
 */
async function assertItemsActive(
  knex: Knex,
  itemIds: readonly string[],
): Promise<void> {
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

export class DatabaseStockReader implements StockReader {
  public constructor(
    private readonly database: DatabaseManager,
    private readonly docFiles: DocFiles,
  ) {}

  private async knex(): Promise<Knex> {
    return await this.database.connection().client<Knex>();
  }

  public async listWarehouses(query: WarehouseListQuery): Promise<Page<WarehouseRecord>> {
    const knex = await this.knex();
    const where: Record<string, unknown> = {};
    if (query.status !== undefined) where.status = query.status;
    const rows = (await knex<WarehouseRow>('warehouses')
      .where(where)
      .modify((builder) => {
        if (query.q !== undefined && query.q !== '') {
          void builder.where((inner) => {
            inner
              .whereILike('code', `%${query.q}%`)
              .orWhereILike('name', `%${query.q}%`);
          });
        }
      })
      .orderBy('code', 'asc')) as WarehouseRow[];
    const total = rows.length;
    const start = (query.page - 1) * query.pageSize;
    return {
      items: rows.slice(start, start + query.pageSize).map(warehouseView),
      total,
    };
  }

  public async detailWarehouse(id: string): Promise<WarehouseRecord | undefined> {
    const knex = await this.knex();
    const row = await knex<WarehouseRow>('warehouses').where({ id }).first();
    return row === undefined ? undefined : warehouseView(row);
  }

  public async listDocs(
    query: DocListQuery,
    withPrice = false,
  ): Promise<Page<Omit<StockDocRecord, 'lines'>>> {
    const knex = await this.knex();
    const base = knex<DocRow>('stock_docs').modify((builder) => {
      if (query.docType !== undefined) void builder.where('doc_type', query.docType);
      if (query.status !== undefined) void builder.where('status', query.status);
      if (query.q !== undefined && query.q !== '') {
        void builder.where((inner) => {
          inner
            .whereILike('doc_no', `%${query.q}%`)
            .orWhereILike('remark', `%${query.q}%`);
        });
      }
      const dateColumn = query.dateField === 'docDate' ? 'doc_date' : 'created_at';
      if (query.from !== undefined) void builder.where(dateColumn, '>=', query.from);
      if (query.to !== undefined) void builder.where(dateColumn, '<=', query.to);
      if (query.reason !== undefined) void builder.where('reason', query.reason);
      if (query.partnerId !== undefined) void builder.where('partner_id', query.partnerId);
      if (query.projectCode !== undefined) void builder.where('project_code', query.projectCode);
      if (query.handlerUserId !== undefined) void builder.where('handler_user_id', query.handlerUserId);
      if (query.takerDepartmentId !== undefined) void builder.where('taker_department_id', query.takerDepartmentId);
      if (query.stocktakingId !== undefined) void builder.where('stocktaking_id', query.stocktakingId);
      if (query.transferDocId !== undefined) void builder.where('transfer_doc_id', query.transferDocId);
    });
    const total = await countOf(base);
    const rows = (await base
      .clone()
      .orderBy('created_at', 'desc')
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize)) as DocRow[];
    const refs = await refsOf(knex, rows);
    return { items: rows.map((row) => docSummaryView(row, refs, withPrice)), total };
  }

  public async detailDoc(id: string, withPrice = false): Promise<StockDocRecord | undefined> {
    const knex = await this.knex();
    const row = await knex<DocRow>('stock_docs').where({ id }).first();
    if (row === undefined) return undefined;
    const lines = await knex<LineRow>('stock_doc_lines')
      .where({ doc_id: id })
      .orderBy('id', 'asc');
    const refs = await refsOf(knex, [row]);
    const doc = docView(row, lines, refs, withPrice);
    return { ...doc, files: await this.docFiles.filesOf(knex, 'stock_doc', id) };
  }

  public async listBalances(query: BalanceListQuery): Promise<Page<BalanceRecord>> {
    const knex = await this.knex();
    const base = knex<BalanceRow>('stock_balances').modify((builder) => {
      if (query.itemId !== undefined) void builder.where('item_id', query.itemId);
      if (query.warehouseId !== undefined) void builder.where('warehouse_id', query.warehouseId);
      if (query.q !== undefined && query.q !== '') {
        void builder.whereILike('batch_no', `%${query.q}%`);
      }
    });
    const total = await countOf(base);
    const rows = (await base
      .clone()
      .orderBy('item_id', 'asc')
      .orderBy('warehouse_id', 'asc')
      .orderBy('batch_no', 'asc')
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize)) as BalanceRow[];
    return { items: rows.map(balanceView), total };
  }

  public async listTransactions(query: TransactionListQuery): Promise<Page<TransactionRecord>> {
    const knex = await this.knex();
    const base = knex<TransactionRow>('stock_transactions').modify((builder) => {
      if (query.itemId !== undefined) void builder.where('item_id', query.itemId);
      if (query.warehouseId !== undefined) void builder.where('warehouse_id', query.warehouseId);
      if (query.from !== undefined) void builder.where('at', '>=', query.from);
      if (query.to !== undefined) void builder.where('at', '<=', query.to);
    });
    const total = await countOf(base);
    const rows = (await base
      .clone()
      .orderBy('at', 'desc')
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize)) as TransactionRow[];
    return { items: rows.map(transactionView), total };
  }
}

export class DatabaseStockMutations implements StockMutations {
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

  public async createWarehouse(
    input: CreateWarehouseInput,
    transaction?: DatabaseConnection,
  ): Promise<WarehouseRecord> {
    const code = validateWarehouseCode(input.code);
    const name = validateWarehouseName(input.name);
    const status = validateWarehouseStatus(input.status);
    const note = validateNote(input.note);
    const now = new Date();
    const connection = transaction ?? this.database.connection();
    try {
      await connection.query
        .insertInto('warehouses')
        .values({ id: randomUUID(), code, name, status, note, createdAt: now, updatedAt: now })
        .execute();
    } catch (error) {
      if (isUniqueConstraintViolation(error)) return fail('warehouse-code-exists');
      throw error;
    }
    const knex = await this.knex(transaction);
    const row = await knex<WarehouseRow>('warehouses').where({ code }).first();
    return warehouseView(row!);
  }

  public async updateWarehouse(
    id: string,
    input: UpdateWarehouseInput,
    transaction?: DatabaseConnection,
  ): Promise<WarehouseRecord> {
    if (input.name === undefined && input.status === undefined && input.note === undefined) {
      return fail('empty-update');
    }
    if (input.name !== undefined) validateWarehouseName(input.name);
    if (input.status !== undefined) validateWarehouseStatus(input.status);
    if (input.note !== undefined) validateNote(input.note);
    const knex = await this.knex(transaction);
    const result = await knex<WarehouseRow>('warehouses').where({ id }).update({
      ...(input.name === undefined ? {} : { name: input.name.trim() }),
      ...(input.status === undefined ? {} : { status: input.status }),
      ...(input.note === undefined ? {} : { note: input.note }),
      updated_at: new Date(),
    });
    if (result === 0) return fail('warehouse-not-found');
    const row = await knex<WarehouseRow>('warehouses').where({ id }).first();
    return warehouseView(row!);
  }

  private async requireWarehouses(knex: Knex, lines: readonly StockLineInput[]): Promise<void> {
    const ids = [...new Set(lines.map((line) => line.warehouseId))];
    if (ids.length === 0) return;
    const rows = await knex<{ id: string; status: string }>('warehouses')
      .select('id', 'status')
      .whereIn('id', ids);
    const found = new Map(rows.map((row) => [row.id, row.status]));
    for (const line of lines) {
      if (!found.has(line.warehouseId)) return fail('warehouse-not-found');
      if (found.get(line.warehouseId) !== 'active') return fail('warehouse-inactive');
    }
  }

  public async createDoc(
    input: CreateDocInput,
    byUserId: string,
    transaction?: DatabaseConnection,
  ): Promise<StockDocRecord> {
    validateDoc(input, input.docType);
    return await this.inTransaction(transaction, async (tx) => {
      const knex = await this.knex(tx);
      await this.requireWarehouses(knex, input.lines);
      await assertItemsActive(knex, input.lines.map((line) => line.itemId));
      await assertPartnerReason(knex, input.reason, input.partnerId);
      await assertSourceRules(knex, input);
      await assertStockDicts(tx, input.projectCode);
      const handlerUserId = input.handlerUserId ?? byUserId;
      if (input.handlerUserId !== undefined && input.handlerUserId !== null) {
        await requireActivePerson(knex, handlerUserId);
      }
      if (input.takerUserId !== undefined && input.takerUserId !== null) {
        await requireActivePerson(knex, input.takerUserId);
      }
      if (input.takerDepartmentId !== undefined && input.takerDepartmentId !== null) {
        await requireDepartment(knex, input.takerDepartmentId);
      }
      const amounts = computedAmounts(input.lines);
      const totals = headerTotals(amounts, input.discountAmount ?? 0);
      const now = new Date();
      const docNo = await this.codes.nextCode(
        tx,
        input.docType === 'in' ? CODE_PREFIXES.inbound : CODE_PREFIXES.outbound,
      );
      const id = randomUUID();
      await knex('stock_docs').insert({
        id,
        doc_no: docNo,
        doc_type: input.docType,
        reason: input.reason,
        status: 'draft',
        remark: input.remark ?? '',
        source_type: input.sourceType ?? null,
        source_id: input.sourceId ?? null,
        created_by_id: byUserId,
        doc_date: input.docDate ?? today(),
        partner_id: input.partnerId ?? null,
        contact_name: input.contactName ?? null,
        contact_phone: input.contactPhone ?? null,
        delivery_address: input.deliveryAddress ?? null,
        customer_order_no: input.customerOrderNo ?? null,
        project_code: input.projectCode ?? null,
        handler_user_id: handlerUserId,
        taker_department_id: input.takerDepartmentId ?? null,
        taker_user_id: input.takerUserId ?? null,
        discount_amount: totals.discountAmount,
        total_qty: totals.totalQty,
        tax_included_total: totals.taxIncludedTotal,
        tax_excluded_total: totals.taxExcludedTotal,
        tax_total: totals.taxTotal,
        payable_total: totals.payableTotal,
        stocktaking_id: input.stocktakingId ?? null,
        transfer_doc_id: input.transferDocId ?? null,
        created_at: now,
        updated_at: now,
      });
      await this.insertLines(knex, id, input.lines, amounts);
      await this.docFiles.bind(knex, 'stock_doc', id, input.fileIds, byUserId);
      return await this.detailIn(tx, id, true, this.docFiles);
    });
  }

  public async updateDoc(
    id: string,
    input: UpdateDocInput,
    byUserId: string,
  ): Promise<StockDocRecord> {
    return await this.inTransaction(undefined, async (tx) => {
      const knex = await this.knex(tx);
      // 先看单据状态，再校验内容：已过账的草稿无论带什么内容都回 doc-not-draft。
      await this.requireDraft(knex, id);
      validateDoc(input);
      await this.requireWarehouses(knex, input.lines);
      await assertItemsActive(knex, input.lines.map((line) => line.itemId));
      const current = await knex<DocRow>('stock_docs').where({ id }).first();
      if (current === undefined) return fail('doc-not-found');
      const effectiveReason: DocReason = input.reason ?? (current.reason as DocReason);
      // 库里的 null 表示没有来源；按 undefined 处理，不能让补丁把「没带」误判成「带了」。
      const effectiveSourceType = input.sourceType === undefined
        ? (current.source_type ?? undefined) as SourceType | undefined
        : input.sourceType;
      const effectiveSourceId = input.sourceId === undefined ? (current.source_id ?? undefined) : input.sourceId;
      await assertPartnerReason(knex, effectiveReason,
        input.partnerId === undefined ? current.partner_id : input.partnerId);
      await assertSourceRules(
        knex,
        { ...input, reason: effectiveReason, sourceType: effectiveSourceType, sourceId: effectiveSourceId },
        id,
      );
      await assertStockDicts(tx, input.projectCode);
      if (input.handlerUserId !== undefined && input.handlerUserId !== null) {
        await requireActivePerson(knex, input.handlerUserId);
      }
      if (input.takerUserId !== undefined && input.takerUserId !== null) {
        await requireActivePerson(knex, input.takerUserId);
      }
      if (input.takerDepartmentId !== undefined && input.takerDepartmentId !== null) {
        await requireDepartment(knex, input.takerDepartmentId);
      }
      await knex('stock_docs').where({ id }).update({
        ...(input.reason === undefined ? {} : { reason: input.reason }),
        ...(input.remark === undefined ? {} : { remark: input.remark }),
        ...(input.sourceType === undefined ? {} : { source_type: input.sourceType }),
        ...(input.sourceId === undefined ? {} : { source_id: input.sourceId }),
        ...(input.docDate === undefined ? {} : { doc_date: input.docDate }),
        ...(input.partnerId === undefined ? {} : { partner_id: input.partnerId }),
        ...(input.contactName === undefined ? {} : { contact_name: input.contactName }),
        ...(input.contactPhone === undefined ? {} : { contact_phone: input.contactPhone }),
        ...(input.deliveryAddress === undefined ? {} : { delivery_address: input.deliveryAddress }),
        ...(input.customerOrderNo === undefined ? {} : { customer_order_no: input.customerOrderNo }),
        ...(input.projectCode === undefined ? {} : { project_code: input.projectCode }),
        ...(input.handlerUserId === undefined ? {} : { handler_user_id: input.handlerUserId }),
        ...(input.takerDepartmentId === undefined ? {} : { taker_department_id: input.takerDepartmentId }),
        ...(input.takerUserId === undefined ? {} : { taker_user_id: input.takerUserId }),
        updated_at: new Date(),
      });
      await knex('stock_doc_lines').where({ doc_id: id }).delete();
      await this.insertLines(knex, id, input.lines, computedAmounts(input.lines));
      const finalLines = await this.linesAsInputs(knex, id);
      const header = await knex<DocRow>('stock_docs').where({ id }).first();
      if (header === undefined) return fail('doc-not-found');
      const totals = headerTotals(
        computedAmounts(finalLines),
        input.discountAmount ?? num(header.discount_amount ?? 0),
      );
      await knex('stock_docs').where({ id }).update({
        discount_amount: totals.discountAmount,
        total_qty: totals.totalQty,
        tax_included_total: totals.taxIncludedTotal,
        tax_excluded_total: totals.taxExcludedTotal,
        tax_total: totals.taxTotal,
        payable_total: totals.payableTotal,
      });
      await this.docFiles.bind(knex, 'stock_doc', id, input.fileIds, byUserId);
      return await this.detailIn(tx, id, true, this.docFiles);
    });
  }

  public async post(
    id: string,
    byUserId: string,
    transaction?: DatabaseConnection,
  ): Promise<StockDocRecord> {
    return await this.inTransaction(transaction, async (tx) => {
      const knex = await this.knex(tx);
      const header = await this.requireDraft(knex, id);
      // R1：销售出库过账必须有来源销售订单，而且订单还在可发货状态。
      if (header.reason === 'sales_issue') {
        if (header.source_type !== 'sales_order' || header.source_id === null) {
          return fail('source-required', id);
        }
        const order = await knex<{ id: string; status: string }>('sales_orders')
          .select('status').where({ id: header.source_id }).first();
        if (order === undefined || !['ordered', 'partially_shipped'].includes(order.status)) {
          return fail('source-invalid', header.source_id);
        }
      }
      // R3：内部领用必须有领用部门与领用人。
      if (header.reason === 'internal_use' &&
          (header.taker_department_id === null || header.taker_user_id === null)) {
        return fail('taker-required', id);
      }
      const lines = await knex<LineRow>('stock_doc_lines')
        .where({ doc_id: id })
        .orderBy('id', 'asc');
      const at = new Date();
      for (const line of lines) {
        // 没有现存量行就先插零行；ON CONFLICT 会等到另一事务提交后才继续。
        await knex.raw(
          `insert into stock_balances (item_id, warehouse_id, batch_no, qty)
           values (?, ?, ?, 0) on conflict do nothing`,
          [line.item_id, line.warehouse_id, line.batch_no],
        );
        const locked = await knex.raw<{ rows?: readonly { qty: string | number }[] }>(
          `select qty from stock_balances
            where item_id = ? and warehouse_id = ? and batch_no = ? for update`,
          [line.item_id, line.warehouse_id, line.batch_no],
        );
        const balanceRow = locked.rows?.[0];
        if (balanceRow === undefined) return fail('insufficient', line.item_id);
        const before = num(balanceRow.qty);
        const delta = header.doc_type === 'in' ? num(line.qty) : -num(line.qty);
        const after = before + delta;
        if (after < 0) return fail('insufficient', line.item_id);
        await knex('stock_balances')
          .where({
            item_id: line.item_id,
            warehouse_id: line.warehouse_id,
            batch_no: line.batch_no,
          })
          .update({ qty: after });
        await knex('stock_transactions').insert({
          id: randomUUID(),
          doc_id: id,
          doc_line_id: line.id,
          doc_no: header.doc_no,
          item_id: line.item_id,
          warehouse_id: line.warehouse_id,
          batch_no: line.batch_no,
          qty_delta: delta,
          balance_after: after,
          at,
          by_user_id: byUserId,
        });
      }
      await knex('stock_docs').where({ id }).update({
        status: 'posted',
        posted_at: at,
        posted_by_id: byUserId,
        updated_at: at,
      });
      // R-021/R-022：来源单据是订单时，在同一个事务里回写订单进度。
      await syncOrderProgress(knex, header);
      return await this.detailIn(tx, id, true, this.docFiles);
    });
  }

  public async void(id: string, _byUserId: string): Promise<StockDocRecord> {
    return await this.inTransaction(undefined, async (tx) => {
      const knex = await this.knex(tx);
      await this.requireDraft(knex, id);
      await knex('stock_docs').where({ id }).update({
        status: 'void',
        updated_at: new Date(),
      });
      return await this.detailIn(tx, id, true, this.docFiles);
    });
  }

  private async requireDraft(
    knex: Knex,
    id: string,
  ): Promise<{
    doc_no: string;
    doc_type: string;
    status: string;
    reason: string;
    source_type: string | null;
    source_id: string | null;
    taker_department_id: string | null;
    taker_user_id: string | null;
  }> {
    const result = await knex.raw<{
      rows?: readonly {
        doc_no: string;
        doc_type: string;
        status: string;
        reason: string;
        source_type: string | null;
        source_id: string | null;
        taker_department_id: string | null;
        taker_user_id: string | null;
      }[];
    }>(
      `select doc_no, doc_type, status, reason, source_type, source_id,
              taker_department_id, taker_user_id from stock_docs where id = ? for update`,
      [id],
    );
    const row = result.rows?.[0];
    if (row === undefined) return fail('doc-not-found');
    if (row.status !== 'draft') return fail('doc-not-draft');
    return row;
  }

  private async insertLines(
    knex: Knex,
    docId: string,
    lines: readonly StockLineInput[],
    amounts: readonly AmountLineResult[],
  ): Promise<void> {
    for (const [index, line] of lines.entries()) {
      const amount = amounts[index];
      await knex('stock_doc_lines').insert({
        id: randomUUID(),
        doc_id: docId,
        item_id: line.itemId.trim(),
        warehouse_id: line.warehouseId.trim(),
        batch_no: line.batchNo ?? '',
        qty: line.qty,
        tax_included_price: amount.taxRate === null ? null : (amount.price ?? line.taxIncludedPrice ?? null),
        tax_excluded_price: amount.taxExcludedPrice,
        tax_rate: amount.taxRate,
        tax_excluded_amount: amount.taxExcludedAmount,
        tax_amount: amount.taxAmount,
        tax_included_amount: amount.taxIncludedAmount,
        production_date: line.productionDate ?? null,
        expiry_date: line.expiryDate ?? null,
        note: line.note ?? null,
      });
    }
  }

  /** 从库里的最终行还原金额输入，改草稿后头上合计能重算。 */
  private async linesAsInputs(knex: Knex, docId: string): Promise<readonly StockLineInput[]> {
    const rows = await knex<LineRow>('stock_doc_lines')
      .where({ doc_id: docId }).orderBy('id', 'asc');
    return rows.map((row) => ({
      itemId: row.item_id,
      warehouseId: row.warehouse_id,
      batchNo: row.batch_no,
      qty: num(row.qty),
      taxIncludedPrice: nullableNum(row.tax_included_price),
      taxExcludedPrice: nullableNum(row.tax_excluded_price),
      taxRate: nullableNum(row.tax_rate),
      productionDate: nullIfDate(row.production_date),
      expiryDate: nullIfDate(row.expiry_date),
      note: row.note,
    }));
  }

  private async detailIn(
    tx: DatabaseConnection,
    id: string,
    withPrice = true,
    docFiles?: DocFiles,
  ): Promise<StockDocRecord> {
    const knex = await this.knex(tx);
    const row = await knex<DocRow>('stock_docs').where({ id }).first();
    if (row === undefined) return fail('doc-not-found');
    const lines = await knex<LineRow>('stock_doc_lines')
      .where({ doc_id: id })
      .orderBy('id', 'asc');
    const refs = await refsOf(knex, [row]);
    const doc = docView(row, lines, refs, withPrice);
    return docFiles === undefined
      ? doc
      : { ...doc, files: await docFiles.filesOf(knex, 'stock_doc', id) };
  }
}

export const stockReaderToken: ServiceToken<StockReader> =
  createServiceToken<StockReader>('app/stock-reader');
export const stockMutationsToken: ServiceToken<StockMutations> =
  createServiceToken<StockMutations>('app/stock-mutations');

export default class InventoryProvider extends ServiceProvider<Application> {
  public readonly name: string = 'app.inventory';

  public override register(): void {
    this.app.container.singleton(stockReaderToken, () => {
      const database = this.app.container.resolve(databaseManagerToken);
      return new DatabaseStockReader(database, this.app.container.resolve(docFilesToken));
    });
    this.app.container.singleton(stockMutationsToken, () => {
      const database = this.app.container.resolve(databaseManagerToken);
      const codes = this.app.container.resolve(codeServiceToken);
      return new DatabaseStockMutations(database, codes, this.app.container.resolve(docFilesToken));
    });
  }
}
