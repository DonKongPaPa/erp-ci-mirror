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

import { assertActiveCodes, BizDictRuleError } from './biz-dict.js';
import { businessPeriod, codeServiceToken, type CodeService } from './codes.js';
import { docFilesToken, type DocFiles, type DocFileView } from './doc-files.js';
import {
  AmountRuleError,
  computeHeaderAmounts,
  computeLineAmounts,
  type AmountLineResult,
} from './doc-amounts.js';
import {
  OrderRuleError,
  orderMutationsToken,
  type OrderMutations,
} from './orders.js';

/**
 * R-022 复刻波 1：报价单的读写服务。金额算法与附件复用订单那一处，不另写一套。
 *
 * 业务校验都在服务层（zod 只挡形状），无授权者在路由先拿 403；数量与金额在库里是
 * decimal(18,4)，JSON 边界统一转 number。六个合计在请求体里带了也不读，按最终明细算。
 */
export type QuotationStatus = 'draft' | 'confirmed' | 'converted' | 'void';
export type QuotationRuleCode =
  | 'quotation-not-found'
  | 'not-draft'
  | 'not-confirmed'
  | 'converted'
  | 'empty'
  | 'validity-invalid'
  | 'discount-invalid'
  | 'line-invalid'
  | 'customer-invalid'
  | 'dict-code-invalid'
  | 'person-invalid';

export class QuotationRuleError extends Error {
  public constructor(
    readonly code: QuotationRuleCode,
    readonly detail?: string,
  ) {
    super(detail === undefined
      ? `Quotation rule violated: ${code}`
      : `Quotation rule violated: ${code} (${detail})`);
    this.name = 'QuotationRuleError';
  }
}

function fail(code: QuotationRuleCode, detail?: string): never {
  throw new QuotationRuleError(code, detail);
}

/** R-016 的表里报价占位前缀也叫 QT，但本片按设计不改发号器常量表，先在这里写死。 */
const QUOTATION_PREFIX = 'QT';

export interface ItemSummary {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly spec: string | null;
  readonly unitCode: string;
}
export interface QuotationLineView {
  readonly id: string;
  readonly quotationId: string;
  readonly itemId: string;
  readonly qty: number;
  readonly price: number | null;
  readonly deliveryDate: string | null;
  readonly taxRate: number | null;
  readonly taxExcludedPrice: number | null;
  readonly taxExcludedAmount: number | null;
  readonly taxAmount: number | null;
  readonly taxIncludedAmount: number | null;
  readonly note: string | null;
  readonly item: ItemSummary;
}
export interface PersonRef {
  readonly userId: string;
  readonly name: string;
}
export interface QuotationView {
  readonly id: string;
  readonly docNo: string;
  readonly quoteDate: string;
  readonly validUntil: string | null;
  readonly status: QuotationStatus;
  readonly expired: boolean;
  readonly warehouse: { id: string; name: string } | null;
  readonly customer: { id: string; code: string; name: string } | null;
  readonly contactName: string | null;
  readonly contactPhone: string | null;
  readonly deliveryAddress: string | null;
  readonly projectCode: string | null;
  readonly projectLabel: string | null;
  readonly settlementCode: string | null;
  readonly settlementLabel: string | null;
  readonly customerOrderNo: string | null;
  readonly handler: PersonRef | null;
  readonly discountAmount: number;
  readonly totalQty: number | null;
  readonly taxIncludedTotal: number | null;
  readonly taxExcludedTotal: number | null;
  readonly taxTotal: number | null;
  readonly payableTotal: number | null;
  readonly convertedOrderId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}
export interface QuotationRecord extends QuotationView {
  readonly lines: readonly QuotationLineView[];
  readonly files: readonly DocFileView[];
}
/** 列表行不带明细与附件。 */
export type QuotationSummary = QuotationView;

export interface Page<T> {
  readonly items: readonly T[];
  readonly total: number;
}
export interface QuotationListQuery {
  readonly customerId?: string;
  readonly projectCode?: string;
  readonly status?: QuotationStatus;
  readonly validFrom?: string;
  readonly validTo?: string;
  readonly q?: string;
  readonly page: number;
  readonly pageSize: number;
}
export interface QuotationLineInput {
  readonly itemId: string;
  readonly qty: number;
  readonly price?: number | null;
  readonly taxExcludedPrice?: number | null;
  readonly taxRate?: number | null;
  readonly deliveryDate?: string | null;
  readonly note?: string | null;
}
interface HeaderInput {
  readonly quoteDate?: string | null;
  readonly validUntil?: string | null;
  readonly warehouseId?: string | null;
  readonly customerId?: string | null;
  readonly contactName?: string | null;
  readonly contactPhone?: string | null;
  readonly deliveryAddress?: string | null;
  readonly projectCode?: string | null;
  readonly settlementCode?: string | null;
  readonly customerOrderNo?: string | null;
  readonly handlerUserId?: string | null;
  readonly discountAmount?: number;
  readonly fileIds?: readonly string[];
}
export interface CreateQuotationInput extends HeaderInput {
  readonly lines: readonly QuotationLineInput[];
}
export interface UpdateQuotationInput extends HeaderInput {
  readonly lines?: readonly QuotationLineInput[];
}
export interface ConvertResult {
  readonly quotation: QuotationRecord;
  readonly salesOrderId: string;
}

interface HeaderRow {
  id: string;
  doc_no: string;
  quote_date: string | Date;
  valid_until: string | Date | null;
  warehouse_id: string | null;
  customer_id: string | null;
  contact_name: string | null;
  contact_phone: string | null;
  delivery_address: string | null;
  project_code: string | null;
  settlement_code: string | null;
  customer_order_no: string | null;
  handler_user_id: string | null;
  discount_amount: string | number;
  total_qty: string | number | null;
  tax_included_total: string | number | null;
  tax_excluded_total: string | number | null;
  tax_total: string | number | null;
  payable_total: string | number | null;
  status: string;
  converted_order_id: string | null;
  created_by_id: string;
  created_at: string | Date;
  updated_at: string | Date;
}
interface LineRow {
  id: string;
  quotation_id: string;
  item_id: string;
  qty: string | number;
  price: string | number | null;
  delivery_date: string | Date | null;
  tax_rate: string | number | null;
  tax_excluded_price: string | number | null;
  tax_excluded_amount: string | number | null;
  tax_amount: string | number | null;
  tax_included_amount: string | number | null;
  note: string | null;
}
interface ItemRow {
  id: string; code: string; name: string; spec: string | null; unit_code: string;
}
interface PartnerRow { id: string; code: string; name: string; }
interface DictRow { dict_type: string; code: string; name: string; }

const num = (value: unknown): number => Number(value);
const dayString = (value: string | Date): string => {
  if (typeof value === 'string') return value.slice(0, 10);
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${value.getFullYear()}-${month}-${day}`;
};
const iso = (value: string | Date): string => String(value instanceof Date ? value.toISOString() : value);
const today = (): string => {
  const period = businessPeriod(new Date());
  return `${period.slice(0, 4)}-${period.slice(4, 6)}-${period.slice(6, 8)}`;
};
/** 有效期已过不拦，只标记；日期是 YYYY-MM-DD，字典序即时间序。 */
const isExpired = (validUntil: string | null): boolean =>
  validUntil !== null && validUntil !== '' && validUntil < today();

async function countOf(base: Knex.QueryBuilder): Promise<number> {
  const row = (await base.clone().clear('select').count('* as count').first()) as
    | { count?: string | number }
    | undefined;
  return Number(row?.count ?? 0);
}

function validateLines(lines: readonly QuotationLineInput[]): void {
  // 空明细可以留在草稿里；「没行就确定」由 confirm 用 QUOTATION_EMPTY 拦。
  if (lines.length === 0) return;
  const seen = new Set<string>();
  for (const line of lines) {
    if (
      typeof line.itemId !== 'string' || line.itemId.trim() === '' ||
      typeof line.qty !== 'number' || !Number.isFinite(line.qty) || line.qty <= 0 ||
      (line.price !== undefined && line.price !== null &&
        (!Number.isFinite(line.price) || line.price < 0))
    ) {
      return fail('line-invalid');
    }
    if (seen.has(line.itemId)) return fail('line-invalid', 'duplicated-item');
    seen.add(line.itemId);
  }
}

function computedAmounts(lines: readonly QuotationLineInput[]): readonly AmountLineResult[] {
  try {
    return lines.map((line) => computeLineAmounts({
      qty: line.qty,
      price: line.price,
      taxExcludedPrice: line.taxExcludedPrice,
      taxRate: line.taxRate,
    }));
  } catch (error) {
    if (error instanceof AmountRuleError) {
      return fail(error.code === 'discount-invalid' ? 'discount-invalid' : 'line-invalid', error.detail);
    }
    throw error;
  }
}

function headerTotals(lines: readonly AmountLineResult[], discount: number) {
  try {
    return computeHeaderAmounts(lines, discount);
  } catch (error) {
    if (error instanceof AmountRuleError) return fail('discount-invalid', error.detail);
    throw error;
  }
}

function validateValidity(quoteDate: string, validUntil: string | null | undefined): void {
  if (validUntil !== undefined && validUntil !== null && validUntil < quoteDate) {
    fail('validity-invalid', validUntil);
  }
}

/** 服务层统一转本片的规则码，不复制金额算法。 */
function fromOrder(error: unknown): never {
  if (!(error instanceof OrderRuleError)) throw error;
  switch (error.code) {
    case 'partner-not-found':
    case 'partner-not-customer':
    case 'partner-inactive':
      return fail('customer-invalid', error.detail);
    case 'dict-code-invalid':
      return fail('dict-code-invalid', error.detail);
    case 'person-invalid':
      return fail('person-invalid', error.detail);
    case 'discount-invalid':
      return fail('discount-invalid', error.detail);
    default:
      return fail('line-invalid', error.code);
  }
}

async function assertItemsActive(knex: Knex, ids: readonly string[]): Promise<void> {
  const uniqueIds = [...new Set(ids)];
  if (uniqueIds.length === 0) return;
  const rows = await knex<{ id: string; status: string }>('items')
    .select('id', 'status').whereIn('id', uniqueIds);
  const found = new Map(rows.map((row) => [row.id, row.status]));
  for (const id of uniqueIds) {
    if (!found.has(id) || found.get(id) !== 'active') return fail('line-invalid', `item:${id}`);
  }
}

async function requireCustomer(knex: Knex, customerId: string): Promise<void> {
  const row = await knex<{ status: string; is_customer: boolean }>('partners')
    .select('status', 'is_customer').where('id', customerId).first();
  if (row === undefined || row.is_customer !== true || row.status !== 'active') {
    fail('customer-invalid', customerId);
  }
}

/**
 * 设计只给了字典码的规则码，没有仓库专用的；引用了不存在/停用的仓库也归到这一码，
 * detail 里写明是哪一类引用。
 */
async function requireWarehouse(knex: Knex, warehouseId: string): Promise<void> {
  const row = await knex<{ status: string }>('warehouses')
    .select('status').where('id', warehouseId).first();
  if (row === undefined) fail('dict-code-invalid', 'warehouse-not-found');
  if (row.status !== 'active') fail('dict-code-invalid', 'warehouse-inactive');
}

async function assertDicts(
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

async function requireActivePerson(knex: Knex, userId: string): Promise<void> {
  const row = await knex<{ status: string }>('employees')
    .select('status').where('user_id', userId).first();
  if (row === undefined || row.status !== 'active') fail('person-invalid', userId);
}

async function itemSummaries(knex: Knex, ids: readonly string[]): Promise<Map<string, ItemSummary>> {
  const uniqueIds = [...new Set(ids)];
  if (uniqueIds.length === 0) return new Map();
  const rows = await knex<ItemRow>('items')
    .select('id', 'code', 'name', 'spec', 'unit_code').whereIn('id', uniqueIds);
  return new Map(rows.map((row) => [row.id, {
    id: row.id, code: row.code, name: row.name,
    spec: row.spec ?? null, unitCode: row.unit_code,
  }]));
}

async function handlersOf(knex: Knex, ids: readonly (string | null)[]): Promise<Map<string, PersonRef>> {
  const uniqueIds = [...new Set(ids.filter((id): id is string => typeof id === 'string' && id !== ''))];
  if (uniqueIds.length === 0) return new Map();
  const rows = await knex<{ id: string; name: string | null }>('user')
    .select('id', 'name').whereIn('id', uniqueIds);
  return new Map(rows.map((row) => [row.id, { userId: row.id, name: row.name ?? row.id }]));
}

async function dictLabels(knex: Knex, rows: readonly HeaderRow[]): Promise<Map<string, string>> {
  const pairs = rows.flatMap((row) => [
    ...(row.project_code === null ? [] : [{ type: 'project', code: row.project_code }]),
    ...(row.settlement_code === null ? [] : [{ type: 'settlement', code: row.settlement_code }]),
  ]);
  if (pairs.length === 0) return new Map();
  const types = [...new Set(pairs.map((pair) => pair.type))];
  const codes = [...new Set(pairs.map((pair) => pair.code))];
  const found = await knex<DictRow>('biz_dict_entries')
    .select('dict_type', 'code', 'name').whereIn('dict_type', types).whereIn('code', codes);
  return new Map(found.map((row) => [`${row.dict_type}:${row.code}`, row.name]));
}

function lineView(row: LineRow, item: ItemSummary | undefined): QuotationLineView {
  return {
    id: row.id,
    quotationId: row.quotation_id,
    itemId: row.item_id,
    qty: num(row.qty),
    price: row.price === null || row.price === undefined ? null : num(row.price),
    deliveryDate: row.delivery_date === null || row.delivery_date === undefined
      ? null : dayString(row.delivery_date),
    taxRate: row.tax_rate === null || row.tax_rate === undefined ? null : num(row.tax_rate),
    taxExcludedPrice: row.tax_excluded_price === null ? null : num(row.tax_excluded_price),
    taxExcludedAmount: row.tax_excluded_amount === null ? null : num(row.tax_excluded_amount),
    taxAmount: row.tax_amount === null ? null : num(row.tax_amount),
    taxIncludedAmount: row.tax_included_amount === null ? null : num(row.tax_included_amount),
    note: row.note ?? null,
    item: item ?? {
      id: row.item_id, code: '', name: '', spec: null, unitCode: '',
    },
  };
}

function headerView(
  row: HeaderRow,
  partner: PartnerRow | undefined,
  warehouse: { id: string; name: string } | undefined,
  handler: PersonRef | null,
  labels: Map<string, string>,
): QuotationView {
  const validUntil = row.valid_until === null || row.valid_until === undefined
    ? null : dayString(row.valid_until);
  return {
    id: row.id,
    docNo: row.doc_no,
    quoteDate: dayString(row.quote_date),
    validUntil,
    status: row.status as QuotationStatus,
    expired: isExpired(validUntil),
    warehouse: warehouse ?? null,
    customer: partner === undefined
      ? null
      : { id: partner.id, code: partner.code, name: partner.name },
    contactName: row.contact_name ?? null,
    contactPhone: row.contact_phone ?? null,
    deliveryAddress: row.delivery_address ?? null,
    projectCode: row.project_code ?? null,
    projectLabel: row.project_code === null ? null : labels.get(`project:${row.project_code}`) ?? null,
    settlementCode: row.settlement_code ?? null,
    settlementLabel: row.settlement_code === null
      ? null : labels.get(`settlement:${row.settlement_code}`) ?? null,
    customerOrderNo: row.customer_order_no ?? null,
    handler,
    discountAmount: num(row.discount_amount ?? 0),
    totalQty: row.total_qty === null || row.total_qty === undefined ? null : num(row.total_qty),
    taxIncludedTotal: row.tax_included_total === null ? null : num(row.tax_included_total),
    taxExcludedTotal: row.tax_excluded_total === null ? null : num(row.tax_excluded_total),
    taxTotal: row.tax_total === null ? null : num(row.tax_total),
    payableTotal: row.payable_total === null ? null : num(row.payable_total),
    convertedOrderId: row.converted_order_id ?? null,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

export interface QuotationReader {
  list(query: QuotationListQuery): Promise<Page<QuotationSummary>>;
  detail(id: string): Promise<QuotationRecord | undefined>;
}

export interface QuotationMutations {
  create(input: CreateQuotationInput, byUserId: string): Promise<QuotationRecord>;
  update(id: string, input: UpdateQuotationInput, byUserId: string): Promise<QuotationRecord>;
  confirm(id: string): Promise<QuotationRecord>;
  convert(id: string, byUserId: string): Promise<ConvertResult>;
  void(id: string): Promise<QuotationRecord>;
}

export class DatabaseQuotationReader implements QuotationReader {
  public constructor(
    private readonly database: DatabaseManager,
    private readonly docFiles: DocFiles,
  ) {}

  private async knex(): Promise<Knex> {
    return await this.database.connection().client<Knex>();
  }

  public async list(query: QuotationListQuery): Promise<Page<QuotationSummary>> {
    const knex = await this.knex();
    const base = knex<HeaderRow>('quotations').modify((builder) => {
      if (query.customerId !== undefined) void builder.where('customer_id', query.customerId);
      if (query.projectCode !== undefined) void builder.where('project_code', query.projectCode);
      if (query.status !== undefined) void builder.where('status', query.status);
      if (query.validFrom !== undefined) void builder.where('valid_until', '>=', query.validFrom);
      if (query.validTo !== undefined) void builder.where('valid_until', '<=', query.validTo);
      if (query.q !== undefined && query.q !== '') {
        void builder.where((inner) => {
          inner.whereILike('doc_no', `%${query.q}%`).orWhereILike('customer_order_no', `%${query.q}%`);
        });
      }
    });
    const total = await countOf(base);
    const rows = (await base.clone()
      .orderBy('created_at', 'desc').orderBy('id', 'asc')
      .limit(query.pageSize).offset((query.page - 1) * query.pageSize)) as HeaderRow[];
    const customerIds = rows.map((row) => row.customer_id).filter((id): id is string => id !== null);
    const customers = customerIds.length === 0
      ? new Map<string, PartnerRow>()
      : new Map((await knex<PartnerRow>('partners')
        .select('id', 'code', 'name').whereIn('id', customerIds)).map((row) => [row.id, row]));
    const warehouseIds = rows.map((row) => row.warehouse_id).filter((id): id is string => id !== null);
    const warehouses = warehouseIds.length === 0
      ? new Map<string, { id: string; name: string }>()
      : new Map((await knex<{ id: string; name: string }>('warehouses')
        .select('id', 'name').whereIn('id', warehouseIds)).map((row) => [row.id, row]));
    const handlers = await handlersOf(knex, rows.map((row) => row.handler_user_id));
    const labels = await dictLabels(knex, rows);
    return {
      items: rows.map((row) => headerView(
        row,
        row.customer_id === null ? undefined : customers.get(row.customer_id),
        row.warehouse_id === null ? undefined : warehouses.get(row.warehouse_id),
        handlers.get(row.handler_user_id ?? '') ?? null,
        labels,
      )),
      total,
    };
  }

  public async detail(id: string): Promise<QuotationRecord | undefined> {
    const knex = await this.knex();
    return await readDetail(knex, id, this.docFiles);
  }
}

async function readDetail(
  knex: Knex,
  id: string,
  docFiles: DocFiles,
): Promise<QuotationRecord | undefined> {
  const row = await knex<HeaderRow>('quotations').where({ id }).first();
  if (row === undefined) return undefined;
  const partner = row.customer_id === null
    ? undefined
    : await knex<PartnerRow>('partners')
      .select('id', 'code', 'name').where({ id: row.customer_id }).first();
  const warehouse = row.warehouse_id === null
    ? undefined
    : await knex<{ id: string; name: string }>('warehouses')
      .select('id', 'name').where({ id: row.warehouse_id }).first();
  const handlers = await handlersOf(knex, [row.handler_user_id]);
  const labels = await dictLabels(knex, [row]);
  const lineRows = await knex<LineRow>('quotation_lines').where({ quotation_id: id }).orderBy('id', 'asc');
  const items = await itemSummaries(knex, lineRows.map((line) => line.item_id));
  const files = await docFiles.filesOf(knex, 'quotation', id);
  return {
    ...headerView(
      row,
      partner,
      warehouse,
      handlers.get(row.handler_user_id ?? '') ?? null,
      labels,
    ),
    lines: lineRows.map((line) => lineView(line, items.get(line.item_id))),
    files,
  };
}

export class DatabaseQuotationMutations implements QuotationMutations {
  public constructor(
    private readonly database: DatabaseManager,
    private readonly codes: CodeService,
    private readonly orders: OrderMutations,
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

  private async requireHeader(knex: Knex, id: string): Promise<HeaderRow> {
    const row = await knex<HeaderRow>('quotations').where({ id }).forUpdate().first();
    if (row === undefined) return fail('quotation-not-found', id);
    return row;
  }

  private async detailIn(knex: Knex, id: string): Promise<QuotationRecord> {
    const record = await readDetail(knex, id, this.docFiles);
    if (record === undefined) return fail('quotation-not-found', id);
    return record;
  }

  private async insertLines(
    knex: Knex,
    quotationId: string,
    lines: readonly QuotationLineInput[],
    amounts: readonly AmountLineResult[],
  ): Promise<void> {
    for (const [index, line] of lines.entries()) {
      const amount = amounts[index];
      await knex('quotation_lines').insert({
        id: randomUUID(),
        quotation_id: quotationId,
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

  private async linesAsInputs(knex: Knex, quotationId: string): Promise<readonly QuotationLineInput[]> {
    const rows = await knex<LineRow>('quotation_lines')
      .where({ quotation_id: quotationId }).orderBy('id', 'asc');
    return rows.map((row) => ({
      itemId: row.item_id,
      qty: num(row.qty),
      price: row.price === null || row.price === undefined ? null : num(row.price),
      taxExcludedPrice: row.tax_excluded_price === null || row.tax_excluded_price === undefined
        ? null : num(row.tax_excluded_price),
      taxRate: row.tax_rate === null || row.tax_rate === undefined ? null : num(row.tax_rate),
      deliveryDate: row.delivery_date === null || row.delivery_date === undefined
        ? null : dayString(row.delivery_date),
      note: row.note,
    }));
  }

  public async create(input: CreateQuotationInput, byUserId: string): Promise<QuotationRecord> {
    validateLines(input.lines);
    const quoteDate = input.quoteDate ?? today();
    validateValidity(quoteDate, input.validUntil);
    return await this.inTransaction(undefined, async (tx) => {
      const knex = await this.knex(tx);
      if (input.customerId !== undefined && input.customerId !== null) {
        await requireCustomer(knex, input.customerId);
      }
      await assertItemsActive(knex, input.lines.map((line) => line.itemId));
      if (input.warehouseId !== undefined && input.warehouseId !== null) {
        await requireWarehouse(knex, input.warehouseId);
      }
      await assertDicts(tx, input.settlementCode, input.projectCode);
      const handlerUserId = input.handlerUserId ?? byUserId;
      if (input.handlerUserId !== undefined && input.handlerUserId !== null) {
        await requireActivePerson(knex, handlerUserId);
      }
      const amounts = computedAmounts(input.lines);
      const totals = headerTotals(amounts, input.discountAmount ?? 0);
      const docNo = await this.codes.nextCode(tx, QUOTATION_PREFIX);
      const id = randomUUID();
      const now = new Date();
      await knex('quotations').insert({
        id,
        doc_no: docNo,
        quote_date: quoteDate,
        valid_until: input.validUntil ?? null,
        warehouse_id: input.warehouseId ?? null,
        customer_id: input.customerId ?? null,
        contact_name: input.contactName ?? null,
        contact_phone: input.contactPhone ?? null,
        delivery_address: input.deliveryAddress ?? null,
        project_code: input.projectCode ?? null,
        settlement_code: input.settlementCode ?? null,
        customer_order_no: input.customerOrderNo ?? null,
        handler_user_id: handlerUserId,
        discount_amount: totals.discountAmount,
        total_qty: totals.totalQty,
        tax_included_total: totals.taxIncludedTotal,
        tax_excluded_total: totals.taxExcludedTotal,
        tax_total: totals.taxTotal,
        payable_total: totals.payableTotal,
        status: 'draft',
        converted_order_id: null,
        created_by_id: byUserId,
        created_at: now,
        updated_at: now,
      });
      await this.insertLines(knex, id, input.lines, amounts);
      await this.docFiles.bind(knex, 'quotation', id, input.fileIds, byUserId);
      return await this.detailIn(knex, id);
    });
  }

  public async update(id: string, input: UpdateQuotationInput, byUserId: string): Promise<QuotationRecord> {
    return await this.inTransaction(undefined, async (tx) => {
      const knex = await this.knex(tx);
      const header = await this.requireHeader(knex, id);
      if (header.status !== 'draft') return fail('not-draft');
      if (
        input.quoteDate === undefined && input.validUntil === undefined &&
        input.warehouseId === undefined && input.customerId === undefined &&
        input.contactName === undefined && input.contactPhone === undefined &&
        input.deliveryAddress === undefined && input.projectCode === undefined &&
        input.settlementCode === undefined && input.customerOrderNo === undefined &&
        input.handlerUserId === undefined && input.discountAmount === undefined &&
        input.fileIds === undefined && input.lines === undefined
      ) {
        return fail('empty', 'empty-patch');
      }
      const quoteDate = input.quoteDate ?? dayString(header.quote_date);
      const validUntil = input.validUntil === undefined
        ? (header.valid_until === null ? null : dayString(header.valid_until))
        : input.validUntil;
      validateValidity(quoteDate, validUntil);
      if (input.customerId !== undefined && input.customerId !== null) {
        await requireCustomer(knex, input.customerId);
      }
      if (input.warehouseId !== undefined && input.warehouseId !== null) {
        await requireWarehouse(knex, input.warehouseId);
      }
      await assertDicts(tx, input.settlementCode, input.projectCode);
      if (input.handlerUserId !== undefined && input.handlerUserId !== null) {
        await requireActivePerson(knex, input.handlerUserId);
      }
      if (input.lines !== undefined) {
        validateLines(input.lines);
        await assertItemsActive(knex, input.lines.map((line) => line.itemId));
      }
      const patch: Record<string, unknown> = {
        ...(input.quoteDate === undefined ? {} : { quote_date: input.quoteDate }),
        ...(input.validUntil === undefined ? {} : { valid_until: input.validUntil }),
        ...(input.warehouseId === undefined ? {} : { warehouse_id: input.warehouseId }),
        ...(input.customerId === undefined ? {} : { customer_id: input.customerId }),
        ...(input.contactName === undefined ? {} : { contact_name: input.contactName }),
        ...(input.contactPhone === undefined ? {} : { contact_phone: input.contactPhone }),
        ...(input.deliveryAddress === undefined ? {} : { delivery_address: input.deliveryAddress }),
        ...(input.projectCode === undefined ? {} : { project_code: input.projectCode }),
        ...(input.settlementCode === undefined ? {} : { settlement_code: input.settlementCode }),
        ...(input.customerOrderNo === undefined ? {} : { customer_order_no: input.customerOrderNo }),
        ...(input.handlerUserId === undefined ? {} : { handler_user_id: input.handlerUserId }),
        updated_at: new Date(),
      };
      if (input.lines !== undefined) {
        await knex('quotation_lines').where({ quotation_id: id }).delete();
        await this.insertLines(knex, id, input.lines, computedAmounts(input.lines));
      }
      // 合计每次按最终明细重算；请求体里带的总数一律不进 patch。
      const finalLines = await this.linesAsInputs(knex, id);
      const totals = headerTotals(
        computedAmounts(finalLines),
        input.discountAmount ?? num(header.discount_amount ?? 0),
      );
      await knex('quotations').where({ id }).update({
        ...patch,
        discount_amount: totals.discountAmount,
        total_qty: totals.totalQty,
        tax_included_total: totals.taxIncludedTotal,
        tax_excluded_total: totals.taxExcludedTotal,
        tax_total: totals.taxTotal,
        payable_total: totals.payableTotal,
      });
      await this.docFiles.bind(knex, 'quotation', id, input.fileIds, byUserId);
      return await this.detailIn(knex, id);
    });
  }

  public async confirm(id: string): Promise<QuotationRecord> {
    return await this.inTransaction(undefined, async (tx) => {
      const knex = await this.knex(tx);
      const header = await this.requireHeader(knex, id);
      if (header.status !== 'draft') return fail('not-confirmed');
      const lines = await knex<{ id: string }>('quotation_lines').where('quotation_id', id);
      if (lines.length === 0) return fail('empty');
      await knex('quotations').where({ id }).update({ status: 'confirmed', updated_at: new Date() });
      return await this.detailIn(knex, id);
    });
  }

  /**
   * 确认后手动全量转一次。整段在一个事务里，并先对报价单头加行锁：并发两次转单必然串行，
   * 后一次看到 converted 就被拒，库里带该 quotationId 的销售订单恰好一张。
   */
  public async convert(id: string, byUserId: string): Promise<ConvertResult> {
    return await this.inTransaction(undefined, async (tx) => {
      const knex = await this.knex(tx);
      const header = await this.requireHeader(knex, id);
      if (header.status === 'draft' || header.status === 'void') return fail('not-confirmed');
      if (header.status !== 'confirmed') return fail('converted');
      // 销售订单的客户列非空；没填客户的报价单不猜客户，交给销售补上再转。
      if (header.customer_id === null) return fail('customer-invalid', 'missing-customer');
      const lineRows = await knex<LineRow>('quotation_lines')
        .where({ quotation_id: id }).orderBy('id', 'asc');
      if (lineRows.length === 0) return fail('empty');
      let order;
      try {
        order = await this.orders.create('sales', {
          partnerId: header.customer_id,
          orderDate: dayString(header.quote_date),
          remark: '',
          warehouseId: header.warehouse_id,
          contactName: header.contact_name,
          contactPhone: header.contact_phone,
          deliveryAddress: header.delivery_address,
          settlementCode: header.settlement_code,
          projectCode: header.project_code,
          customerOrderNo: header.customer_order_no,
          handlerUserId: header.handler_user_id,
          discountAmount: num(header.discount_amount ?? 0),
          quotationId: id,
          lines: lineRows.map((line) => ({
            itemId: line.item_id,
            qty: num(line.qty),
            price: line.price === null ? null : num(line.price),
            taxExcludedPrice: line.tax_excluded_price === null ? null : num(line.tax_excluded_price),
            taxRate: line.tax_rate === null ? null : num(line.tax_rate),
            deliveryDate: line.delivery_date === null ? null : dayString(line.delivery_date),
            note: line.note,
          })),
        }, byUserId, tx);
      } catch (error) {
        return fromOrder(error);
      }
      await knex('quotations').where({ id }).update({
        status: 'converted', converted_order_id: String(order.id), updated_at: new Date(),
      });
      return { quotation: await this.detailIn(knex, id), salesOrderId: String(order.id) };
    });
  }

  public async void(id: string): Promise<QuotationRecord> {
    return await this.inTransaction(undefined, async (tx) => {
      const knex = await this.knex(tx);
      const header = await this.requireHeader(knex, id);
      if (header.status !== 'draft' && header.status !== 'confirmed') {
        return fail('not-confirmed', `status:${header.status}`);
      }
      await knex('quotations').where({ id }).update({ status: 'void', updated_at: new Date() });
      return await this.detailIn(knex, id);
    });
  }
}

export const quotationReaderToken: ServiceToken<QuotationReader> =
  createServiceToken<QuotationReader>('app/quotation-reader');
export const quotationMutationsToken: ServiceToken<QuotationMutations> =
  createServiceToken<QuotationMutations>('app/quotation-mutations');

export default class QuotationsProvider extends ServiceProvider<Application> {
  public readonly name: string = 'app.quotations';

  public override register(): void {
    this.app.container.singleton(quotationReaderToken, () => {
      const database = this.app.container.resolve(databaseManagerToken);
      return new DatabaseQuotationReader(database, this.app.container.resolve(docFilesToken));
    });
    this.app.container.singleton(quotationMutationsToken, () => {
      const database = this.app.container.resolve(databaseManagerToken);
      return new DatabaseQuotationMutations(
        database,
        this.app.container.resolve(codeServiceToken),
        this.app.container.resolve(orderMutationsToken),
        this.app.container.resolve(docFilesToken),
      );
    });
  }
}
