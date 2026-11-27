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
 * R-065 第一片：支出记录与到票记录的读写服务。
 *
 * 回写是重算：登记与作废都在同一个事务里锁住涉及的订单头，再按「状态 confirmed、
 * 指向这张订单的行」求和写回。加减法在并发与重试下会漂，重算是幂等的。
 */
export type FinanceKind = 'expense' | 'invoiceReceipt';
export type FinanceStatus = 'draft' | 'confirmed' | 'void';
export type BindMode = 'purchase_order' | 'none';

export type FinanceRuleCode =
  | 'finance-not-found'
  | 'not-draft'
  | 'voided'
  | 'line-invalid'
  | 'order-not-payable'
  | 'supplier-mixed'
  | 'dict-code-invalid'
  | 'person-invalid'
  | 'partner-invalid';

export class FinanceRuleError extends Error {
  public constructor(
    readonly code: FinanceRuleCode,
    readonly detail?: string,
  ) {
    super(detail === undefined ? `Finance rule violated: ${code}` : `Finance rule violated: ${code} (${detail})`);
    this.name = 'FinanceRuleError';
  }
}

function fail(code: FinanceRuleCode, detail?: string): never {
  throw new FinanceRuleError(code, detail);
}

export interface FinanceLine {
  readonly id: string;
  readonly recordId: string;
  readonly purchaseOrderId: string;
  readonly orderNo: string;
  readonly orderPayableAmount: number;
  readonly paidBefore: number;
  readonly invoicedBefore: number;
  readonly amount: number;
  readonly note: string | null;
}

export interface PersonRef { readonly userId: string; readonly name: string; }
export interface SupplierRef {
  readonly id: string; readonly code: string; readonly name: string;
  readonly payeeAccountNo: string | null;
  readonly payeeBankName: string | null;
  readonly payeeBankCode: string | null;
}

export interface FinanceRecord {
  readonly id: string;
  readonly docNo: string;
  readonly date: string;
  readonly status: FinanceStatus;
  readonly expenseTypeCode?: string | null;
  readonly expenseTypeLabel?: string | null;
  readonly fundAccountCode?: string | null;
  readonly fundAccountLabel?: string | null;
  readonly invoiceTypeCode?: string | null;
  readonly invoiceTypeLabel?: string | null;
  readonly issuerName?: string | null;
  readonly invoiceNo?: string | null;
  readonly payeeName: string | null;
  readonly supplier: SupplierRef | null;
  readonly payeeAccountNo?: string | null;
  readonly payeeBankName?: string | null;
  readonly payeeBankCode?: string | null;
  readonly bindMode: BindMode;
  readonly handler: PersonRef | null;
  readonly projectCode: string | null;
  readonly projectLabel: string | null;
  readonly remark: string;
  readonly totalAmount: number;
  readonly confirmedAt: string | null;
  readonly voidedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lines: readonly FinanceLine[];
  readonly files?: readonly DocFileView[];
}

export interface PayableOrder {
  readonly id: string;
  readonly orderNo: string;
  readonly orderDate: string;
  readonly status: string;
  readonly payableTotal: number | null;
  readonly paidAmount: number;
  readonly invoicedAmount: number;
  readonly unpaidAmount: number | null;
  readonly supplier: SupplierRef | null;
}

export interface FinancePageQuery {
  readonly page: number;
  readonly pageSize: number;
  readonly status?: FinanceStatus;
  readonly supplierId?: string;
  readonly typeCode?: string;
  readonly invoiceNo?: string;
  readonly projectCode?: string;
  readonly from?: string;
  readonly to?: string;
  readonly q?: string;
}

export interface FinanceLineInput {
  readonly purchaseOrderId: string;
  readonly amount: number;
  readonly note?: string | null;
}
export interface CreateFinanceInput {
  readonly date: string;
  readonly bindMode: BindMode;
  readonly amount?: number;
  readonly lines?: readonly FinanceLineInput[];
  readonly typeCode?: string | null;
  readonly fundAccountCode?: string | null;
  readonly supplierId?: string | null;
  readonly handlerUserId?: string | null;
  readonly projectCode?: string | null;
  readonly remark?: string;
  readonly fileIds?: readonly string[];
  readonly payeeName?: string | null;
  readonly payeeAccountNo?: string | null;
  readonly payeeBankName?: string | null;
  readonly payeeBankCode?: string | null;
  readonly issuerName?: string | null;
  readonly invoiceNo?: string | null;
  readonly confirm?: boolean;
}
export interface UpdateFinanceInput {
  readonly date?: string;
  readonly amount?: number;
  readonly lines?: readonly FinanceLineInput[];
  readonly typeCode?: string | null;
  readonly fundAccountCode?: string | null;
  readonly supplierId?: string | null;
  readonly handlerUserId?: string | null;
  readonly projectCode?: string | null;
  readonly remark?: string;
  readonly fileIds?: readonly string[];
  readonly payeeName?: string | null;
  readonly payeeAccountNo?: string | null;
  readonly payeeBankName?: string | null;
  readonly payeeBankCode?: string | null;
  readonly issuerName?: string | null;
  readonly invoiceNo?: string | null;
}

export interface FinanceReader {
  list(kind: FinanceKind, query: FinancePageQuery): Promise<{
    items: readonly FinanceRecord[]; total: number;
  }>;
  detail(kind: FinanceKind, id: string): Promise<FinanceRecord | undefined>;
  payable(query: FinancePageQuery): Promise<{
    items: readonly PayableOrder[]; total: number;
  }>;
  supplierOptions(query: FinancePageQuery): Promise<{
    items: readonly SupplierRef[]; total: number;
  }>;
}

export interface FinanceMutations {
  create(
    kind: FinanceKind, input: CreateFinanceInput, byUserId: string,
    transaction?: DatabaseConnection,
  ): Promise<FinanceRecord>;
  update(kind: FinanceKind, id: string, input: UpdateFinanceInput, byUserId: string): Promise<FinanceRecord>;
  confirm(kind: FinanceKind, id: string, byUserId: string, transaction?: DatabaseConnection): Promise<FinanceRecord>;
  void(kind: FinanceKind, id: string, byUserId: string): Promise<FinanceRecord>;
}

const CONFIG: Readonly<Record<FinanceKind, {
  header: string; headerTable: string; lines: string; lineTable: string;
  date: 'expense_date' | 'invoice_date'; prefix: string;
  before: 'paid_before' | 'invoiced_before'; writeBack: 'paid_amount' | 'invoiced_amount';
  ownerType: string; dictType: string;
}>> = {
  expense: {
    header: 'expenseRecords', headerTable: 'expense_records',
    lines: 'expenseRecordLines', lineTable: 'expense_record_lines',
    date: 'expense_date', prefix: CODE_PREFIXES.expense,
    before: 'paid_before', writeBack: 'paid_amount',
    ownerType: 'expense', dictType: 'expense_type',
  },
  invoiceReceipt: {
    header: 'invoiceReceiptRecords', headerTable: 'invoice_receipt_records',
    lines: 'invoiceReceiptRecordLines', lineTable: 'invoice_receipt_record_lines',
    date: 'invoice_date', prefix: CODE_PREFIXES.invoiceReceipt,
    before: 'invoiced_before', writeBack: 'invoiced_amount',
    ownerType: 'invoice_receipt', dictType: 'invoice_type',
  },
};

interface HeaderRow {
  id: string;
  doc_no: string;
  expense_date?: string | Date;
  invoice_date?: string | Date;
  status: string;
  expense_type_code?: string | null;
  fund_account_code?: string | null;
  invoice_type_code?: string | null;
  issuer_name?: string | null;
  invoice_no?: string | null;
  payee_name: string | null;
  supplier_id: string | null;
  payee_account_no?: string | null;
  payee_bank_name?: string | null;
  payee_bank_code?: string | null;
  bind_mode: string;
  handler_user_id: string | null;
  project_code: string | null;
  remark: string;
  total_amount: string | number;
  created_by_id: string;
  confirmed_at: string | Date | null;
  voided_at: string | Date | null;
  created_at: string | Date;
  updated_at: string | Date;
}
interface LineRow {
  id: string;
  record_id: string;
  purchase_order_id: string;
  order_payable_amount: string | number;
  paid_before?: string | number;
  invoiced_before?: string | number;
  amount: string | number;
  note: string | null;
}
interface OrderRow {
  id: string;
  order_no: string;
  order_date: string | Date;
  status: string;
  supplier_id: string | null;
  payable_total: string | number | null;
  paid_amount: string | number;
  invoiced_amount: string | number;
}

const num = (value: unknown): number => Number(value);
const iso = (value: string | Date | null | undefined): string | null =>
  value === null || value === undefined
    ? null
    : value instanceof Date ? value.toISOString() : String(value);
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

/** 往来单位的收款三列依赖另一片的扩展；列还不在库里时按空值回，不让整条接口失败。 */
async function bankColumns(knex: Knex): Promise<readonly string[]> {
  const result = await knex.raw<{ rows?: { column_name: string }[] }>(
    `select column_name from information_schema.columns
      where table_schema = current_schema() and table_name = 'partners'
        and column_name in ('payee_account_no','payee_bank_name','payee_bank_code')`,
  );
  return (result.rows ?? []).map((row) => row.column_name);
}

const BANK_SELECT: Readonly<Record<string, string>> = {
  payee_account_no: 'payee_account_no as payeeAccountNo',
  payee_bank_name: 'payee_bank_name as payeeBankName',
  payee_bank_code: 'payee_bank_code as payeeBankCode',
};
const BANK_FIELD: Readonly<Record<string, keyof SupplierRef>> = {
  payee_account_no: 'payeeAccountNo',
  payee_bank_name: 'payeeBankName',
  payee_bank_code: 'payeeBankCode',
};

async function supplierOf(
  knex: Knex,
  id: string | null,
  columns: readonly string[],
): Promise<SupplierRef | null> {
  if (id === null) return null;
  const row = (await knex('partners')
    .select('id', 'code', 'name', ...columns.map((column) => BANK_SELECT[column] ?? column))
    .where({ id }).first()) as {
      id: string; code: string; name: string;
      payeeAccountNo?: string | null; payeeBankName?: string | null; payeeBankCode?: string | null;
    } | undefined;
  if (row === undefined) return null;
  const bank = (column: string): string | null => {
    if (!columns.includes(column)) return null;
    const key = BANK_FIELD[column] as 'payeeAccountNo' | 'payeeBankName' | 'payeeBankCode';
    return row[key] ?? null;
  };
  return {
    id: row.id, code: row.code, name: row.name,
    payeeAccountNo: bank('payee_account_no'),
    payeeBankName: bank('payee_bank_name'),
    payeeBankCode: bank('payee_bank_code'),
  };
}

async function personOf(knex: Knex, userId: string | null): Promise<PersonRef | null> {
  if (userId === null) return null;
  const row = await knex<{ id: string; name: string | null }>('user')
    .select('id', 'name').where({ id: userId }).first();
  return { userId, name: row?.name ?? userId };
}

async function labelsOf(
  knex: Knex,
  pairs: readonly (readonly [string, string | null])[],
): Promise<Map<string, string>> {
  const wanted = [...new Set(pairs.filter(([, code]) => code !== null).map(([type, code]) => `${type}|${code}`))];
  if (wanted.length === 0) return new Map();
  const result = await knex.raw<{ rows?: { dict_type: string; code: string; name: string }[] }>(
    'select dict_type, code, name from biz_dict_entries',
  );
  return new Map((result.rows ?? [])
    .filter((entry) => wanted.includes(`${entry.dict_type}|${entry.code}`))
    .map((entry) => [`${entry.dict_type}|${entry.code}`, entry.name]));
}

function lineView(kind: FinanceKind, row: LineRow, orderNos: Map<string, string>): FinanceLine {
  return {
    id: row.id,
    recordId: row.record_id,
    purchaseOrderId: row.purchase_order_id,
    orderNo: orderNos.get(row.purchase_order_id) ?? '',
    orderPayableAmount: num(row.order_payable_amount),
    paidBefore: kind === 'expense' ? num(row.paid_before ?? 0) : 0,
    invoicedBefore: kind === 'invoiceReceipt' ? num(row.invoiced_before ?? 0) : 0,
    amount: num(row.amount),
    note: row.note,
  };
}

type FinanceInputLike = {
  readonly bindMode?: string;
  readonly lines?: readonly FinanceLineInput[];
  readonly amount?: number;
  readonly supplierId?: string | null;
};

export class DatabaseFinanceReader implements FinanceReader {
  public constructor(
    private readonly database: DatabaseManager,
    private readonly docFiles: DocFiles,
  ) {}

  private async knex(): Promise<Knex> {
    return await this.database.connection().client<Knex>();
  }

  public async list(kind: FinanceKind, query: FinancePageQuery) {
    const config = CONFIG[kind];
    const knex = await this.knex();
    const base = knex<HeaderRow>(config.headerTable).modify((builder) => {
      if (query.status !== undefined) void builder.where('status', query.status);
      if (query.supplierId !== undefined) void builder.where('supplier_id', query.supplierId);
      if (query.typeCode !== undefined) {
        void builder.where(kind === 'expense' ? 'expense_type_code' : 'invoice_type_code', query.typeCode);
      }
      if (query.projectCode !== undefined) void builder.where('project_code', query.projectCode);
      if (query.invoiceNo !== undefined) void builder.whereILike('invoice_no', `%${query.invoiceNo}%`);
      if (query.from !== undefined) void builder.where(config.date, '>=', query.from);
      if (query.to !== undefined) void builder.where(config.date, '<=', query.to);
      if (query.q !== undefined && query.q !== '') {
        void builder.where((inner) => {
          inner
            .whereILike('doc_no', `%${query.q}%`)
            .orWhereILike(kind === 'expense' ? 'payee_name' : 'issuer_name', `%${query.q}%`)
            .orWhereILike('remark', `%${query.q}%`);
          if (kind === 'invoiceReceipt') inner.orWhereILike('invoice_no', `%${query.q}%`);
        });
      }
    });
    const total = await countOf(base);
    const rows = (await base.clone()
      .orderBy(config.date, 'desc').orderBy('id', 'asc')
      .limit(query.pageSize).offset((query.page - 1) * query.pageSize)) as HeaderRow[];
    const columns = await bankColumns(knex);
    return {
      total,
      items: await Promise.all(rows.map(async (row) => this.view(kind, knex, row, [], columns, false))),
    };
  }

  public async detail(kind: FinanceKind, id: string, knexArg?: Knex) {
    const knex = knexArg ?? await this.knex();
    const row = await knex<HeaderRow>(CONFIG[kind].headerTable).where({ id }).first();
    if (row === undefined) return undefined;
    const lines = await knex<LineRow>(CONFIG[kind].lineTable)
      .where({ record_id: id }).orderBy('id', 'asc');
    const columns = await bankColumns(knex);
    return await this.view(kind, knex, row, lines, columns, true);
  }

  private async view(
    kind: FinanceKind,
    knex: Knex,
    row: HeaderRow,
    lines: readonly LineRow[] | undefined,
    columns: readonly string[],
    withDetail: boolean,
  ): Promise<FinanceRecord> {
    const config = CONFIG[kind];
    const orderIds = lines === undefined
      ? []
      : [...new Set(lines.map((line) => line.purchase_order_id))];
    const orderNos = new Map<string, string>();
    if (orderIds.length > 0) {
      const orders = await knex<{ id: string; order_no: string }>('purchase_orders')
        .select('id', 'order_no').whereIn('id', orderIds);
      for (const order of orders) orderNos.set(order.id, order.order_no);
    }
    const labels = await labelsOf(knex, [
      ['project', row.project_code],
      [config.dictType, kind === 'expense' ? row.expense_type_code ?? null : row.invoice_type_code ?? null],
      ...(kind === 'expense' ? [['fund_account', row.fund_account_code ?? null] as const] : []),
    ]);
    const common = {
      id: row.id,
      docNo: row.doc_no,
      date: day(config.date === 'expense_date' ? row.expense_date! : row.invoice_date!),
      status: row.status as FinanceStatus,
      payeeName: row.payee_name,
      supplier: await supplierOf(knex, row.supplier_id, columns),
      bindMode: row.bind_mode as BindMode,
      handler: await personOf(knex, row.handler_user_id),
      projectCode: row.project_code,
      projectLabel: row.project_code === null ? null : labels.get(`project|${row.project_code}`) ?? null,
      remark: row.remark,
      totalAmount: num(row.total_amount),
      confirmedAt: iso(row.confirmed_at),
      voidedAt: iso(row.voided_at),
      createdAt: String(iso(row.created_at)),
      updatedAt: String(iso(row.updated_at)),
      ...(withDetail ? {
        lines: (lines ?? []).map((line) => lineView(kind, line, orderNos)),
        files: await this.docFiles.filesOf(knex, config.ownerType, row.id),
      } : { lines: [] }),
    };
    if (kind === 'expense') {
      return {
        ...common,
        expenseTypeCode: row.expense_type_code ?? null,
        expenseTypeLabel: row.expense_type_code === null
          ? null
          : labels.get(`${config.dictType}|${row.expense_type_code}`) ?? null,
        fundAccountCode: row.fund_account_code ?? null,
        fundAccountLabel: row.fund_account_code === null
          ? null
          : labels.get(`fund_account|${row.fund_account_code}`) ?? null,
        payeeAccountNo: row.payee_account_no ?? null,
        payeeBankName: row.payee_bank_name ?? null,
        payeeBankCode: row.payee_bank_code ?? null,
      };
    }
    return {
      ...common,
      invoiceTypeCode: row.invoice_type_code ?? null,
      invoiceTypeLabel: row.invoice_type_code === null
        ? null
        : labels.get(`${config.dictType}|${row.invoice_type_code}`) ?? null,
      issuerName: row.issuer_name,
      invoiceNo: row.invoice_no,
    };
  }

  public async payable(query: FinancePageQuery) {
    const knex = await this.knex();
    const base = knex<OrderRow>('purchase_orders').modify((builder) => {
      void builder.whereNotIn('status', ['draft', 'cancelled']);
      if (query.supplierId !== undefined) void builder.where('supplier_id', query.supplierId);
      if (query.status !== undefined) void builder.where('status', query.status);
      if (query.q !== undefined && query.q !== '') {
        void builder.where((inner) => {
          inner.whereILike('order_no', `%${query.q}%`).orWhereExists((sub) => {
            sub.select('id').from('partners')
              .whereRaw('partners.id = purchase_orders.supplier_id')
              .whereILike('name', `%${query.q}%`);
          });
        });
      }
    });
    const total = await countOf(base);
    const rows = (await base.clone()
      .orderBy('created_at', 'desc').orderBy('id', 'asc')
      .limit(query.pageSize).offset((query.page - 1) * query.pageSize)) as OrderRow[];
    const columns = await bankColumns(knex);
    const items: PayableOrder[] = [];
    for (const row of rows) {
      items.push({
        id: row.id,
        orderNo: row.order_no,
        orderDate: day(row.order_date),
        status: row.status,
        payableTotal: nullableNum(row.payable_total),
        paidAmount: num(row.paid_amount),
        invoicedAmount: num(row.invoiced_amount),
        unpaidAmount: row.payable_total === null
          ? null
          : roundAmount(num(row.payable_total) - num(row.paid_amount), 2),
        supplier: await supplierOf(knex, row.supplier_id, columns),
      });
    }
    return { items, total };
  }

  public async supplierOptions(query: FinancePageQuery) {
    const knex = await this.knex();
    const columns = await bankColumns(knex);
    const base = knex<{
      id: string; code: string; name: string; status: string; is_supplier: boolean;
      payeeAccountNo?: string | null; payeeBankName?: string | null; payeeBankCode?: string | null;
    }>('partners').modify((builder) => {
      void builder.where({ status: 'active', is_supplier: true });
      if (query.q !== undefined && query.q !== '') {
        void builder.where((inner) => {
          inner.whereILike('code', `%${query.q}%`).orWhereILike('name', `%${query.q}%`);
        });
      }
    });
    const total = await countOf(base);
    const rows = (await base.clone().orderBy('code', 'asc')
      .limit(query.pageSize).offset((query.page - 1) * query.pageSize)) as readonly {
        id: string; code: string; name: string;
        payeeAccountNo?: string | null; payeeBankName?: string | null; payeeBankCode?: string | null;
      }[];
    return {
      total,
      items: (await Promise.all(rows.map(async (row) => await supplierOf(knex, row.id, columns))))
        .filter((supplier): supplier is SupplierRef => supplier !== null),
    };
  }
}

export class DatabaseFinanceMutations implements FinanceMutations {
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

  private async assertSupplier(knex: Knex, supplierId: string | null | undefined): Promise<void> {
    if (supplierId === null || supplierId === undefined) return;
    const row = await knex<{ id: string; status: string; is_supplier: boolean }>('partners')
      .select('id', 'status', 'is_supplier').where({ id: supplierId }).first();
    if (row === undefined || row.status !== 'active' || row.is_supplier !== true) {
      fail('partner-invalid', supplierId);
    }
  }

  /** 校验明细、算总额，并得到统一的订单输入。 */
  private async prepareLines(
    knex: Knex,
    _kind: FinanceKind,
    input: FinanceInputLike,
  ): Promise<{ lines: readonly FinanceLineInput[]; supplierId: string | null; total: number }> {
    if (input.bindMode !== undefined && input.bindMode !== 'purchase_order' && input.bindMode !== 'none') {
      return fail('line-invalid', 'bindMode');
    }
    const bindMode = input.bindMode ?? 'purchase_order';
    const lines: readonly FinanceLineInput[] = input.lines ?? [];
    if (bindMode === 'purchase_order') {
      if (lines.length === 0) return fail('line-invalid', 'empty');
      const seen = new Set<string>();
      const suppliers = new Set<string>();
      for (const line of lines) {
        if (seen.has(line.purchaseOrderId)) return fail('line-invalid', 'duplicated');
        seen.add(line.purchaseOrderId);
        if (
          typeof line.amount !== 'number' || !Number.isFinite(line.amount) ||
          line.amount <= 0 || roundAmount(line.amount, 2) !== line.amount ||
          (line.note ?? '').length > 500
        ) {
          return fail('line-invalid', line.purchaseOrderId);
        }
        const order = await knex<OrderRow>('purchase_orders')
          .select('id', 'status', 'supplier_id').where({ id: line.purchaseOrderId }).first();
        if (order === undefined || order.status === 'draft' || order.status === 'cancelled') {
          return fail('order-not-payable', line.purchaseOrderId);
        }
        suppliers.add(order.supplier_id ?? '');
      }
      if (suppliers.size > 1) return fail('supplier-mixed');
      return {
        lines,
        supplierId: [...suppliers][0] || null,
        total: roundAmount(lines.reduce((sum, line) => sum + line.amount, 0), 2),
      };
    }
    if (typeof input.amount !== 'number' || !Number.isFinite(input.amount) ||
        input.amount <= 0 || roundAmount(input.amount, 2) !== input.amount) {
      return fail('line-invalid', 'amount');
    }
    return { lines: [], supplierId: input.supplierId ?? null, total: input.amount };
  }

  private async insertLines(
    knex: Knex,
    kind: FinanceKind,
    recordId: string,
    lines: readonly FinanceLineInput[],
  ): Promise<void> {
    const config = CONFIG[kind];
    const ids = lines.map((line) => line.purchaseOrderId);
    const orders = ids.length === 0
      ? []
      : await knex<OrderRow>('purchase_orders')
        .select('id', 'payable_total', 'paid_amount', 'invoiced_amount')
        .whereIn('id', ids);
    const byId = new Map(orders.map((order) => [order.id, order]));
    for (const line of lines) {
      const order = byId.get(line.purchaseOrderId)!;
      await knex(config.lineTable).insert({
        id: randomUUID(),
        record_id: recordId,
        purchase_order_id: line.purchaseOrderId,
        order_payable_amount: nullableNum(order.payable_total) ?? 0,
        [config.before]: num(kind === 'expense' ? order.paid_amount : order.invoiced_amount),
        amount: line.amount,
        note: line.note ?? null,
      });
    }
  }

  /** 重算某张订单的已付/已到票：先锁订单头，再按 confirmed 行求和。 */
  private async writeBack(knex: Knex, kind: FinanceKind, orderIds: readonly string[]): Promise<void> {
    const config = CONFIG[kind];
    for (const orderId of [...new Set(orderIds)]) {
      await knex.raw('select id from purchase_orders where id = ? for update', [orderId]);
      const result = await knex.raw<{ rows?: readonly { total: string | number }[] }>(
        `select coalesce(sum(l.amount), 0) as total
           from ${config.lineTable} l
           join ${config.headerTable} r on r.id = l.record_id
          where l.purchase_order_id = ? and r.status = 'confirmed'`,
        [orderId],
      );
      const total = roundAmount(num(result.rows?.[0]?.total ?? 0), 2);
      await knex('purchase_orders').where({ id: orderId }).update({
        [config.writeBack]: total,
        updated_at: new Date(),
      });
    }
  }

  private async requireRecord(knex: Knex, kind: FinanceKind, id: string): Promise<HeaderRow> {
    const row = await knex<HeaderRow>(CONFIG[kind].headerTable)
      .where({ id }).forUpdate().first();
    if (row === undefined) return fail('finance-not-found', id);
    return row;
  }

  public async create(
    kind: FinanceKind,
    input: CreateFinanceInput,
    byUserId: string,
    transaction?: DatabaseConnection,
  ): Promise<FinanceRecord> {
    const config = CONFIG[kind];
    return await this.inTransaction(transaction, async (tx) => {
      const knex = await this.knex(tx);
      const { lines, supplierId, total } = await this.prepareLines(knex, kind, input);
      await this.assertDicts(tx, [
        [config.dictType, input.typeCode ?? null],
        ['project', input.projectCode ?? null],
        ...(kind === 'expense' ? [['fund_account', input.fundAccountCode ?? null] as const] : []),
      ]);
      await this.assertPerson(knex, input.handlerUserId);
      await this.assertSupplier(knex, supplierId);
      const docNo = await this.codes.nextCode(tx, config.prefix);
      const id = randomUUID();
      const now = new Date();
      await knex(config.headerTable).insert({
        id,
        doc_no: docNo,
        [config.date]: input.date,
        status: 'draft',
        [kind === 'expense' ? 'expense_type_code' : 'invoice_type_code']: input.typeCode ?? null,
        ...(kind === 'expense'
          ? {
              fund_account_code: input.fundAccountCode ?? null,
              payee_account_no: input.payeeAccountNo ?? null,
              payee_bank_name: input.payeeBankName ?? null,
              payee_bank_code: input.payeeBankCode ?? null,
            }
          : { issuer_name: input.issuerName ?? null, invoice_no: input.invoiceNo ?? null }),
        ...(kind === 'expense' ? { payee_name: input.payeeName ?? null } : {}),
        supplier_id: supplierId,
        bind_mode: input.bindMode,
        handler_user_id: input.handlerUserId ?? null,
        project_code: input.projectCode ?? null,
        remark: input.remark ?? '',
        total_amount: total,
        created_by_id: byUserId,
        created_at: now,
        updated_at: now,
      });
      await this.insertLines(knex, kind, id, lines);
      await this.docFiles.bind(knex, config.ownerType, id, input.fileIds, byUserId);
      if (input.confirm === true) await this.confirmIn(knex, kind, id, byUserId);
      return await this.detailIn(knex, kind, id);
    });
  }

  public async update(
    kind: FinanceKind,
    id: string,
    input: UpdateFinanceInput,
    byUserId: string,
  ): Promise<FinanceRecord> {
    const config = CONFIG[kind];
    return await this.inTransaction(undefined, async (tx) => {
      const knex = await this.knex(tx);
      const header = await this.requireRecord(knex, kind, id);
      if (header.status !== 'draft') {
        return fail(header.status === 'void' ? 'voided' : 'not-draft');
      }
      const patch: Record<string, unknown> = {};
      if (input.date !== undefined) patch[config.date] = input.date;
      if (input.typeCode !== undefined) {
        patch[kind === 'expense' ? 'expense_type_code' : 'invoice_type_code'] = input.typeCode;
      }
      if (kind === 'expense') {
        if (input.fundAccountCode !== undefined) patch.fund_account_code = input.fundAccountCode;
        if (input.payeeAccountNo !== undefined) patch.payee_account_no = input.payeeAccountNo;
        if (input.payeeBankName !== undefined) patch.payee_bank_name = input.payeeBankName;
        if (input.payeeBankCode !== undefined) patch.payee_bank_code = input.payeeBankCode;
      } else {
        if (input.issuerName !== undefined) patch.issuer_name = input.issuerName;
        if (input.invoiceNo !== undefined) patch.invoice_no = input.invoiceNo;
      }
      if (input.payeeName !== undefined) patch.payee_name = input.payeeName;
      if (input.handlerUserId !== undefined) patch.handler_user_id = input.handlerUserId;
      if (input.projectCode !== undefined) patch.project_code = input.projectCode;
      if (input.remark !== undefined) patch.remark = input.remark;
      await this.assertDicts(tx, [
        [config.dictType, input.typeCode ?? null],
        ['project', input.projectCode ?? null],
      ]);
      await this.assertPerson(knex, input.handlerUserId);
      const hasLines = input.lines !== undefined || input.amount !== undefined;
      const next = {
        ...header,
        bindMode: header.bind_mode,
        typeCode: input.typeCode === undefined
          ? (kind === 'expense' ? header.expense_type_code ?? null : header.invoice_type_code ?? null)
          : input.typeCode,
        lines: input.lines,
        amount: input.amount,
      };
      const { lines, supplierId, total } = hasLines
        ? await this.prepareLines(knex, kind, next)
        : await this.prepareLines(knex, kind, {
          ...next, lines: await this.linesFrom(knex, kind, id),
        });
      await this.assertSupplier(knex, supplierId);
      patch.supplier_id = supplierId;
      patch.total_amount = total;
      patch.updated_at = new Date();
      if (hasLines) {
        await knex(config.lineTable).where({ record_id: id }).delete();
        await this.insertLines(knex, kind, id, lines);
      }
      await knex(config.headerTable).where({ id }).update(patch);
      await this.docFiles.bind(knex, config.ownerType, id, input.fileIds, byUserId);
      return await this.detailIn(knex, kind, id);
    });
  }

  private async linesFrom(knex: Knex, kind: FinanceKind, id: string): Promise<readonly FinanceLineInput[]> {
    const rows = await knex<LineRow>(CONFIG[kind].lineTable).where({ record_id: id });
    return rows.map((row) => ({
      purchaseOrderId: row.purchase_order_id,
      amount: num(row.amount),
      note: row.note,
    }));
  }

  private async confirmIn(knex: Knex, kind: FinanceKind, id: string, _byUserId: string): Promise<void> {
    const header = await this.requireRecord(knex, kind, id);
    if (header.status === 'void') return fail('voided');
    if (header.status !== 'draft') return fail('not-draft');
    const lines = await this.linesFrom(knex, kind, id);
    const at = new Date();
    await knex(CONFIG[kind].headerTable).where({ id }).update({
      status: 'confirmed', confirmed_at: at, updated_at: at,
    });
    await this.writeBack(knex, kind, lines.map((line) => line.purchaseOrderId));
  }

  public async confirm(
    kind: FinanceKind, id: string, byUserId: string, transaction?: DatabaseConnection,
  ): Promise<FinanceRecord> {
    return await this.inTransaction(transaction, async (tx) => {
      const knex = await this.knex(tx);
      await this.confirmIn(knex, kind, id, byUserId);
      return await this.detailIn(knex, kind, id);
    });
  }

  public async void(kind: FinanceKind, id: string, _byUserId: string): Promise<FinanceRecord> {
    return await this.inTransaction(undefined, async (tx) => {
      const knex = await this.knex(tx);
      const header = await this.requireRecord(knex, kind, id);
      if (header.status === 'void') return fail('voided');
      const lines = await this.linesFrom(knex, kind, id);
      const at = new Date();
      await knex(CONFIG[kind].headerTable).where({ id }).update({
        status: 'void', voided_at: at, updated_at: at,
      });
      await this.writeBack(knex, kind, lines.map((line) => line.purchaseOrderId));
      return await this.detailIn(knex, kind, id);
    });
  }

  private async detailIn(knex: Knex, kind: FinanceKind, id: string): Promise<FinanceRecord> {
    const config = CONFIG[kind];
    const row = await knex<HeaderRow>(config.headerTable).where({ id }).first();
    if (row === undefined) return fail('finance-not-found', id);
    const reader = new DatabaseFinanceReader(this.database, this.docFiles);
    const record = await reader.detail(kind, id, knex);
    if (record === undefined) return fail('finance-not-found', id);
    return record;
  }
}

export const financeReaderToken: ServiceToken<FinanceReader> =
  createServiceToken<FinanceReader>('app/finance-reader');
export const financeMutationsToken: ServiceToken<FinanceMutations> =
  createServiceToken<FinanceMutations>('app/finance-mutations');

export default class FinanceProvider extends ServiceProvider<Application> {
  public readonly name: string = 'app.finance';

  public override register(): void {
    this.app.container.singleton(financeReaderToken, () => {
      const database = this.app.container.resolve(databaseManagerToken);
      return new DatabaseFinanceReader(database, this.app.container.resolve(docFilesToken));
    });
    this.app.container.singleton(financeMutationsToken, () => {
      const database = this.app.container.resolve(databaseManagerToken);
      return new DatabaseFinanceMutations(
        database,
        this.app.container.resolve(codeServiceToken),
        this.app.container.resolve(docFilesToken),
      );
    });
  }
}
