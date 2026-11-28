import type { Application } from '@nocobase/app-server/application';
import { databaseManagerToken, type DatabaseConnection, type DatabaseManager } from '@nocobase/db';
import {
  createServiceToken,
  ServiceProvider,
  type ServiceToken,
} from '@nocobase/service-provider';
import { randomUUID } from 'node:crypto';
import type { Knex } from 'knex';

import { assertActiveCodes, BizDictRuleError } from './biz-dict.js';
import { CODE_PREFIXES, codeServiceToken, type CodeService } from './codes.js';
import { docFilesToken, type DocFiles, type DocFileView } from './doc-files.js';
import { roundAmount } from './doc-amounts.js';

/**
 * R-065 复刻波 2：收入、开票、应收应付对账的读写服务。
 *
 * 与第一片同一口径：回写是重算 —— 事务里先锁住上游头（订单或对账单），再按
 * 「状态 confirmed、指向它的行」求和写回。作废、重复登记与并发都不会漂。
 * 对账单的明细是建单时摊开的只读快照，上游再变不回填。
 */
export type DocKind = 'income' | 'saleInvoice';
export type ReconKind = 'receivable' | 'payable';
export type FinanceBindMode = 'sales_order' | 'receivable_recon' | 'payable_recon' | 'none';
export type ReconStatus = 'unsettled' | 'partial' | 'settled';

export type ReconciliationRuleCode =
  | 'finance-not-found'
  | 'recon-not-found'
  | 'not-draft'
  | 'voided'
  | 'recon-not-draft'
  | 'recon-voided'
  | 'recon-not-open'
  | 'bind-mixed'
  | 'line-duplicated'
  | 'line-invalid'
  | 'recon-empty'
  | 'source-invalid'
  | 'customer-mixed'
  | 'supplier-mixed'
  | 'dict-code-invalid'
  | 'person-invalid'
  | 'partner-invalid';

export class ReconciliationRuleError extends Error {
  public constructor(
    readonly code: ReconciliationRuleCode,
    readonly detail?: string,
  ) {
    super(detail === undefined
      ? `Reconciliation rule violated: ${code}`
      : `Reconciliation rule violated: ${code} (${detail})`);
    this.name = 'ReconciliationRuleError';
  }
}

function fail(code: ReconciliationRuleCode, detail?: string): never {
  throw new ReconciliationRuleError(code, detail);
}

const REASON: Readonly<Record<ReconciliationRuleCode, string>> = {
  'finance-not-found': 'FINANCE_NOT_FOUND',
  'recon-not-found': 'RECON_NOT_FOUND',
  'not-draft': 'FINANCE_NOT_DRAFT',
  voided: 'FINANCE_VOIDED',
  'recon-not-draft': 'RECON_NOT_DRAFT',
  'recon-voided': 'RECON_VOIDED',
  'recon-not-open': 'FINANCE_RECON_NOT_OPEN',
  'bind-mixed': 'FINANCE_BIND_MIXED',
  'line-duplicated': 'FINANCE_LINE_DUPLICATED',
  'line-invalid': 'FINANCE_LINE_INVALID',
  'recon-empty': 'RECON_EMPTY',
  'source-invalid': 'RECON_SOURCE_INVALID',
  'customer-mixed': 'FINANCE_CUSTOMER_MIXED',
  'supplier-mixed': 'FINANCE_SUPPLIER_MIXED',
  'dict-code-invalid': 'FINANCE_DICT_CODE_INVALID',
  'person-invalid': 'FINANCE_PERSON_INVALID',
  'partner-invalid': 'FINANCE_PARTNER_INVALID',
};

export const reasonOf = (code: ReconciliationRuleCode): string => REASON[code];

export interface PersonRef { readonly userId: string; readonly name: string; }
export interface PartnerRef { readonly id: string; readonly code: string; readonly name: string; }

export interface ReconciliationLine {
  readonly id: string;
  readonly recordId: string;
  readonly salesOrderId: string | null;
  readonly receivableReconId: string | null;
  readonly amount: number;
  readonly orderPayableAmount: number;
  readonly receivedBefore?: number;
  readonly invoicedBefore?: number;
  readonly note: string | null;
}

export interface DocRecord {
  readonly id: string;
  readonly docNo: string;
  readonly date: string;
  readonly status: 'draft' | 'confirmed' | 'void';
  readonly bindMode: FinanceBindMode;
  readonly customerId: string | null;
  readonly customer: PartnerRef | null;
  readonly payerName: string | null;
  readonly invoiceToName: string | null;
  readonly invoiceNo: string | null;
  readonly incomeTypeCode: string | null;
  readonly incomeTypeLabel: string | null;
  readonly invoiceTypeCode: string | null;
  readonly invoiceTypeLabel: string | null;
  readonly fundAccountCode: string | null;
  readonly fundAccountLabel: string | null;
  readonly handler: PersonRef | null;
  readonly projectCode: string | null;
  readonly projectLabel: string | null;
  readonly remark: string;
  readonly totalAmount: number;
  readonly confirmedAt: string | null;
  readonly voidedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lines: readonly ReconciliationLine[];
  readonly files?: readonly DocFileView[];
}

export interface SnapshotLine {
  readonly id: string;
  readonly reconId: string;
  readonly side: 'out' | 'return' | 'in';
  readonly sourceDocId: string;
  readonly itemId: string;
  readonly item: { readonly id: string; readonly code: string; readonly name: string; readonly spec: string | null; readonly unitCode: string };
  readonly qty: number;
  readonly taxRate: number | null;
  readonly taxIncludedPrice: number | null;
  readonly taxIncludedAmount: number | null;
  readonly note: string | null;
}

export interface ReconRecord {
  readonly id: string;
  readonly docNo: string;
  readonly reconDate: string;
  readonly expectedPayDate: string | null;
  readonly periodAmount: number;
  readonly status: 'draft' | 'confirmed' | 'void';
  readonly reconStatus: ReconStatus;
  readonly reconciledIncomeAmount?: number;
  readonly reconciledInvoiceAmount?: number;
  readonly reconciledPaidAmount?: number;
  readonly customer: PartnerRef | null;
  readonly supplier: PartnerRef | null;
  readonly contactName: string | null;
  readonly phone: string | null;
  readonly invoiceTypeCode: string | null;
  readonly handler: PersonRef | null;
  readonly projectCode: string | null;
  readonly remark: string;
  readonly confirmedAt: string | null;
  readonly voidedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly snapshotLines: readonly SnapshotLine[];
  readonly files?: readonly DocFileView[];
}

/** 财务读销售订单的窄形状：八列头 + 客户三列摘要。 */
export interface ReceivableOrder {
  readonly id: string;
  readonly orderNo: string;
  readonly orderDate: string;
  readonly status: string;
  readonly customerId: string | null;
  readonly payableTotal: number | null;
  readonly receivedAmount: number;
  readonly invoicedAmount: number;
  readonly customer: PartnerRef | null;
}

/** 对账建单选已过账单据的窄读数：不回明细、单价、经办人。 */
export interface SourceDoc {
  readonly id: string;
  readonly docNo: string;
  readonly docDate: string | null;
  readonly partnerId: string | null;
  readonly partnerName: string | null;
  readonly reason: string;
  readonly status: string;
  readonly totalQty: number | null;
}

export interface ReconOption {
  readonly id: string;
  readonly docNo: string;
  readonly reconDate: string;
  readonly periodAmount: number;
  reconciledIncomeAmount?: number;
  reconciledInvoiceAmount?: number;
  reconciledPaidAmount?: number;
}

export interface PageQuery {
  readonly page: number;
  readonly pageSize: number;
  readonly status?: string;
  readonly customerId?: string;
  readonly supplierId?: string;
  readonly typeCode?: string;
  readonly bindMode?: FinanceBindMode;
  readonly from?: string;
  readonly to?: string;
  readonly q?: string;
}

export interface DocLineInput {
  readonly salesOrderId?: string | null;
  readonly receivableReconId?: string | null;
  readonly amount: number;
  readonly note?: string | null;
}
export interface CreateDocInput {
  readonly date: string;
  readonly bindMode: FinanceBindMode;
  readonly typeCode?: string | null;
  readonly fundAccountCode?: string | null;
  readonly payerName?: string | null;
  readonly invoiceToName?: string | null;
  readonly invoiceNo?: string | null;
  readonly customerId?: string | null;
  readonly handlerUserId?: string | null;
  readonly projectCode?: string | null;
  readonly remark?: string;
  readonly fileIds?: readonly string[];
  readonly confirm?: boolean;
  readonly amount?: number;
  readonly lines?: readonly DocLineInput[];
}
export type UpdateDocInput = Partial<CreateDocInput>;

export interface CreateReconInput {
  readonly reconDate: string;
  readonly expectedPayDate?: string | null;
  readonly periodAmount: number;
  readonly customerId?: string | null;
  readonly supplierId?: string | null;
  readonly contactName?: string | null;
  readonly phone?: string | null;
  readonly invoiceTypeCode?: string | null;
  readonly outStockDocIds?: readonly string[];
  readonly returnDocIds?: readonly string[];
  readonly purchaseStockDocIds?: readonly string[];
  readonly handlerUserId?: string | null;
  readonly projectCode?: string | null;
  readonly remark?: string;
  readonly fileIds?: readonly string[];
}
export type UpdateReconInput = Partial<CreateReconInput>;

const DOC_CONFIG: Readonly<Record<DocKind, {
  header: string; headerTable: string; lines: string; lineTable: string;
  date: 'income_date' | 'invoice_date'; prefix: string;
  before: 'received_before' | 'invoiced_before'; writeBack: 'received_amount' | 'invoiced_amount';
  ownerType: string; dictType: string; typeColumn: 'income_type_code' | 'invoice_type_code';
  reconColumn: 'reconciled_income_amount' | 'reconciled_invoice_amount';
}>> = {
  income: {
    header: 'incomeRecords', headerTable: 'income_records',
    lines: 'incomeRecordLines', lineTable: 'income_record_lines',
    date: 'income_date', prefix: CODE_PREFIXES.income,
    before: 'received_before', writeBack: 'received_amount',
    ownerType: 'income', dictType: 'income_type', typeColumn: 'income_type_code',
    reconColumn: 'reconciled_income_amount',
  },
  saleInvoice: {
    header: 'saleInvoiceRecords', headerTable: 'sale_invoice_records',
    lines: 'saleInvoiceRecordLines', lineTable: 'sale_invoice_record_lines',
    date: 'invoice_date', prefix: CODE_PREFIXES.saleInvoice,
    before: 'invoiced_before', writeBack: 'invoiced_amount',
    ownerType: 'sale_invoice', dictType: 'invoice_type', typeColumn: 'invoice_type_code',
    reconColumn: 'reconciled_invoice_amount',
  },
};

const RECON_CONFIG: Readonly<Record<ReconKind, {
  collection: string; table: string; prefix: string; partnerColumn: 'customer_id' | 'supplier_id';
}>> = {
  receivable: { collection: 'receivableRecons', table: 'receivable_recons', prefix: CODE_PREFIXES.receivableRecon, partnerColumn: 'customer_id' },
  payable: { collection: 'payableRecons', table: 'payable_recons', prefix: CODE_PREFIXES.payableRecon, partnerColumn: 'supplier_id' },
};

const num = (value: unknown): number => Number(value);
const iso = (value: string | Date | null | undefined): string | null =>
  value === null || value === undefined ? null : value instanceof Date ? value.toISOString() : String(value);
const day = (value: string | Date): string =>
  typeof value === 'string' ? value.slice(0, 10) : value.toISOString().slice(0, 10);
const nullableNum = (value: unknown): number | null =>
  value === null || value === undefined ? null : num(value);

async function countOf(base: Knex.QueryBuilder): Promise<number> {
  const row = (await base.clone().clear('select').count('* as count').first()) as
    | { count?: string | number }
    | undefined;
  return Number(row?.count ?? 0);
}

/** 只有 finance 拿得到金额列；窄读里只回三个键，不含邮箱、手机号、部门。 */
async function partnerOf(knex: Knex, id: string | null): Promise<PartnerRef | null> {
  if (id === null) return null;
  const row = await knex<{ id: string; code: string; name: string }>('partners')
    .select('id', 'code', 'name').where({ id }).first();
  return row === undefined ? null : { id: row.id, code: row.code, name: row.name };
}

async function personOf(knex: Knex, userId: string | null): Promise<PersonRef | null> {
  if (userId === null) return null;
  const row = await knex<{ id: string; name: string | null }>('user')
    .select('id', 'name').where({ id: userId }).first();
  return { userId, name: row?.name ?? userId };
}

async function labelsOf(knex: Knex, pairs: readonly (readonly [string, string | null])[]): Promise<Map<string, string>> {
  const wanted = [...new Set(pairs.filter(([, code]) => code !== null).map(([type, code]) => `${type}|${code}`))];
  if (wanted.length === 0) return new Map();
  const result = await knex.raw<{ rows?: { dict_type: string; code: string; name: string }[] }>(
    'select dict_type, code, name from biz_dict_entries',
  );
  return new Map((result.rows ?? [])
    .filter((entry) => wanted.includes(`${entry.dict_type}|${entry.code}`))
    .map((entry) => [`${entry.dict_type}|${entry.code}`, entry.name]));
}

/**
 * 两个核销列各自与本期金额比：两列都到了才 settled；只有一列有进展、或一列到了另一列
 * 没到，都是 partial；两列都是 0 是 unsettled。金额是两位小数，比较留 0.005 容差，
 * 避免浮点误差把差一点的数判成没到。宁可少报，不可多报「已核销」。
 */
export function stateOfRecon(
  periodAmount: number,
  first: number,
  second: number,
): ReconStatus {
  if (first === 0 && second === 0) return 'unsettled';
  const tolerance = 0.005;
  if (first + tolerance >= periodAmount && second + tolerance >= periodAmount) return 'settled';
  return 'partial';
}

interface DocHeaderRow {
  id: string; doc_no: string; status: string;
  income_date?: string | Date; invoice_date?: string | Date;
  income_type_code?: string | null; invoice_type_code?: string | null;
  fund_account_code?: string | null;
  payer_name?: string | null; invoice_to_name?: string | null; invoice_no?: string | null;
  customer_id: string | null; bind_mode: string;
  handler_user_id: string | null; project_code: string | null; remark: string;
  total_amount: string | number; created_by_id: string;
  confirmed_at: string | Date | null; voided_at: string | Date | null;
  created_at: string | Date; updated_at: string | Date;
}
interface DocLineRow {
  id: string; record_id: string;
  sales_order_id: string | null; receivable_recon_id: string | null;
  order_payable_amount: string | number;
  received_before?: string | number; invoiced_before?: string | number;
  amount: string | number; note: string | null;
}
interface ReconHeaderRow {
  id: string; doc_no: string; recon_date: string | Date; expected_pay_date: string | Date | null;
  customer_id: string | null; supplier_id: string | null;
  contact_name: string | null; phone: string | null;
  period_amount: string | number; status: string; recon_status: string;
  reconciled_income_amount?: string | number;
  reconciled_invoice_amount?: string | number;
  reconciled_paid_amount?: string | number;
  invoice_type_code?: string | null;
  handler_user_id: string | null; project_code: string | null; remark: string;
  created_by_id: string;
  confirmed_at: string | Date | null; voided_at: string | Date | null;
  created_at: string | Date; updated_at: string | Date;
}
interface SnapshotRow {
  id: string; recon_id: string; side: 'out' | 'return' | 'in'; source_doc_id: string;
  item_id: string; item_code: string; item_name: string; item_spec: string | null;
  unit_code: string; qty: string | number; tax_rate: string | number | null;
  tax_included_price: string | number | null; tax_included_amount: string | number | null;
  note: string | null;
}

export class DatabaseReconciliationReader {
  public constructor(
    private readonly database: DatabaseManager,
    private readonly docFiles: DocFiles,
  ) {}

  private async knex(): Promise<Knex> {
    return await this.database.connection().client<Knex>();
  }

  public async listDocs(kind: DocKind, query: PageQuery) {
    const config = DOC_CONFIG[kind];
    const knex = await this.knex();
    const base = knex<DocHeaderRow>(config.headerTable).modify((builder) => {
      if (query.status !== undefined) void builder.where('status', query.status);
      if (query.customerId !== undefined) void builder.where('customer_id', query.customerId);
      if (query.bindMode !== undefined) void builder.where('bind_mode', query.bindMode);
      if (query.typeCode !== undefined) void builder.where(config.typeColumn, query.typeCode);
      if (query.from !== undefined) void builder.where(config.date, '>=', query.from);
      if (query.to !== undefined) void builder.where(config.date, '<=', query.to);
      if (query.q !== undefined && query.q !== '') {
        void builder.where((inner) => {
          inner.whereILike('doc_no', `%${query.q}%`)
            .orWhereILike(kind === 'income' ? 'payer_name' : 'invoice_to_name', `%${query.q}%`)
            .orWhereILike('remark', `%${query.q}%`);
          if (kind === 'saleInvoice') inner.orWhereILike('invoice_no', `%${query.q}%`);
        });
      }
    });
    const total = await countOf(base);
    const rows = (await base.clone().orderBy(config.date, 'desc').orderBy('id', 'asc')
      .limit(query.pageSize).offset((query.page - 1) * query.pageSize)) as DocHeaderRow[];
    const items: DocRecord[] = [];
    for (const row of rows) items.push(await this.docView(kind, knex, row, [], false));
    return { items, total };
  }

  public async detailDoc(kind: DocKind, id: string, knexArg?: Knex): Promise<DocRecord | undefined> {
    const knex = knexArg ?? await this.knex();
    const config = DOC_CONFIG[kind];
    const row = await knex<DocHeaderRow>(config.headerTable).where({ id }).first();
    if (row === undefined) return undefined;
    const lines = await knex<DocLineRow>(config.lineTable).where({ record_id: id }).orderBy('id', 'asc');
    return await this.docView(kind, knex, row, lines, true);
  }

  private async docView(
    kind: DocKind, knex: Knex, row: DocHeaderRow,
    lines: readonly DocLineRow[], withDetail: boolean,
  ): Promise<DocRecord> {
    const config = DOC_CONFIG[kind];
    const orderIds = [...new Set(lines.map((line) => line.sales_order_id).filter((id): id is string => id !== null))];
    const reconIds = [...new Set(lines.map((line) => line.receivable_recon_id).filter((id): id is string => id !== null))];
    const orderNos = new Map<string, string>();
    if (orderIds.length > 0) {
      const orders = await knex<{ id: string; order_no: string }>('sales_orders')
        .select('id', 'order_no').whereIn('id', orderIds);
      for (const order of orders) orderNos.set(order.id, order.order_no);
    }
    const reconNos = new Map<string, string>();
    if (reconIds.length > 0) {
      const recons = await knex<{ id: string; doc_no: string }>('receivable_recons')
        .select('id', 'doc_no').whereIn('id', reconIds);
      for (const recon of recons) reconNos.set(recon.id, recon.doc_no);
    }
    const labels = await labelsOf(knex, [
      ['project', row.project_code],
      [config.dictType, kind === 'income' ? row.income_type_code ?? null : row.invoice_type_code ?? null],
      ...(kind === 'income' ? [['fund_account', row.fund_account_code ?? null] as const] : []),
    ]);
    const lineViews: ReconciliationLine[] = lines.map((line) => ({
      id: line.id,
      recordId: line.record_id,
      salesOrderId: line.sales_order_id,
      receivableReconId: line.receivable_recon_id,
      amount: num(line.amount),
      orderPayableAmount: num(line.order_payable_amount),
      ...(kind === 'income'
        ? { receivedBefore: num(line.received_before ?? 0) }
        : { invoicedBefore: num(line.invoiced_before ?? 0) }),
      note: line.note,
    }));
    // 列表里同样带 lines 键（空数组），但没有 files，也没有订单号查询的额外负担。
    void orderNos; void reconNos;
    return {
      id: row.id,
      docNo: row.doc_no,
      date: day(config.date === 'income_date' ? row.income_date! : row.invoice_date!),
      status: row.status as DocRecord['status'],
      bindMode: row.bind_mode as FinanceBindMode,
      customerId: row.customer_id,
      customer: await partnerOf(knex, row.customer_id),
      payerName: row.payer_name ?? null,
      invoiceToName: row.invoice_to_name ?? null,
      invoiceNo: row.invoice_no ?? null,
      incomeTypeCode: row.income_type_code ?? null,
      incomeTypeLabel: row.income_type_code === null ? null : labels.get(`income_type|${row.income_type_code}`) ?? null,
      invoiceTypeCode: row.invoice_type_code ?? null,
      invoiceTypeLabel: row.invoice_type_code === null ? null : labels.get(`invoice_type|${row.invoice_type_code}`) ?? null,
      fundAccountCode: row.fund_account_code ?? null,
      fundAccountLabel: row.fund_account_code === null ? null : labels.get(`fund_account|${row.fund_account_code}`) ?? null,
      handler: await personOf(knex, row.handler_user_id),
      projectCode: row.project_code,
      projectLabel: row.project_code === null ? null : labels.get(`project|${row.project_code}`) ?? null,
      remark: row.remark,
      totalAmount: num(row.total_amount),
      confirmedAt: iso(row.confirmed_at),
      voidedAt: iso(row.voided_at),
      createdAt: String(iso(row.created_at)),
      updatedAt: String(iso(row.updated_at)),
      lines: lineViews,
      ...(withDetail ? { files: await this.docFiles.filesOf(knex, config.ownerType, row.id) } : {}),
    };
  }

  public async listRecons(kind: ReconKind, query: PageQuery) {
    const knex = await this.knex();
    const config = RECON_CONFIG[kind];
    const base = knex<ReconHeaderRow>(config.table).modify((builder) => {
      if (query.status !== undefined) void builder.where('status', query.status);
      if (kind === 'receivable' && query.customerId !== undefined) void builder.where('customer_id', query.customerId);
      if (kind === 'payable' && query.supplierId !== undefined) void builder.where('supplier_id', query.supplierId);
      if (query.typeCode !== undefined) void builder.where('invoice_type_code', query.typeCode);
      if (query.from !== undefined) void builder.where('recon_date', '>=', query.from);
      if (query.to !== undefined) void builder.where('recon_date', '<=', query.to);
      if (query.q !== undefined && query.q !== '') {
        void builder.where((inner) => {
          inner.whereILike('doc_no', `%${query.q}%`).orWhereILike('remark', `%${query.q}%`);
          inner.orWhereExists((sub) => {
            sub.select('id').from('partners')
              .whereRaw(`partners.id = ${config.table}.${config.partnerColumn}`)
              .whereILike('name', `%${query.q}%`);
          });
        });
      }
    });
    const total = await countOf(base);
    const rows = (await base.clone().orderBy('recon_date', 'desc').orderBy('id', 'asc')
      .limit(query.pageSize).offset((query.page - 1) * query.pageSize)) as ReconHeaderRow[];
    const items: ReconRecord[] = [];
    for (const row of rows) items.push(await this.reconView(kind, knex, row, false));
    return { items, total };
  }

  /** 财务专用窄读：对账建单勾选已过账的销售出库单或采购入库单。 */
  public async sourceDocs(kind: 'out' | 'in', query: PageQuery) {
    const knex = await this.knex();
    const base = knex<{
      id: string; doc_no: string; doc_date: string | Date | null;
      partner_id: string | null; reason: string; status: string;
      total_qty: string | number | null;
    }>('stock_docs').modify((builder) => {
      void builder.where('doc_type', kind).where('status', 'posted');
      if (query.q !== undefined && query.q !== '') void builder.whereILike('doc_no', `%${query.q}%`);
    });
    const total = await countOf(base);
    const rows = (await base.clone()
      .select('id', 'doc_no', 'doc_date', 'partner_id', 'reason', 'status', 'total_qty')
      .orderBy('doc_date', 'desc').orderBy('id', 'asc')
      .limit(query.pageSize).offset((query.page - 1) * query.pageSize)) as {
        id: string; doc_no: string; doc_date: string | Date | null;
        partner_id: string | null; reason: string; status: string;
        total_qty: string | number | null;
      }[];
    const ids = [...new Set(rows.map((row) => row.partner_id).filter((id): id is string => id !== null))];
    const names = new Map<string, string>();
    if (ids.length > 0) {
      const partners = await knex<{ id: string; name: string }>('partners')
        .select('id', 'name').whereIn('id', ids);
      for (const partner of partners) names.set(partner.id, partner.name);
    }
    const items: SourceDoc[] = rows.map((row) => ({
      id: row.id, docNo: row.doc_no,
      docDate: row.doc_date === null ? null : day(row.doc_date),
      partnerId: row.partner_id,
      partnerName: row.partner_id === null ? null : names.get(row.partner_id) ?? null,
      reason: row.reason, status: row.status,
      totalQty: row.total_qty === null || row.total_qty === undefined ? null : num(row.total_qty),
    }));
    return { items, total };
  }

  /** 财务专用窄读：对账单的客户/供应商下拉，只有 id、code、name。 */
  public async partnerOptions(kind: 'customer' | 'supplier', query: PageQuery) {
    const knex = await this.knex();
    const base = knex<{ id: string; code: string; name: string }>('partners')
      .where(kind === 'customer' ? 'is_customer' : 'is_supplier', true)
      .modify((builder) => {
        if (query.q !== undefined && query.q !== '') {
          void builder.where((inner) => {
            inner.whereILike('code', `%${query.q}%`).orWhereILike('name', `%${query.q}%`);
          });
        }
      });
    const total = await countOf(base);
    const rows = (await base.clone().select('id', 'code', 'name')
      .orderBy('code', 'asc').orderBy('id', 'asc')
      .limit(query.pageSize).offset((query.page - 1) * query.pageSize)) as {
        id: string; code: string; name: string;
      }[];
    return { items: rows.map((row) => ({ id: row.id, code: row.code, name: row.name })), total };
  }

  public async detailRecon(kind: ReconKind, id: string, knexArg?: Knex): Promise<ReconRecord | undefined> {
    const knex = knexArg ?? await this.knex();
    const row = await knex<ReconHeaderRow>(RECON_CONFIG[kind].table).where({ id }).first();
    if (row === undefined) return undefined;
    const snapshots = await knex<SnapshotRow>('recon_snapshot_lines')
      .where({ recon_id: id }).orderBy('id', 'asc');
    return await this.reconView(kind, knex, row, true, snapshots);
  }

  private async reconView(
    kind: ReconKind, knex: Knex, row: ReconHeaderRow,
    withDetail: boolean, snapshots: readonly SnapshotRow[] = [],
  ): Promise<ReconRecord> {
    const partnerId = kind === 'receivable' ? row.customer_id : row.supplier_id;
    const snapshotLines: SnapshotLine[] = snapshots.map((line) => ({
      id: line.id,
      reconId: line.recon_id,
      side: line.side,
      sourceDocId: line.source_doc_id,
      itemId: line.item_id,
      item: {
        id: line.item_id, code: line.item_code, name: line.item_name,
        spec: line.item_spec, unitCode: line.unit_code,
      },
      qty: num(line.qty),
      taxRate: nullableNum(line.tax_rate),
      taxIncludedPrice: nullableNum(line.tax_included_price),
      taxIncludedAmount: nullableNum(line.tax_included_amount),
      note: line.note,
    }));
    const common = {
      id: row.id,
      docNo: row.doc_no,
      reconDate: day(row.recon_date),
      expectedPayDate: row.expected_pay_date === null ? null : day(row.expected_pay_date),
      periodAmount: num(row.period_amount),
      status: row.status as ReconRecord['status'],
      reconStatus: row.recon_status as ReconStatus,
      customer: kind === 'receivable' ? await partnerOf(knex, partnerId) : null,
      supplier: kind === 'payable' ? await partnerOf(knex, partnerId) : null,
      contactName: row.contact_name,
      phone: row.phone,
      invoiceTypeCode: row.invoice_type_code ?? null,
      handler: await personOf(knex, row.handler_user_id),
      projectCode: row.project_code,
      remark: row.remark,
      confirmedAt: iso(row.confirmed_at),
      voidedAt: iso(row.voided_at),
      createdAt: String(iso(row.created_at)),
      updatedAt: String(iso(row.updated_at)),
      snapshotLines,
      ...(withDetail ? { files: await this.docFiles.filesOf(knex, RECON_CONFIG[kind].collection, row.id) } : {}),
    };
    if (kind === 'receivable') {
      return {
        ...common,
        reconciledIncomeAmount: num(row.reconciled_income_amount ?? 0),
        reconciledInvoiceAmount: num(row.reconciled_invoice_amount ?? 0),
      };
    }
    return {
      ...common,
      reconciledPaidAmount: num(row.reconciled_paid_amount ?? 0),
      reconciledInvoiceAmount: num(row.reconciled_invoice_amount ?? 0),
    };
  }

  /** 财务读销售订单：八列头 + 客户三列；没有明细、单价、备注、经办人。 */
  public async receivableOrders(query: PageQuery) {
    const knex = await this.knex();
    const base = knex<{
      id: string; order_no: string; order_date: string | Date; status: string;
      customer_id: string | null; payable_total: string | number | null;
      received_amount: string | number; invoiced_amount: string | number;
    }>('sales_orders').modify((builder) => {
      void builder.whereNotIn('status', ['draft', 'cancelled']);
      if (query.customerId !== undefined) void builder.where('customer_id', query.customerId);
      if (query.status !== undefined) void builder.where('status', query.status);
      if (query.q !== undefined && query.q !== '') {
        void builder.where((inner) => {
          inner.whereILike('order_no', `%${query.q}%`).orWhereExists((sub) => {
            sub.select('id').from('partners')
              .whereRaw('partners.id = sales_orders.customer_id')
              .whereILike('name', `%${query.q}%`);
          });
        });
      }
    });
    const total = await countOf(base);
    const rows = (await base.clone().orderBy('created_at', 'desc').orderBy('id', 'asc')
      .limit(query.pageSize).offset((query.page - 1) * query.pageSize)) as readonly {
        id: string; order_no: string; order_date: string | Date; status: string;
        customer_id: string | null; payable_total: string | number | null;
        received_amount: string | number; invoiced_amount: string | number;
      }[];
    const items: ReceivableOrder[] = [];
    for (const row of rows) {
      items.push({
        id: row.id,
        orderNo: row.order_no,
        orderDate: day(row.order_date),
        status: row.status,
        customerId: row.customer_id,
        payableTotal: nullableNum(row.payable_total),
        receivedAmount: num(row.received_amount ?? 0),
        invoicedAmount: num(row.invoiced_amount ?? 0),
        customer: await partnerOf(knex, row.customer_id),
      });
    }
    return { items, total };
  }

  public async reconOptions(kind: ReconKind, query: PageQuery) {
    const knex = await this.knex();
    const config = RECON_CONFIG[kind];
    const base = knex<ReconHeaderRow>(config.table).modify((builder) => {
      void builder.where('status', 'confirmed');
      if (kind === 'receivable' && query.customerId !== undefined) void builder.where('customer_id', query.customerId);
      if (kind === 'payable' && query.supplierId !== undefined) void builder.where('supplier_id', query.supplierId);
      if (query.q !== undefined && query.q !== '') void builder.whereILike('doc_no', `%${query.q}%`);
    });
    const total = await countOf(base);
    const rows = (await base.clone().orderBy('recon_date', 'desc').orderBy('id', 'asc')
      .limit(query.pageSize).offset((query.page - 1) * query.pageSize)) as ReconHeaderRow[];
    const items: ReconOption[] = rows.map((row) => {
      const option: ReconOption = {
        id: row.id, docNo: row.doc_no, reconDate: day(row.recon_date),
        periodAmount: num(row.period_amount),
      };
      if (kind === 'receivable') {
        option.reconciledIncomeAmount = num(row.reconciled_income_amount ?? 0);
        option.reconciledInvoiceAmount = num(row.reconciled_invoice_amount ?? 0);
      } else {
        option.reconciledPaidAmount = num(row.reconciled_paid_amount ?? 0);
        option.reconciledInvoiceAmount = num(row.reconciled_invoice_amount ?? 0);
      }
      return option;
    });
    return { items, total };
  }
}

/** 应付核销回写：先锁对账单头，再按 confirmed 行求和；作废的对账单不计入。 */
export async function writeBackPayableRecon(
  knex: Knex,
  kind: 'expense' | 'invoiceReceipt',
  reconIds: readonly string[],
): Promise<void> {
  const table = kind === 'expense' ? 'expense_record_lines' : 'invoice_receipt_record_lines';
  const header = kind === 'expense' ? 'expense_records' : 'invoice_receipt_records';
  const column = kind === 'expense' ? 'reconciled_paid_amount' : 'reconciled_invoice_amount';
  for (const reconId of [...new Set(reconIds)]) {
    await knex.raw('select id from payable_recons where id = ? for update', [reconId]);
    const result = await knex.raw<{ rows?: readonly { total: string | number }[] }>(
      `select coalesce(sum(l.amount), 0) as total
         from ${table} l
         join ${header} r on r.id = l.record_id
         join payable_recons p on p.id = l.payable_recon_id
        where l.payable_recon_id = ? and r.status = 'confirmed' and p.status = 'confirmed'`,
      [reconId],
    );
    const total = roundAmount(num(result.rows?.[0]?.total ?? 0), 2);
    await knex.raw(
      `update payable_recons set ${column} = ?, updated_at = now() where id = ?`,
      [total, reconId],
    );
    const row = await knex<{ period_amount: string | number; reconciled_paid_amount: string | number; reconciled_invoice_amount: string | number }>('payable_recons')
      .select('period_amount', 'reconciled_paid_amount', 'reconciled_invoice_amount')
      .where('id', reconId).first();
    if (row !== undefined) {
      const status = stateOfRecon(
        num(row.period_amount), num(row.reconciled_paid_amount), num(row.reconciled_invoice_amount),
      );
      await knex('payable_recons').where({ id: reconId }).update({ recon_status: status });
    }
  }
}

export class DatabaseReconciliationMutations {
  public constructor(
    private readonly database: DatabaseManager,
    private readonly codes: CodeService,
    private readonly docFiles: DocFiles,
  ) {}

  private async knex(tx?: DatabaseConnection): Promise<Knex> {
    return await (tx ?? this.database.connection()).client<Knex>();
  }

  private async inTransaction<T>(
    tx: DatabaseConnection | undefined,
    work: (tx: DatabaseConnection) => Promise<T>,
  ): Promise<T> {
    if (tx !== undefined) return await work(tx);
    return await this.database.transaction(work);
  }

  private async assertDicts(tx: DatabaseConnection, codes: readonly (readonly [string, string | null])[]): Promise<void> {
    try {
      for (const [type, code] of codes) {
        if (code !== null && code !== undefined) await assertActiveCodes(tx, type, [code]);
      }
    } catch (error) {
      if (error instanceof BizDictRuleError) fail('dict-code-invalid', error.code);
      throw error;
    }
  }

  private async assertPerson(knex: Knex, userId: string | null | undefined): Promise<void> {
    if (userId === null || userId === undefined) return;
    const row = await knex<{ user_id: string; status: string }>('employees')
      .select('user_id', 'status').where({ user_id: userId }).first();
    if (row === undefined || row.status !== 'active') fail('person-invalid', userId);
  }

  private async assertPartner(knex: Knex, id: string | null | undefined, customer: boolean): Promise<void> {
    if (id === null || id === undefined) return;
    const row = await knex<{ id: string; status: string; is_customer: boolean; is_supplier: boolean }>('partners')
      .select('id', 'status', 'is_customer', 'is_supplier').where({ id }).first();
    if (row === undefined || row.status !== 'active' || (customer ? row.is_customer !== true : row.is_supplier !== true)) {
      fail('partner-invalid', id);
    }
  }

  /** 校验四张财务单的明细，并得到统一的客户、总额与去重后的上游引用。 */
  private async prepareLines(
    knex: Knex,
    _kind: DocKind,
    input: { readonly bindMode?: string; readonly lines?: readonly DocLineInput[]; readonly amount?: number; readonly customerId?: string | null },
  ): Promise<{
    lines: readonly DocLineInput[]; customerId: string | null; total: number;
    orderIds: readonly string[]; reconIds: readonly string[];
  }> {
    const bindMode = input.bindMode;
    if (bindMode === 'none') {
      if (typeof input.amount !== 'number' || !Number.isFinite(input.amount) ||
          input.amount <= 0 || roundAmount(input.amount, 2) !== input.amount) {
        return fail('line-invalid', 'amount');
      }
      return { lines: [], customerId: input.customerId ?? null, total: input.amount, orderIds: [], reconIds: [] };
    }
    if (bindMode !== 'sales_order' && bindMode !== 'receivable_recon') {
      return fail('bind-mixed', String(bindMode));
    }
    const lines = input.lines ?? [];
    if (lines.length === 0) return fail('line-invalid', 'empty');
    const seen = new Set<string>();
    const customers = new Set<string>();
    for (const line of lines) {
      if (typeof line.amount !== 'number' || !Number.isFinite(line.amount) ||
          line.amount <= 0 || roundAmount(line.amount, 2) !== line.amount ||
          (line.note ?? '').length > 500) {
        return fail('line-invalid', 'amount');
      }
      const ref = bindMode === 'sales_order' ? line.salesOrderId : line.receivableReconId;
      if (ref === null || ref === undefined || ref === '') return fail('bind-mixed', 'missing reference');
      const other = bindMode === 'sales_order' ? line.receivableReconId : line.salesOrderId;
      if (other !== null && other !== undefined) return fail('bind-mixed', ref);
      if (seen.has(ref)) return fail('line-duplicated', ref);
      seen.add(ref);
      if (bindMode === 'sales_order') {
        const order = await knex<{ id: string; customer_id: string | null; status: string }>('sales_orders')
          .select('id', 'customer_id', 'status').where({ id: ref }).first();
        if (order === undefined || order.status === 'draft' || order.status === 'cancelled') {
          return fail('source-invalid', ref);
        }
        customers.add(order.customer_id ?? '');
      } else {
        const recon = await knex<{ id: string; customer_id: string; status: string }>('receivable_recons')
          .select('id', 'customer_id', 'status').where({ id: ref }).first();
        if (recon === undefined || recon.status === 'void') return fail('recon-not-open', ref);
        if (recon.status !== 'confirmed') return fail('recon-not-open', ref);
        customers.add(recon.customer_id);
      }
    }
    if (customers.size > 1) return fail('customer-mixed');
    return {
      lines,
      customerId: [...customers][0] || null,
      total: roundAmount(lines.reduce((sum, line) => sum + line.amount, 0), 2),
      orderIds: bindMode === 'sales_order' ? [...seen] : [],
      reconIds: bindMode === 'receivable_recon' ? [...seen] : [],
    };
  }

  private async insertLines(
    knex: Knex, kind: DocKind, recordId: string,
    input: { readonly bindMode: FinanceBindMode; readonly lines: readonly DocLineInput[] },
  ): Promise<void> {
    const config = DOC_CONFIG[kind];
    const orderIds = input.lines.map((line) => line.salesOrderId).filter((id): id is string => id !== null && id !== undefined);
    const reconIds = input.lines.map((line) => line.receivableReconId).filter((id): id is string => id !== null && id !== undefined);
    const orders = orderIds.length === 0 ? [] : await knex<{ id: string; payable_total: string | number | null; received_amount: string | number; invoiced_amount: string | number }>('sales_orders')
      .select('id', 'payable_total', 'received_amount', 'invoiced_amount').whereIn('id', orderIds);
    const recons = reconIds.length === 0 ? [] : await knex<{ id: string; period_amount: string | number; reconciled_income_amount: string | number; reconciled_invoice_amount: string | number }>('receivable_recons')
      .select('id', 'period_amount', 'reconciled_income_amount', 'reconciled_invoice_amount').whereIn('id', reconIds);
    const orderById = new Map(orders.map((order) => [order.id, order]));
    const reconById = new Map(recons.map((recon) => [recon.id, recon]));
    for (const line of input.lines) {
      const order = line.salesOrderId === null || line.salesOrderId === undefined ? undefined : orderById.get(line.salesOrderId);
      const recon = line.receivableReconId === null || line.receivableReconId === undefined ? undefined : reconById.get(line.receivableReconId);
      const before = kind === 'income'
        ? (order === undefined ? num(recon?.reconciled_income_amount ?? 0) : num(order.received_amount))
        : (order === undefined ? num(recon?.reconciled_invoice_amount ?? 0) : num(order.invoiced_amount));
      await knex(config.lineTable).insert({
        id: randomUUID(),
        record_id: recordId,
        sales_order_id: line.salesOrderId ?? null,
        receivable_recon_id: line.receivableReconId ?? null,
        order_payable_amount: order === undefined ? num(recon?.period_amount ?? 0) : nullableNum(order.payable_total) ?? 0,
        [config.before]: before,
        amount: line.amount,
        note: line.note ?? null,
      });
    }
  }

  private async linesFrom(knex: Knex, kind: DocKind, id: string): Promise<readonly DocLineInput[]> {
    const rows = await knex<DocLineRow>(DOC_CONFIG[kind].lineTable).where({ record_id: id });
    return rows.map((row) => ({
      salesOrderId: row.sales_order_id,
      receivableReconId: row.receivable_recon_id,
      amount: num(row.amount),
      note: row.note,
    }));
  }

  /** 先锁头再求和：同一目标重复登记与作废后的回写都不会漂。 */
  private async writeBack(knex: Knex, kind: DocKind, orderIds: readonly string[], reconIds: readonly string[]): Promise<void> {
    const config = DOC_CONFIG[kind];
    for (const orderId of [...new Set(orderIds)]) {
      await knex.raw('select id from sales_orders where id = ? for update', [orderId]);
      const result = await knex.raw<{ rows?: readonly { total: string | number }[] }>(
        `select coalesce(sum(l.amount), 0) as total
           from ${config.lineTable} l
           join ${config.headerTable} r on r.id = l.record_id
          where l.sales_order_id = ? and r.status = 'confirmed'`,
        [orderId],
      );
      await knex('sales_orders').where({ id: orderId }).update({
        [config.writeBack]: roundAmount(num(result.rows?.[0]?.total ?? 0), 2),
        updated_at: new Date(),
      });
    }
    for (const reconId of [...new Set(reconIds)]) {
      await knex.raw('select id from receivable_recons where id = ? for update', [reconId]);
      const result = await knex.raw<{ rows?: readonly { total: string | number }[] }>(
        `select coalesce(sum(l.amount), 0) as total
           from ${config.lineTable} l
           join ${config.headerTable} r on r.id = l.record_id
           join receivable_recons p on p.id = l.receivable_recon_id
          where l.receivable_recon_id = ? and r.status = 'confirmed' and p.status = 'confirmed'`,
        [reconId],
      );
      const total = roundAmount(num(result.rows?.[0]?.total ?? 0), 2);
      await knex('receivable_recons').where({ id: reconId }).update({
        [config.reconColumn]: total, updated_at: new Date(),
      });
      const row = await knex<{ period_amount: string | number; reconciled_income_amount: string | number; reconciled_invoice_amount: string | number }>('receivable_recons')
        .select('period_amount', 'reconciled_income_amount', 'reconciled_invoice_amount')
        .where('id', reconId).first();
      if (row !== undefined) {
        await knex('receivable_recons').where({ id: reconId }).update({
          recon_status: stateOfRecon(
            num(row.period_amount), num(row.reconciled_income_amount), num(row.reconciled_invoice_amount),
          ),
        });
      }
    }
  }

  private async requireDoc(knex: Knex, kind: DocKind, id: string): Promise<DocHeaderRow> {
    const row = await knex<DocHeaderRow>(DOC_CONFIG[kind].headerTable).where({ id }).forUpdate().first();
    if (row === undefined) return fail('finance-not-found', id);
    return row;
  }

  public async createDoc(
    kind: DocKind, input: CreateDocInput, byUserId: string, transaction?: DatabaseConnection,
  ): Promise<DocRecord> {
    const config = DOC_CONFIG[kind];
    return await this.inTransaction(transaction, async (tx) => {
      const knex = await this.knex(tx);
      const { lines, customerId, total } = await this.prepareLines(knex, kind, input);
      await this.assertDicts(tx, [
        [config.dictType, input.typeCode ?? null],
        ['project', input.projectCode ?? null],
        ...(kind === 'income' ? [['fund_account', input.fundAccountCode ?? null] as const] : []),
      ]);
      await this.assertPerson(knex, input.handlerUserId);
      await this.assertPartner(knex, customerId, true);
      const docNo = await this.codes.nextCode(tx, config.prefix);
      const id = randomUUID();
      const now = new Date();
      await knex(config.headerTable).insert({
        id,
        doc_no: docNo,
        [config.date]: input.date,
        status: 'draft',
        [config.typeColumn]: input.typeCode ?? null,
        ...(kind === 'income'
          ? { fund_account_code: input.fundAccountCode ?? null, payer_name: input.payerName ?? null }
          : { invoice_to_name: input.invoiceToName ?? null, invoice_no: input.invoiceNo ?? null }),
        customer_id: customerId,
        bind_mode: input.bindMode,
        handler_user_id: input.handlerUserId ?? null,
        project_code: input.projectCode ?? null,
        remark: input.remark ?? '',
        total_amount: total,
        created_by_id: byUserId,
        created_at: now,
        updated_at: now,
      });
      await this.insertLines(knex, kind, id, { bindMode: input.bindMode, lines });
      await this.docFiles.bind(knex, config.ownerType, id, input.fileIds, byUserId);
      if (input.confirm === true) await this.confirmIn(knex, kind, id);
      const reader = new DatabaseReconciliationReader(this.database, this.docFiles);
      const record = await reader.detailDoc(kind, id, knex);
      if (record === undefined) return fail('finance-not-found', id);
      return record;
    });
  }

  public async updateDoc(kind: DocKind, id: string, input: UpdateDocInput, byUserId: string): Promise<DocRecord> {
    const config = DOC_CONFIG[kind];
    return await this.inTransaction(undefined, async (tx) => {
      const knex = await this.knex(tx);
      const header = await this.requireDoc(knex, kind, id);
      if (header.status === 'void') return fail('voided');
      if (header.status !== 'draft') return fail('not-draft');
      const patch: Record<string, unknown> = {};
      if (input.date !== undefined) patch[config.date] = input.date;
      if (input.typeCode !== undefined) patch[config.typeColumn] = input.typeCode;
      if (kind === 'income') {
        if (input.fundAccountCode !== undefined) patch.fund_account_code = input.fundAccountCode;
        if (input.payerName !== undefined) patch.payer_name = input.payerName;
      } else {
        if (input.invoiceToName !== undefined) patch.invoice_to_name = input.invoiceToName;
        if (input.invoiceNo !== undefined) patch.invoice_no = input.invoiceNo;
      }
      if (input.projectCode !== undefined) patch.project_code = input.projectCode;
      if (input.remark !== undefined) patch.remark = input.remark;
      const hasLines = input.lines !== undefined || input.amount !== undefined;
      const next = {
        bindMode: input.bindMode ?? header.bind_mode as FinanceBindMode,
        lines: hasLines ? input.lines : await this.linesFrom(knex, kind, id),
        amount: hasLines ? input.amount : num(header.total_amount),
        customerId: input.customerId === undefined ? header.customer_id : input.customerId,
      };
      const prepared = await this.prepareLines(knex, kind, next);
      await this.assertDicts(tx, [
        [config.dictType, input.typeCode ?? null],
        ['project', input.projectCode ?? null],
      ]);
      await this.assertPerson(knex, input.handlerUserId);
      await this.assertPartner(knex, prepared.customerId, true);
      patch.customer_id = prepared.customerId;
      patch.total_amount = prepared.total;
      patch.updated_at = new Date();
      if (hasLines) {
        await knex(config.lineTable).where({ record_id: id }).delete();
        await this.insertLines(knex, kind, id, { bindMode: next.bindMode, lines: prepared.lines });
      }
      await knex(config.headerTable).where({ id }).update(patch);
      await this.docFiles.bind(knex, config.ownerType, id, input.fileIds, byUserId);
      const reader = new DatabaseReconciliationReader(this.database, this.docFiles);
      const record = await reader.detailDoc(kind, id, knex);
      if (record === undefined) return fail('finance-not-found', id);
      return record;
    });
  }

  private async confirmIn(knex: Knex, kind: DocKind, id: string): Promise<void> {
    const header = await this.requireDoc(knex, kind, id);
    if (header.status === 'void') return fail('voided');
    if (header.status !== 'draft') return fail('not-draft');
    const lines = await this.linesFrom(knex, kind, id);
    const at = new Date();
    await knex(DOC_CONFIG[kind].headerTable).where({ id }).update({
      status: 'confirmed', confirmed_at: at, updated_at: at,
    });
    const orderIds = lines.map((line) => line.salesOrderId).filter((id): id is string => id !== null && id !== undefined);
    const reconIds = lines.map((line) => line.receivableReconId).filter((id): id is string => id !== null && id !== undefined);
    await this.writeBack(knex, kind, orderIds, reconIds);
  }

  public async confirmDoc(kind: DocKind, id: string, transaction?: DatabaseConnection): Promise<DocRecord> {
    return await this.inTransaction(transaction, async (tx) => {
      const knex = await this.knex(tx);
      await this.confirmIn(knex, kind, id);
      const reader = new DatabaseReconciliationReader(this.database, this.docFiles);
      const record = await reader.detailDoc(kind, id, knex);
      if (record === undefined) return fail('finance-not-found', id);
      return record;
    });
  }

  public async voidDoc(kind: DocKind, id: string): Promise<DocRecord> {
    return await this.inTransaction(undefined, async (tx) => {
      const knex = await this.knex(tx);
      const header = await this.requireDoc(knex, kind, id);
      if (header.status === 'void') return fail('voided');
      const lines = await this.linesFrom(knex, kind, id);
      const at = new Date();
      await knex(DOC_CONFIG[kind].headerTable).where({ id }).update({
        status: 'void', voided_at: at, updated_at: at,
      });
      const orderIds = lines.map((line) => line.salesOrderId).filter((id): id is string => id !== null && id !== undefined);
      const reconIds = lines.map((line) => line.receivableReconId).filter((id): id is string => id !== null && id !== undefined);
      await this.writeBack(knex, kind, orderIds, reconIds);
      const reader = new DatabaseReconciliationReader(this.database, this.docFiles);
      const record = await reader.detailDoc(kind, id, knex);
      if (record === undefined) return fail('finance-not-found', id);
      return record;
    });
  }

  private async requireRecon(knex: Knex, kind: ReconKind, id: string): Promise<ReconHeaderRow> {
    const row = await knex<ReconHeaderRow>(RECON_CONFIG[kind].table).where({ id }).forUpdate().first();
    if (row === undefined) return fail('recon-not-found', id);
    return row;
  }

  /** 快照取数：只摊单据行与金额，来源必须是已过账的单据；退货腿在没有对应单据时留空。 */
  private async buildSnapshot(
    knex: Knex, kind: ReconKind, reconId: string, input: Partial<CreateReconInput>,
  ): Promise<void> {
    const groups: readonly (readonly ['out' | 'return' | 'in', readonly string[] | undefined])[] =
      kind === 'receivable'
        ? [['out', input.outStockDocIds], ['return', input.returnDocIds]]
        : [['in', input.purchaseStockDocIds]];
    const all = groups.flatMap(([, ids]) => ids ?? []);
    if (all.length === 0) return fail('recon-empty');
    const seen = new Set<string>();
    for (const id of all) {
      if (seen.has(id)) return fail('line-duplicated', id);
      seen.add(id);
    }
    for (const [side, ids] of groups) {
      if (ids === undefined || ids.length === 0) continue;
      const docs = await knex<{ id: string; doc_type: string; status: string }>('stock_docs')
        .select('id', 'doc_type', 'status').whereIn('id', ids);
      const expected = side === 'out' ? 'out' : 'in';
      if (docs.length !== ids.length || docs.some((doc) => doc.doc_type !== expected || doc.status !== 'posted')) {
        return fail('source-invalid');
      }
      const lines = await knex<{
        id: string; doc_id: string; item_id: string; qty: string | number;
        tax_rate: string | number | null; tax_included_price: string | number | null;
        tax_included_amount: string | number | null; note: string | null;
      }>('stock_doc_lines').whereIn('doc_id', ids).orderBy('id', 'asc');
      const items = await knex<{ id: string; code: string; name: string; spec: string | null; unit_code: string }>('items')
        .select('id', 'code', 'name', 'spec', 'unit_code')
        .whereIn('id', [...new Set(lines.map((line) => line.item_id))]);
      const itemById = new Map(items.map((item) => [item.id, item]));
      for (const line of lines) {
        const item = itemById.get(line.item_id);
        if (item === undefined) return fail('source-invalid', line.item_id);
        await knex('recon_snapshot_lines').insert({
          id: randomUUID(),
          recon_id: reconId,
          side,
          source_doc_id: line.doc_id,
          item_id: item.id,
          item_code: item.code,
          item_name: item.name,
          item_spec: item.spec,
          unit_code: item.unit_code,
          qty: line.qty,
          tax_rate: line.tax_rate,
          tax_included_price: line.tax_included_price,
          tax_included_amount: line.tax_included_amount,
          note: line.note,
        });
      }
    }
  }

  public async createRecon(kind: ReconKind, input: CreateReconInput, byUserId: string): Promise<ReconRecord> {
    const config = RECON_CONFIG[kind];
    return await this.inTransaction(undefined, async (tx) => {
      const knex = await this.knex(tx);
      if (typeof input.periodAmount !== 'number' || !Number.isFinite(input.periodAmount) ||
          input.periodAmount <= 0 || roundAmount(input.periodAmount, 2) !== input.periodAmount) {
        return fail('line-invalid', 'periodAmount');
      }
      const partnerId = kind === 'receivable' ? input.customerId : input.supplierId;
      if (partnerId === null || partnerId === undefined) return fail('partner-invalid');
      await this.assertPartner(knex, partnerId, kind === 'receivable');
      await this.assertPerson(knex, input.handlerUserId);
      await this.assertDicts(tx, [
        ['project', input.projectCode ?? null],
        ...(kind === 'payable' ? [['invoice_type', input.invoiceTypeCode ?? null] as const] : []),
      ]);
      const docNo = await this.codes.nextCode(tx, config.prefix);
      const id = randomUUID();
      const now = new Date();
      await knex(config.table).insert({
        id,
        doc_no: docNo,
        recon_date: input.reconDate,
        expected_pay_date: input.expectedPayDate ?? null,
        [config.partnerColumn]: partnerId,
        contact_name: input.contactName ?? null,
        phone: input.phone ?? null,
        period_amount: input.periodAmount,
        status: 'draft',
        recon_status: 'unsettled',
        ...(kind === 'receivable'
          ? { reconciled_income_amount: 0, reconciled_invoice_amount: 0 }
          : { invoice_type_code: input.invoiceTypeCode ?? null, reconciled_paid_amount: 0, reconciled_invoice_amount: 0 }),
        handler_user_id: input.handlerUserId ?? null,
        project_code: input.projectCode ?? null,
        remark: input.remark ?? '',
        created_by_id: byUserId,
        created_at: now,
        updated_at: now,
      });
      await this.buildSnapshot(knex, kind, id, input);
      await this.docFiles.bind(knex, config.collection, id, input.fileIds, byUserId);
      const reader = new DatabaseReconciliationReader(this.database, this.docFiles);
      const record = await reader.detailRecon(kind, id, knex);
      if (record === undefined) return fail('recon-not-found', id);
      return record;
    });
  }

  public async updateRecon(kind: ReconKind, id: string, input: UpdateReconInput, byUserId: string): Promise<ReconRecord> {
    const config = RECON_CONFIG[kind];
    return await this.inTransaction(undefined, async (tx) => {
      const knex = await this.knex(tx);
      const header = await this.requireRecon(knex, kind, id);
      if (header.status === 'void') return fail('recon-voided');
      if (header.status !== 'draft') return fail('recon-not-draft');
      const patch: Record<string, unknown> = {};
      if (input.reconDate !== undefined) patch.recon_date = input.reconDate;
      if (input.expectedPayDate !== undefined) patch.expected_pay_date = input.expectedPayDate;
      if (input.contactName !== undefined) patch.contact_name = input.contactName;
      if (input.phone !== undefined) patch.phone = input.phone;
      if (input.remark !== undefined) patch.remark = input.remark;
      if (input.projectCode !== undefined) patch.project_code = input.projectCode;
      if (kind === 'payable' && input.invoiceTypeCode !== undefined) patch.invoice_type_code = input.invoiceTypeCode;
      if (input.periodAmount !== undefined) patch.period_amount = input.periodAmount;
      const partnerId = kind === 'receivable' ? input.customerId : input.supplierId;
      if (partnerId !== undefined && partnerId !== null) {
        await this.assertPartner(knex, partnerId, kind === 'receivable');
        patch[config.partnerColumn] = partnerId;
      }
      await this.assertPerson(knex, input.handlerUserId);
      await this.assertDicts(tx, [
        ['project', input.projectCode ?? null],
        ...(kind === 'payable' ? [['invoice_type', input.invoiceTypeCode ?? null] as const] : []),
      ]);
      const hasSources = input.outStockDocIds !== undefined || input.returnDocIds !== undefined ||
        input.purchaseStockDocIds !== undefined;
      if (hasSources) {
        await knex('recon_snapshot_lines').where({ recon_id: id }).delete();
        await this.buildSnapshot(knex, kind, id, input);
      }
      patch.updated_at = new Date();
      await knex(config.table).where({ id }).update(patch);
      await this.docFiles.bind(knex, config.collection, id, input.fileIds, byUserId);
      const reader = new DatabaseReconciliationReader(this.database, this.docFiles);
      const record = await reader.detailRecon(kind, id, knex);
      if (record === undefined) return fail('recon-not-found', id);
      return record;
    });
  }

  public async confirmRecon(kind: ReconKind, id: string): Promise<ReconRecord> {
    return await this.inTransaction(undefined, async (tx) => {
      const knex = await this.knex(tx);
      const header = await this.requireRecon(knex, kind, id);
      if (header.status === 'void') return fail('recon-voided');
      if (header.status !== 'draft') return fail('recon-not-draft');
      const counted = await knex.raw<{ rows?: readonly { total: string | number }[] }>(
        'select count(*) as total from recon_snapshot_lines where recon_id = ?', [id],
      );
      if (Number(counted.rows?.[0]?.total ?? 0) === 0) return fail('recon-empty');
      const at = new Date();
      await knex(RECON_CONFIG[kind].table).where({ id }).update({
        status: 'confirmed', confirmed_at: at, updated_at: at,
      });
      const reader = new DatabaseReconciliationReader(this.database, this.docFiles);
      const record = await reader.detailRecon(kind, id, knex);
      if (record === undefined) return fail('recon-not-found', id);
      return record;
    });
  }

  public async voidRecon(kind: ReconKind, id: string): Promise<ReconRecord> {
    return await this.inTransaction(undefined, async (tx) => {
      const knex = await this.knex(tx);
      const header = await this.requireRecon(knex, kind, id);
      if (header.status === 'void') return fail('recon-voided');
      const at = new Date();
      await knex(RECON_CONFIG[kind].table).where({ id }).update({
        status: 'void', voided_at: at, updated_at: at,
      });
      const reader = new DatabaseReconciliationReader(this.database, this.docFiles);
      const record = await reader.detailRecon(kind, id, knex);
      if (record === undefined) return fail('recon-not-found', id);
      return record;
    });
  }
}

export const reconciliationReaderToken: ServiceToken<DatabaseReconciliationReader> =
  createServiceToken<DatabaseReconciliationReader>('app/reconciliation-reader');
export const reconciliationMutationsToken: ServiceToken<DatabaseReconciliationMutations> =
  createServiceToken<DatabaseReconciliationMutations>('app/reconciliation-mutations');

export default class ReconciliationProvider extends ServiceProvider<Application> {
  public readonly name: string = 'app.reconciliation';

  public override register(): void {
    this.app.container.singleton(reconciliationReaderToken, () => {
      const database = this.app.container.resolve(databaseManagerToken);
      return new DatabaseReconciliationReader(database, this.app.container.resolve(docFilesToken));
    });
    this.app.container.singleton(reconciliationMutationsToken, () => {
      const database = this.app.container.resolve(databaseManagerToken);
      return new DatabaseReconciliationMutations(
        database,
        this.app.container.resolve(codeServiceToken),
        this.app.container.resolve(docFilesToken),
      );
    });
  }
}
