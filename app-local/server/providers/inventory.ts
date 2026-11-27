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
  | 'empty-update';

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
  | 'sales_issue'
  | 'other_in'
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

export interface StockDocLineRecord {
  readonly id: string;
  readonly docId: string;
  readonly itemId: string;
  readonly warehouseId: string;
  readonly batchNo: string;
  readonly qty: number;
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
}
export interface CreateDocInput {
  readonly docType: DocType;
  readonly reason: DocReason;
  readonly remark?: string;
  readonly sourceType?: SourceType;
  readonly sourceId?: string;
  readonly lines: readonly StockLineInput[];
}
export interface UpdateDocInput {
  readonly remark?: string;
  readonly reason?: DocReason;
  readonly sourceType?: SourceType;
  readonly sourceId?: string;
  readonly lines: readonly StockLineInput[];
}

export interface StockReader {
  listWarehouses(query: WarehouseListQuery): Promise<Page<WarehouseRecord>>;
  detailWarehouse(id: string): Promise<WarehouseRecord | undefined>;
  listDocs(query: DocListQuery): Promise<Page<Omit<StockDocRecord, 'lines'>>>;
  detailDoc(id: string): Promise<StockDocRecord | undefined>;
  listBalances(query: BalanceListQuery): Promise<Page<BalanceRecord>>;
  listTransactions(query: TransactionListQuery): Promise<Page<TransactionRecord>>;
}

export interface StockMutations {
  createWarehouse(input: CreateWarehouseInput): Promise<WarehouseRecord>;
  updateWarehouse(id: string, input: UpdateWarehouseInput): Promise<WarehouseRecord>;
  createDoc(input: CreateDocInput, byUserId: string): Promise<StockDocRecord>;
  updateDoc(id: string, input: UpdateDocInput): Promise<StockDocRecord>;
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
}
interface LineRow {
  id: string;
  doc_id: string;
  item_id: string;
  warehouse_id: string;
  batch_no: string;
  qty: string | number;
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

function lineView(row: LineRow): StockDocLineRecord {
  return {
    id: row.id,
    docId: row.doc_id,
    itemId: row.item_id,
    warehouseId: row.warehouse_id,
    batchNo: row.batch_no,
    qty: num(row.qty),
  };
}

function docView(row: DocRow, lines: readonly LineRow[]): StockDocRecord {
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
    lines: lines.map(lineView),
  };
}

/** 列表行不带明细：详情才带。两处视图不共用，免得列表无意间把明细也带出来。 */
function docSummaryView(row: DocRow): Omit<StockDocRecord, 'lines'> {
  const { lines: _lines, ...summary } = docView(row, []);
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
const REASONS = ['purchase_receipt', 'sales_issue', 'other_in', 'other_out'] as const;
const SOURCE_TYPES = ['purchase_order', 'sales_order'] as const;
const WAREHOUSE_STATUSES = ['active', 'inactive'] as const;
const IN_REASONS: readonly DocReason[] = ['purchase_receipt', 'other_in'];
const OUT_REASONS: readonly DocReason[] = ['sales_issue', 'other_out'];

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
      (line.batchNo ?? '').length > 64
    ) {
      return fail('line-invalid');
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
  public constructor(private readonly database: DatabaseManager) {}

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

  public async listDocs(query: DocListQuery): Promise<Page<Omit<StockDocRecord, 'lines'>>> {
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
      if (query.from !== undefined) void builder.where('created_at', '>=', query.from);
      if (query.to !== undefined) void builder.where('created_at', '<=', query.to);
    });
    const total = await countOf(base);
    const rows = (await base
      .clone()
      .orderBy('created_at', 'desc')
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize)) as DocRow[];
    return { items: rows.map(docSummaryView), total };
  }

  public async detailDoc(id: string): Promise<StockDocRecord | undefined> {
    const knex = await this.knex();
    const row = await knex<DocRow>('stock_docs').where({ id }).first();
    if (row === undefined) return undefined;
    const lines = await knex<LineRow>('stock_doc_lines')
      .where({ doc_id: id })
      .orderBy('id', 'asc');
    return docView(row, lines);
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

  public async createWarehouse(input: CreateWarehouseInput): Promise<WarehouseRecord> {
    const code = validateWarehouseCode(input.code);
    const name = validateWarehouseName(input.name);
    const status = validateWarehouseStatus(input.status);
    const note = validateNote(input.note);
    const now = new Date();
    try {
      await this.database.connection().query
        .insertInto('warehouses')
        .values({ id: randomUUID(), code, name, status, note, createdAt: now, updatedAt: now })
        .execute();
    } catch (error) {
      if (isUniqueConstraintViolation(error)) return fail('warehouse-code-exists');
      throw error;
    }
    const knex = await this.knex();
    const row = await knex<WarehouseRow>('warehouses').where({ code }).first();
    return warehouseView(row!);
  }

  public async updateWarehouse(id: string, input: UpdateWarehouseInput): Promise<WarehouseRecord> {
    if (input.name === undefined && input.status === undefined && input.note === undefined) {
      return fail('empty-update');
    }
    if (input.name !== undefined) validateWarehouseName(input.name);
    if (input.status !== undefined) validateWarehouseStatus(input.status);
    if (input.note !== undefined) validateNote(input.note);
    const knex = await this.knex();
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

  public async createDoc(input: CreateDocInput, byUserId: string): Promise<StockDocRecord> {
    validateDoc(input, input.docType);
    return await this.inTransaction(undefined, async (tx) => {
      const knex = await this.knex(tx);
      await this.requireWarehouses(knex, input.lines);
      await assertItemsActive(knex, input.lines.map((line) => line.itemId));
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
        created_at: now,
        updated_at: now,
      });
      await this.insertLines(knex, id, input.lines);
      return await this.detailIn(tx, id);
    });
  }

  public async updateDoc(id: string, input: UpdateDocInput): Promise<StockDocRecord> {
    return await this.inTransaction(undefined, async (tx) => {
      const knex = await this.knex(tx);
      // 先看单据状态，再校验内容：已过账的草稿无论带什么内容都回 doc-not-draft。
      await this.requireDraft(knex, id);
      validateDoc(input);
      await this.requireWarehouses(knex, input.lines);
      await assertItemsActive(knex, input.lines.map((line) => line.itemId));
      await knex('stock_docs').where({ id }).update({
        ...(input.reason === undefined ? {} : { reason: input.reason }),
        ...(input.remark === undefined ? {} : { remark: input.remark }),
        ...(input.sourceType === undefined ? {} : { source_type: input.sourceType }),
        ...(input.sourceId === undefined ? {} : { source_id: input.sourceId }),
        updated_at: new Date(),
      });
      await knex('stock_doc_lines').where({ doc_id: id }).delete();
      await this.insertLines(knex, id, input.lines);
      return await this.detailIn(tx, id);
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
      return await this.detailIn(tx, id);
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
      return await this.detailIn(tx, id);
    });
  }

  private async requireDraft(
    knex: Knex,
    id: string,
  ): Promise<{ doc_no: string; doc_type: string; status: string }> {
    const result = await knex.raw<{
      rows?: readonly { doc_no: string; doc_type: string; status: string }[];
    }>('select doc_no, doc_type, status from stock_docs where id = ? for update', [id]);
    const row = result.rows?.[0];
    if (row === undefined) return fail('doc-not-found');
    if (row.status !== 'draft') return fail('doc-not-draft');
    return row;
  }

  private async insertLines(
    knex: Knex,
    docId: string,
    lines: readonly StockLineInput[],
  ): Promise<void> {
    for (const line of lines) {
      await knex('stock_doc_lines').insert({
        id: randomUUID(),
        doc_id: docId,
        item_id: line.itemId.trim(),
        warehouse_id: line.warehouseId.trim(),
        batch_no: line.batchNo ?? '',
        qty: line.qty,
      });
    }
  }

  private async detailIn(tx: DatabaseConnection, id: string): Promise<StockDocRecord> {
    const knex = await this.knex(tx);
    const row = await knex<DocRow>('stock_docs').where({ id }).first();
    if (row === undefined) return fail('doc-not-found');
    const lines = await knex<LineRow>('stock_doc_lines')
      .where({ doc_id: id })
      .orderBy('id', 'asc');
    return docView(row, lines);
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
      return new DatabaseStockReader(database);
    });
    this.app.container.singleton(stockMutationsToken, () => {
      const database = this.app.container.resolve(databaseManagerToken);
      const codes = this.app.container.resolve(codeServiceToken);
      return new DatabaseStockMutations(database, codes);
    });
  }
}
