import { createHash, randomUUID } from 'node:crypto';

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
import type { Knex } from 'knex';

import {
  REPORT_DEFINITIONS,
  type ReportColumn,
  type ReportDefinition,
} from './report-definitions.js';
import { financeReaderToken, type FinanceReader } from './finance.js';
import { inspectionReaderToken, type InspectionReader } from './iqc.js';
import { orderLedgerToken, type OrderLedgerReader } from './order-ledger.js';
import { orderReaderToken, type OrderReader } from './orders.js';
import { quotationReaderToken, type QuotationReader } from './quotations.js';
import { reconciliationReaderToken, type DatabaseReconciliationReader } from './reconciliation.js';
import { returnsReaderToken, type ReturnsReader } from './returns.js';
import { stockReaderToken, type StockReader } from './inventory.js';

/** 白名单被破坏、越权或分页越界时抛；路由把 code 翻成规则码与 HTTP 状态。 */
export type ReportRuleCode =
  | 'report-not-found'
  | 'report-forbidden'
  | 'field-invalid'
  | 'page-invalid'
  | 'export-failed';

export class ReportRuleError extends Error {
  public constructor(
    readonly code: ReportRuleCode,
    detail?: string,
  ) {
    super(detail ?? `Report rule violated: ${code}`);
    this.name = 'ReportRuleError';
  }
}

/** `resource.action` → 是否放行；路由注入，判定复用授权上下文。 */
export type ActionChecker = (specification: string) => Promise<boolean>;

export type FilterValue = string | number | boolean | null;
export interface RunReportInput {
  readonly filters: Readonly<Record<string, FilterValue>>;
  readonly dimensions?: readonly string[];
  readonly measures?: readonly string[];
  readonly page: number;
  readonly pageSize: number;
}
export interface ReportResult {
  readonly columns: readonly ReportColumn[];
  readonly items: readonly Record<string, string | number | null>[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
}
export interface ReportBrief {
  readonly key: string;
  readonly titleKey: string;
  readonly category: string;
}
export interface ExportTraceInput {
  readonly userId: string;
  readonly reportKey: string;
  readonly at: string;
  readonly filtersHash: string;
  readonly rowCount: number;
}
export interface ExportTrace extends ExportTraceInput {
  readonly user: { readonly userId: string; readonly name: string };
}

export function parseSpec(specification: string): { resource: string; action: string } {
  const dot = specification.indexOf('.');
  return dot < 0
    ? { resource: specification, action: specification }
    : { resource: specification.slice(0, dot), action: specification.slice(dot + 1) };
}

export function sha256Of(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

type SourceRow = Record<string, string | number | boolean | null>;
interface SourceInput {
  readonly definition: LoadedDefinition;
  readonly filters: Readonly<Record<string, FilterValue>>;
  readonly allows: ActionChecker;
}
type ReportSource = (input: SourceInput) => Promise<readonly SourceRow[]>;

export interface LoadedDefinition extends ReportDefinition {
  readonly status: 'active' | 'inactive';
}

interface DefinitionRow {
  id: string; key: string; title_key: string; category: string;
  dimensions: string; measures: string; columns: string;
  base_actions: string; source: string; status: string;
}
interface FavoriteRow { id: string; user_id: string; report_key: string; created_at: string | Date }
interface TraceRow {
  id: string; user_id: string; report_key: string; at: string | Date;
  format: string; filters_hash: string; row_count: string | number; user_name: string | null;
}
interface TraceViewRow {
  id: string; userId: string; reportKey: string; at: string | Date;
  format: string; filtersHash: string; rowCount: string | number; userName: string | null;
}

const num = (value: unknown): number => Number(value ?? 0);
const text = (value: unknown): string => {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
};
const dateOf = (value: string | Date | null | undefined): string => {
  if (value === null || value === undefined) return '';
  return typeof value === 'string' ? value.slice(0, 10) : value.toISOString().slice(0, 10);
};

function definitionOf(row: DefinitionRow): LoadedDefinition {
  return {
    id: row.id,
    key: row.key,
    titleKey: row.title_key,
    category: row.category as LoadedDefinition['category'],
    dimensions: JSON.parse(row.dimensions) as string[],
    measures: JSON.parse(row.measures) as string[],
    columns: JSON.parse(row.columns) as ReportColumn[],
    baseActions: JSON.parse(row.base_actions) as string[],
    source: row.source,
    status: row.status as 'active' | 'inactive',
  };
}

async function allPages<T>(
  fetch: (page: number) => Promise<{ items: readonly T[]; total: number }>,
): Promise<readonly T[]> {
  const first = await fetch(1);
  const rows: T[] = [...first.items];
  const pages = Math.min(100, Math.ceil(first.total / 1000));
  for (let page = 2; page <= pages; page += 1) {
    rows.push(...(await fetch(page)).items);
  }
  return rows;
}

function matches(filters: Readonly<Record<string, FilterValue>>, row: SourceRow): boolean {
  return Object.entries(filters).every(([key, expected]) => {
    const actual = row[key] ?? '';
    if (expected === null) return actual === '' || actual === null;
    return String(actual) === String(expected);
  });
}

/** 过滤器→底层读查询的映射只取白名单内的键，字段名是代码常量，不来自请求。 */
const dayValue = (value: FilterValue | undefined): string | undefined =>
  typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(value) ? value : undefined;

function purchaseOrderQuery(filters: Readonly<Record<string, FilterValue>>) {
  return {
    page: 1, pageSize: 1000,
    ...(typeof filters.supplier === 'string' ? { partnerId: filters.supplier } : {}),
    ...(typeof filters.project === 'string' ? { projectCode: filters.project } : {}),
    ...(typeof filters.salesperson === 'string' ? { handlerUserId: filters.salesperson } : {}),
    ...(dayValue(filters.date) === undefined ? {} : { from: dayValue(filters.date), to: dayValue(filters.date) }),
  };
}

function stockDocQuery(filters: Readonly<Record<string, FilterValue>>) {
  return {
    page: 1, pageSize: 1000,
    ...(typeof filters.partner === 'string' ? { partnerId: filters.partner } : {}),
    ...(typeof filters.project === 'string' ? { projectCode: filters.project } : {}),
    ...(dayValue(filters.date) === undefined ? {} : { from: dayValue(filters.date), to: dayValue(filters.date), dateField: 'docDate' as const }),
  };
}

function financeQuery(filters: Readonly<Record<string, FilterValue>>) {
  return {
    page: 1, pageSize: 1000,
    ...(typeof filters.project === 'string' ? { projectCode: filters.project } : {}),
    ...(dayValue(filters.date) === undefined ? {} : { from: dayValue(filters.date), to: dayValue(filters.date) }),
  };
}

export interface ReportEngineServices {
  readonly database: DatabaseManager;
  readonly orderReader: OrderReader;
  readonly stockReader: StockReader;
  readonly financeReader: FinanceReader;
  readonly reconciliationReader: DatabaseReconciliationReader;
  readonly orderLedger: OrderLedgerReader;
  readonly returnsReader: ReturnsReader;
  readonly inspectionReader: InspectionReader;
  readonly quotationReader: QuotationReader;
}

export class DatabaseReportEngine {
  private readonly sources: Readonly<Record<string, ReportSource>>;

  public constructor(private readonly services: ReportEngineServices) {
    const { orderReader, stockReader, financeReader, reconciliationReader, orderLedger, returnsReader, inspectionReader, quotationReader } = services;
    const purchaseLines: ReportSource = async ({ filters, allows }) => {
      const withPrice = await allows('purchaseOrders.viewPrice');
      const orders = await allPages((page) => orderReader.list('purchase', {
        ...purchaseOrderQuery(filters), page,
      }, withPrice));
      const rows: SourceRow[] = [];
      for (const order of orders) {
        const detail = await orderReader.detail('purchase', order.id, withPrice);
        for (const line of detail?.lines ?? []) {
          const totalQty = num(line.qty);
          const received = num(line.receivedQty);
          rows.push({
            date: order.orderDate, warehouse: order.warehouseId ?? '',
            itemCategory: line.itemId, item: line.itemId,
            supplier: order.supplierId ?? '', project: order.projectCode ?? '',
            qty: totalQty, purchaseQty: totalQty, salesQty: totalQty,
            taxExcludedPrice: line.taxExcludedPrice ?? null,
            taxIncludedPrice: line.price ?? null,
            taxRate: line.taxRate ?? null,
            taxIncludedAmount: line.taxIncludedAmount ?? null,
            amount: line.taxIncludedAmount ?? null,
            purchaseAmount: line.taxIncludedAmount ?? null,
            orderCount: 1,
            receivedQty: received, actualQty: received,
            returnQty: 0, pendingQty: Math.max(0, totalQty - received),
            qualifiedRate: 0,
            paidAmount: order.paidAmount,
            unpaidAmount: Math.max(0, num(order.payableTotal) - order.paidAmount),
          });
        }
      }
      return rows;
    };
    const salesLines: ReportSource = async ({ filters, allows }) => {
      const withPrice = await allows('salesOrders.viewPrice');
      const orders = await allPages((page) => orderReader.list('sales', {
        ...purchaseOrderQuery(filters), page,
      }, withPrice));
      const rows: SourceRow[] = [];
      for (const order of orders) {
        const detail = await orderReader.detail('sales', order.id, withPrice);
        for (const line of detail?.lines ?? []) {
          const totalQty = num(line.qty);
          const shipped = num(line.shippedQty);
          rows.push({
            date: order.orderDate, warehouse: order.warehouseId ?? '',
            itemCategory: line.itemId, item: line.itemId,
            customer: order.customerId ?? '', salesperson: order.handlerUserId ?? '',
            project: order.projectCode ?? '',
            qty: totalQty, salesQty: totalQty,
            taxIncludedPrice: line.price ?? null,
            taxRate: line.taxRate ?? null,
            taxIncludedAmount: line.taxIncludedAmount ?? null,
            amount: line.taxIncludedAmount ?? null,
            orderCount: 1,
            shippedQty: shipped, actualQty: shipped,
            returnQty: 0, pendingQty: Math.max(0, totalQty - shipped),
            receivedAmount: order.receivedAmount ?? 0,
            unreceivedAmount: Math.max(0, num(order.payableTotal) - num(order.receivedAmount)),
          });
        }
      }
      return rows;
    };
    const tracking: ReportSource = async ({ definition, filters, allows }) => {
      const purchase = definition.key.startsWith('purchase_');
      const kind = purchase ? 'purchase' : 'sales';
      const withPrice = await allows(`${kind === 'purchase' ? 'purchaseOrders' : 'salesOrders'}.viewPrice`);
      // 已出库 / 已入库、已收 / 已付、已开票全部取业务单据的回写列，不在报表里另算一套。
      const orders = await allPages((page) => orderReader.list(kind, {
        ...purchaseOrderQuery(filters), page,
      }, withPrice));
      const returns = await allPages((page) => returnsReader.list(kind, { page, pageSize: 1000 }));
      const returnsByOrder = new Map<string, number>();
      for (const doc of returns) {
        if (doc.status !== 'posted') continue; // 作废与未过账不计
        const qty = doc.lines.reduce((sum, line) => sum + num(line.returnQty), 0);
        returnsByOrder.set(doc.sourceId, (returnsByOrder.get(doc.sourceId) ?? 0) + qty);
      }
      const rows: SourceRow[] = [];
      for (const order of orders) {
        const detail = await orderReader.detail(kind, order.id, withPrice);
        const lines = detail?.lines ?? [];
        const totalQty = lines.reduce((sum, line) => sum + num(line.qty), 0);
        const doneQty = lines.reduce(
          (sum, line) => sum + num(purchase ? line.receivedQty : line.shippedQty), 0,
        );
        const paid = purchase ? order.paidAmount : num(order.receivedAmount);
        const invoiced = order.invoicedAmount;
        const total = num(order.payableTotal);
        const returned = returnsByOrder.get(order.id) ?? 0;
        const base: SourceRow = {
          date: order.orderDate,
          supplier: purchase ? order.supplierId ?? '' : '',
          customer: purchase ? '' : order.customerId ?? '',
          project: order.projectCode ?? '',
          salesperson: order.handlerUserId ?? '',
          receivedQty: doneQty, shippedQty: doneQty, returnQty: returned,
          unreceivedQty: Math.max(0, totalQty - doneQty),
          unshippedQty: Math.max(0, totalQty - doneQty),
          paidAmount: paid, receivedAmount: paid,
          invoicedAmount: invoiced,
          invoicedQty: invoiced > 0 ? doneQty : 0,
          receiveStatus: totalQty > 0 && doneQty >= totalQty ? 'received' : doneQty > 0 ? 'partial' : 'none',
          shipStatus: totalQty > 0 && doneQty >= totalQty ? 'shipped' : doneQty > 0 ? 'partial' : 'none',
          payStatus: total > 0 && paid >= total ? 'paid' : paid > 0 ? 'partial' : 'none',
          invoiceStatus: total > 0 && invoiced >= total ? 'invoiced' : invoiced > 0 ? 'partial' : 'none',
          preDiscountAmount: withPrice ? num(order.taxIncludedTotal) : 0,
          postDiscountAmount: withPrice ? total : 0,
        };
        rows.push({
          ...base,
          receivedAmount: paid,
          unpaidAmount: Math.max(0, total - paid),
          unreceivedAmount: Math.max(0, total - paid),
          uninvoicedAmount: Math.max(0, total - invoiced),
        });
      }
      return rows;
    };
    const inspection: ReportSource = async ({ filters }) => {
      const summaries = await allPages((page) => inspectionReader.list({
        page, pageSize: 1000,
        ...(dayValue(filters.date) === undefined ? {} : { from: dayValue(filters.date), to: dayValue(filters.date) }),
      }));
      const rows: SourceRow[] = [];
      for (const summary of summaries) {
        const detail = await inspectionReader.detail(summary.id);
        for (const line of detail?.lines ?? []) {
          rows.push({
            date: summary.inspectionDate,
            purchaseOrderNo: summary.purchaseOrder.orderNo ?? '',
            item: line.itemId, supplier: summary.supplier?.id ?? '',
            receivedQty: line.receivedQty, inspectionQty: line.inspectionQty,
            qualifiedQty: line.qualifiedQty, releasableQty: line.releasableQty,
            returnQty: line.returnQty, samplingQty: line.samplingQty,
          });
        }
      }
      return rows;
    };
    const stockDocs: ReportSource = async ({ filters, allows, definition }) => {
      const withPrice = await allows('inventory.stockPriceView');
      const docs = await allPages((page) => stockReader.listDocs({
        ...stockDocQuery(filters), page,
      }, withPrice));
      const rows: SourceRow[] = [];
      for (const doc of docs) {
        if (doc.status === 'void') continue; // 作废单不计
        const detail = await stockReader.detailDoc(doc.id, withPrice);
        for (const line of detail?.lines ?? []) {
          const qty = num(line.qty);
          const inQty = doc.docType === 'in' ? qty : 0;
          const outQty = doc.docType === 'out' ? qty : 0;
          rows.push({
            date: dateOf(doc.docDate), item: line.itemId,
            itemCategory: line.itemId,
            partner: doc.partnerId ?? '', docType: doc.docType,
            warehouse: line.warehouseId, project: doc.projectCode ?? '',
            customer: doc.partnerId ?? '', supplier: doc.partnerId ?? '',
            salesOrderNo: doc.customerOrderNo ?? '', purchaseOrderNo: doc.customerOrderNo ?? '',
            inQty, outQty,
            inCount: inQty > 0 ? 1 : 0, outCount: outQty > 0 ? 1 : 0,
            openingQty: 0, closingQty: 0,
            avgPrice: withPrice ? num(line.taxIncludedPrice) : 0,
            taxIncludedPrice: line.taxIncludedPrice ?? null,
            taxExcludedAmount: line.taxExcludedAmount ?? null,
            preDiscountAmount: withPrice ? num(doc.discountAmount) : 0,
            amount: withPrice ? num(line.taxIncludedAmount) : 0,
            status: doc.status,
          });
        }
      }
      if (definition.key === 'stock_summary') {
        const transactions = await allPages((page) => stockReader.listTransactions({
          page, pageSize: 1000,
          ...(dayValue(filters.date) === undefined ? {} : { from: dayValue(filters.date), to: dayValue(filters.date) }),
        }));
        const movement = new Map<string, number>();
        for (const transaction of transactions) {
          const key = `${transaction.itemId}|${transaction.warehouseId}`;
          movement.set(key, (movement.get(key) ?? 0) + num(transaction.qtyDelta));
        }
        for (const row of rows) {
          const key = `${text(row.item)}|${text(row.warehouse)}`;
          row.closingQty = movement.get(key) ?? 0;
          row.openingQty = row.closingQty - num(row.inQty) + num(row.outQty);
        }
      }
      return rows;
    };
    const financeRecords: ReportSource = async ({ definition, filters }) => {
      const query = financeQuery(filters);
      const rows: SourceRow[] = [];
      const incomeDoc = (doc: {
        id: string; date: string; totalAmount: number; customerId: string | null;
        handler: { name: string } | null; projectCode: string | null;
        fundAccountCode: string | null; incomeTypeCode: string | null; payerName: string | null;
      }): SourceRow => ({
        date: doc.date, incomeExpenseType: doc.incomeTypeCode ?? '',
        incomeType: doc.incomeTypeCode ?? '', fundAccount: doc.fundAccountCode ?? '',
        project: doc.projectCode ?? '', handler: doc.handler?.name ?? '',
        customer: doc.customerId ?? '', supplier: '', payer: doc.payerName ?? '',
        payee: '', salesOrder: doc.id,
        receivedAmount: doc.totalAmount, incomeAmount: doc.totalAmount,
        incomeAmountLocal: doc.totalAmount,
        postDiscountAmount: doc.totalAmount, totalIncomeAmount: doc.totalAmount,
        orderTaxIncludedAmount: doc.totalAmount,
      });
      if (['income_expense_detail', 'sales_income_expense', 'income_record_detail'].includes(definition.key)) {
        const docs = await allPages((page) => reconciliationReader.listDocs('income', { ...query, page }));
        for (const doc of docs) {
          if (doc.status === 'void') continue;
          rows.push(incomeDoc(doc));
        }
      }
      if (['income_expense_detail', 'sales_income_expense', 'expense_record_detail'].includes(definition.key)) {
        const records = await allPages((page) => financeReader.list('expense', { ...query, page }));
        for (const record of records) {
          if (record.status === 'void') continue;
          rows.push({
            date: record.date, incomeExpenseType: record.expenseTypeCode ?? '',
            expenseType: record.expenseTypeCode ?? '', fundAccount: record.fundAccountCode ?? '',
            project: record.projectCode ?? '', handler: record.handler?.name ?? '',
            payee: record.payeeName ?? '', customer: '', supplier: record.supplier?.id ?? '',
            expenseAmount: record.totalAmount, expenseAmountLocal: record.totalAmount,
            totalExpenseAmount: record.totalAmount, postDiscountAmount: record.totalAmount,
          });
        }
      }
      if (definition.key === 'invoice_receipt_detail') {
        const records = await allPages((page) => financeReader.list('invoiceReceipt', { ...query, page }));
        for (const record of records) {
          if (record.status === 'void') continue;
          rows.push({
            date: record.date, supplier: record.supplier?.id ?? '',
            handler: record.handler?.name ?? '', project: record.projectCode ?? '',
            invoiceType: record.invoiceTypeCode ?? '', invoiceNo: record.invoiceNo ?? '',
            purchaseOrderNo: record.id,
            orderTaxIncludedAmount: record.totalAmount,
            postDiscountAmount: record.totalAmount,
            receivedInvoiceAmount: record.totalAmount, totalInvoiceAmount: record.totalAmount,
          });
        }
      }
      if (definition.key === 'sale_invoice_detail') {
        const docs = await allPages((page) => reconciliationReader.listDocs('saleInvoice', { ...query, page }));
        for (const doc of docs) {
          if (doc.status === 'void') continue;
          rows.push({
            date: doc.date, customer: doc.customerId ?? '',
            handler: doc.handler?.name ?? '', project: doc.projectCode ?? '',
            invoiceType: doc.invoiceTypeCode ?? '', invoiceNo: doc.invoiceNo ?? '',
            salesOrderNo: doc.id,
            orderTaxIncludedAmount: doc.totalAmount,
            postDiscountAmount: doc.totalAmount,
            invoiceAmount: doc.totalAmount, totalInvoiceAmount: doc.totalAmount,
          });
        }
      }
      return rows;
    };
    const quotations: ReportSource = async ({ filters, allows }) => {
      const withPrice = await allows('salesOrders.viewPrice');
      const summaries = await allPages((page) => quotationReader.list({
        page, pageSize: 1000,
        ...(typeof filters.customer === 'string' ? { customerId: filters.customer } : {}),
        ...(typeof filters.project === 'string' ? { projectCode: filters.project } : {}),
      }));
      const rows: SourceRow[] = [];
      for (const summary of summaries) {
        const detail = await quotationReader.detail(summary.id);
        for (const line of detail?.lines ?? []) {
          rows.push({
            date: summary.quoteDate, customer: summary.customer?.id ?? '',
            item: line.itemId, salesperson: summary.handler?.userId ?? '',
            project: summary.projectCode ?? '',
            qty: line.qty,
            price: withPrice ? line.taxIncludedAmount : 0,
            amount: withPrice ? line.taxIncludedAmount : 0,
          });
        }
      }
      return rows;
    };
    const ledger: ReportSource = async ({ filters }) => {
      const rows = await allPages((page) => orderLedger.list({
        page, pageSize: 1000, days: 30,
        ...(typeof filters.customer === 'string' ? { customerId: filters.customer } : {}),
        ...(typeof filters.project === 'string' ? { projectCode: filters.project } : {}),
      }));
      return rows.map((row) => ({
        date: row.orderDate, salesOrder: row.orderNo, project: row.projectCode ?? '',
        item: row.orderNo, deliveryStatus: row.shipping.status ?? 'none',
        overdue: String(row.overdue),
        baseQty: num(row.shipping.total), shippedQty: num(row.shipping.qty),
        deliveryDays: row.overdueDays ?? 0, overdueDays: row.overdueDays ?? 0,
      }));
    };
    this.sources = {
      purchaseOrderLines: purchaseLines,
      purchaseTracking: tracking,
      inspectionRecords: inspection,
      salesOrderLines: salesLines,
      salesTracking: tracking,
      quotations,
      salesLedger: ledger,
      stockDocs,
      financeRecords,
    };
  }

  private async knex(): Promise<Knex> {
    return await this.services.database.connection().client<Knex>();
  }

  async definition(key: string): Promise<LoadedDefinition | undefined> {
    const knex = await this.knex();
    const row = await knex<DefinitionRow>('report_definitions').where({ key }).first();
    if (row === undefined || row.status !== 'active') return undefined;
    return definitionOf(row);
  }

  async definitions(query: { category?: string; q?: string; page: number; pageSize: number }): Promise<{
    items: LoadedDefinition[]; total: number;
  }> {
    const knex = await this.knex();
    const base = knex<DefinitionRow>('report_definitions').modify((builder) => {
      if (query.category !== undefined) void builder.where('category', query.category);
      if (query.q !== undefined && query.q !== '') void builder.whereILike('key', `%${query.q}%`);
    }).where({ status: 'active' });
    const countRow = await base.clone().clear('select').count('* as count').first() as
      | { count?: string | number } | undefined;
    const rows = await base.clone().orderBy('key').offset((query.page - 1) * query.pageSize)
      .limit(query.pageSize) as DefinitionRow[];
    return { items: rows.map(definitionOf), total: num(countRow?.count) };
  }

  /** 入口动作之外再按 baseActions 二次判定：任一个放行即可。 */
  async assertBase(definition: LoadedDefinition, allows: ActionChecker): Promise<void> {
    const decisions = await Promise.all(definition.baseActions.map((action) => allows(action)));
    if (!decisions.some((allowed) => allowed)) throw new ReportRuleError('report-forbidden');
  }

  /** 请求字段名一律来自定义白名单；列是否在服务端裁掉由动作决定。 */
  validate(definition: LoadedDefinition, input: RunReportInput): void {
    const dimensions = input.dimensions ?? definition.dimensions;
    const measures = input.measures ?? definition.measures;
    const invalid = [
      ...Object.keys(input.filters).filter((key) => !definition.dimensions.includes(key)),
      ...dimensions.filter((key) => !definition.dimensions.includes(key)),
      ...measures.filter((key) => !definition.measures.includes(key)),
    ];
    if (invalid.length > 0) throw new ReportRuleError('field-invalid', invalid.join(','));
    for (const value of Object.values(input.filters)) {
      if (value !== null && !['string', 'number', 'boolean'].includes(typeof value)) {
        throw new ReportRuleError('field-invalid');
      }
    }
    if (!Number.isInteger(input.page) || input.page < 1 ||
        !Number.isInteger(input.pageSize) || input.pageSize < 1 || input.pageSize > 100) {
      throw new ReportRuleError('page-invalid');
    }
  }

  async columnsFor(
    definition: LoadedDefinition,
    dimensions: readonly string[],
    measures: readonly string[],
    allows: ActionChecker,
  ): Promise<readonly ReportColumn[]> {
    const requested = new Set([...dimensions, ...measures]);
    const kept: ReportColumn[] = [];
    for (const column of definition.columns) {
      if (!requested.has(column.key)) continue;
      if (column.requiredActions !== undefined) {
        const checks = await Promise.all(column.requiredActions.map((action) => allows(action)));
        if (!checks.every(Boolean)) continue;
      }
      kept.push(column);
    }
    return kept;
  }

  /** run 与 export 共用的取数与裁列代码；items 的键与 columns 完全一致。 */
  async table(
    definition: LoadedDefinition,
    input: RunReportInput,
    allows: ActionChecker,
  ): Promise<{ columns: readonly ReportColumn[]; rows: readonly Record<string, string | number | null>[] }> {
    this.validate(definition, input);
    const dimensions = input.dimensions ?? definition.dimensions;
    const measures = input.measures ?? definition.measures;
    const columns = await this.columnsFor(definition, dimensions, measures, allows);
    const source = this.sources[definition.source];
    if (source === undefined) throw new ReportRuleError('export-failed', `unknown source ${definition.source}`);
    const sourceRows = (await source({ definition, filters: input.filters, allows }))
      .filter((row) => matches(input.filters, row));
    const grouped = new Map<string, SourceRow>();
    for (const row of sourceRows) {
      const key = dimensions.map((dimension) => String(row[dimension] ?? '')).join('\u0000');
      const current = grouped.get(key);
      if (current === undefined) {
        grouped.set(key, { ...row });
        continue;
      }
      for (const measure of measures) {
        current[measure] = num(current[measure]) + num(row[measure]);
      }
    }
    const keptKeys = columns.map((column) => column.key);
    const rows = [...grouped.values()].map((row) =>
      Object.fromEntries(keptKeys.map((key): [string, string | number | null] => {
        const value = row[key] ?? null;
        return [key, typeof value === 'boolean' ? String(value) : value];
      })));
    return { columns, rows };
  }

  async run(
    definition: LoadedDefinition,
    input: RunReportInput,
    allows: ActionChecker,
  ): Promise<ReportResult> {
    const { columns, rows } = await this.table(definition, input, allows);
    const start = (input.page - 1) * input.pageSize;
    return {
      columns,
      items: rows.slice(start, start + input.pageSize),
      total: rows.length,
      page: input.page,
      pageSize: input.pageSize,
    };
  }

  async favorites(userId: string): Promise<readonly ReportBrief[]> {
    const knex = await this.knex();
    const rows = await knex<FavoriteRow>('report_favorites')
      .select('report_key').where({ user_id: userId }).orderBy('created_at', 'desc');
    const keys = rows.map((row) => row.report_key);
    if (keys.length === 0) return [];
    const definitions = await knex<DefinitionRow>('report_definitions').whereIn('key', keys);
    return definitions.map((row) => ({
      key: row.key, titleKey: row.title_key, category: row.category,
    }));
  }

  async favorite(userId: string, key: string): Promise<void> {
    const definition = await this.definition(key);
    if (definition === undefined) throw new ReportRuleError('report-not-found');
    const knex = await this.knex();
    await knex('report_favorites').insert({
      id: randomUUID(), user_id: userId, report_key: key, created_at: new Date(),
    }).onConflict(['user_id', 'report_key']).ignore();
  }

  async unfavorite(userId: string, key: string): Promise<void> {
    const knex = await this.knex();
    await knex('report_favorites').where({ user_id: userId, report_key: key }).delete();
  }

  /** 只追加：筛选值不入库，只留摘要与行数；事务由调用方包住 CSV 生成。 */
  async insertTrace(transaction: DatabaseConnection, trace: ExportTraceInput): Promise<void> {
    const knex = await transaction.client<Knex>();
    await knex('report_export_traces').insert({
      id: randomUUID(), user_id: trace.userId, report_key: trace.reportKey,
      at: trace.at, format: 'csv', filters_hash: trace.filtersHash, row_count: trace.rowCount,
    });
  }

  async traces(query: {
    from?: string; to?: string; reportKey?: string; userId?: string;
    page: number; pageSize: number;
  }, actor: string, unrestricted: boolean): Promise<{ items: readonly ExportTrace[]; total: number }> {
    const knex = await this.knex();
    const base = knex<TraceRow>('report_export_traces as trace')
      .leftJoin('user', 'user.id', 'trace.user_id')
      .select(
        'trace.id', 'trace.user_id as userId', 'trace.report_key as reportKey',
        'trace.at', 'trace.format', 'trace.filters_hash as filtersHash',
        'trace.row_count as rowCount', 'user.name as userName',
      )
      .modify((builder) => {
        // 普通角色即使传了别人的 userId 也只回自己的；root 不带 userId 时看全部。
        if (!unrestricted) void builder.where('trace.user_id', actor);
        else if (query.userId !== undefined) void builder.where('trace.user_id', query.userId);
        if (query.reportKey !== undefined) void builder.where('trace.report_key', query.reportKey);
        if (query.from !== undefined) void builder.where('trace.at', '>=', query.from);
        if (query.to !== undefined) void builder.where('trace.at', '<=', `${query.to}T23:59:59Z`);
      });
    const countRow = await base.clone().clear('select').count('* as count').first() as
      | { count?: string | number } | undefined;
    const rows = await base.clone().orderBy('trace.at', 'desc')
      .offset((query.page - 1) * query.pageSize).limit(query.pageSize) as TraceViewRow[];
    return {
      items: rows.map((row) => ({
        id: row.id, userId: row.userId, reportKey: row.reportKey,
        at: dateOf(row.at), format: 'csv' as const, filtersHash: row.filtersHash,
        rowCount: num(row.rowCount),
        user: { userId: row.userId, name: row.userName ?? '' },
      })),
      total: num(countRow?.count),
    };
  }
}

export const reportEngineToken: ServiceToken<DatabaseReportEngine> =
  createServiceToken<DatabaseReportEngine>('app/report-engine');

export default class ReportEngineProvider extends ServiceProvider<Application> {
  public readonly name = 'app.report-engine';

  public override register(): void {
    this.app.container.singleton(reportEngineToken, () => {
      const engine = new DatabaseReportEngine({
        database: this.app.container.resolve(databaseManagerToken),
        orderReader: this.app.container.resolve(orderReaderToken),
        stockReader: this.app.container.resolve(stockReaderToken),
        financeReader: this.app.container.resolve(financeReaderToken),
        reconciliationReader: this.app.container.resolve(reconciliationReaderToken),
        orderLedger: this.app.container.resolve(orderLedgerToken),
        returnsReader: this.app.container.resolve(returnsReaderToken),
        inspectionReader: this.app.container.resolve(inspectionReaderToken),
        quotationReader: this.app.container.resolve(quotationReaderToken),
      });
      // 定义随种子入库；已有环境由升级命令补齐，运行时以代码常量为兜底。
      return engine;
    });
  }
}

export { REPORT_DEFINITIONS };
