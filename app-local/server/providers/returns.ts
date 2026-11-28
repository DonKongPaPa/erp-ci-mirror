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
import { docFilesToken, type DocFileView, type DocFiles } from './doc-files.js';
import {
  StockRuleError,
  stockMutationsToken,
  type StockMutations,
} from './inventory.js';

/**
 * R-020 复刻波 2 加片二：采购退货单与销售退货单的读写服务。
 *
 * 退货单从来源行带出物料、仓库、批次与数量快照；数量上限按 sourceLineId 算，
 * 建单时把草稿也算进去，过账时锁来源行再重查（只算已过账的退货与当前这一单），
 * 让并发建单的竞态在过账这一关被挡下。过账生成的出入库单走既有库存路径，
 * 订单已收 / 已发由 order-progress 在同一事务里重算。
 */
export type ReturnRuleCode =
  | 'return-not-found'
  | 'return-not-draft'
  | 'qty-exceed'
  | 'source-invalid'
  | 'partner-mixed'
  | 'warehouse-not-found'
  | 'warehouse-inactive'
  | 'item-not-found'
  | 'item-inactive'
  | 'person-invalid'
  | 'insufficient'
  | 'empty-update';

export class ReturnRuleError extends Error {
  public constructor(
    readonly code: ReturnRuleCode,
    readonly detail?: string,
  ) {
    super(detail ?? `Return rule violated: ${code}`);
    this.name = 'ReturnRuleError';
  }
}

function fail(code: ReturnRuleCode, detail?: string): never {
  throw new ReturnRuleError(code, detail);
}

export type ReturnKind = 'purchase' | 'sales';
export type ReturnSourceType = 'stock_doc' | 'order';
export type ReturnStatus = 'draft' | 'posted' | 'void';

export interface ReturnLineInput {
  readonly sourceLineId: string;
  readonly returnQty: number;
  readonly warehouseId?: string;
  readonly note?: string | null;
}
export interface CreateReturnInput {
  readonly sourceType: ReturnSourceType;
  readonly sourceId: string;
  readonly handlerUserId?: string | null;
  readonly remark?: string;
  readonly fileIds?: readonly string[];
  readonly lines: readonly ReturnLineInput[];
}
export interface UpdateReturnInput {
  readonly handlerUserId?: string | null;
  readonly remark?: string;
  readonly fileIds?: readonly string[];
  readonly lines?: readonly ReturnLineInput[];
}
export interface PageQuery {
  readonly page: number;
  readonly pageSize: number;
}
export interface ReturnListQuery extends PageQuery {
  readonly status?: ReturnStatus;
  readonly partnerId?: string;
  readonly from?: string;
  readonly to?: string;
  readonly q?: string;
}
export interface SourceOptionQuery extends PageQuery {
  readonly partnerId?: string;
  readonly q?: string;
}
export interface FinanceOptionQuery extends PageQuery {
  readonly customerId?: string;
  readonly q?: string;
}
export interface Page<T> {
  readonly items: readonly T[];
  readonly total: number;
}
export interface ItemRef {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly spec: string | null;
  readonly unitCode: string;
}
export interface ReturnLineRecord {
  readonly id: string;
  readonly sourceLineId: string | null;
  readonly itemId: string;
  readonly warehouseId: string;
  readonly batchNo: string;
  readonly qty: number;
  readonly returnQty: number;
  readonly remainQty: number;
  readonly note: string | null;
  readonly item: ItemRef;
}
export interface ReturnDocRecord {
  readonly id: string;
  readonly docNo: string;
  readonly docType: ReturnKind;
  readonly sourceType: ReturnSourceType;
  readonly sourceId: string;
  readonly status: ReturnStatus;
  readonly partner: { id: string; code: string; name: string } | null;
  readonly handler: { userId: string; name: string } | null;
  readonly warehouse: { id: string; name: string } | null;
  readonly remark: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lines: readonly ReturnLineRecord[];
  readonly files: readonly DocFileView[];
}
export interface SourceOption {
  readonly id: string;
  readonly docNo: string;
  readonly docDate: string | null;
  readonly partner: { id: string; code: string; name: string } | null;
  readonly lines: readonly {
    sourceLineId: string; itemId: string; warehouseId: string;
    batchNo: string; remainQty: number;
  }[];
}
export interface FinanceOption {
  readonly id: string;
  readonly docNo: string;
  readonly returnDate: string | null;
  readonly status: ReturnStatus;
  readonly customerId: string | null;
  readonly lines: readonly { itemId: string; qty: number }[];
}
export interface PostResult {
  readonly returnDoc: ReturnDocRecord;
  readonly stockDocId: string;
}

export interface ReturnsReader {
  list(kind: ReturnKind, query: ReturnListQuery): Promise<Page<ReturnDocRecord>>;
  detail(kind: ReturnKind, id: string): Promise<ReturnDocRecord | undefined>;
  sourceOptions(kind: ReturnKind, query: SourceOptionQuery): Promise<Page<SourceOption>>;
  financeOptions(query: FinanceOptionQuery): Promise<Page<FinanceOption>>;
}
export interface ReturnsMutations {
  create(kind: ReturnKind, input: CreateReturnInput, byUserId: string): Promise<ReturnDocRecord>;
  update(kind: ReturnKind, id: string, input: UpdateReturnInput, byUserId: string): Promise<ReturnDocRecord>;
  post(kind: ReturnKind, id: string, byUserId: string, transaction?: DatabaseConnection): Promise<PostResult>;
  void(kind: ReturnKind, id: string, byUserId: string, reason?: string): Promise<ReturnDocRecord>;
}

const num = (value: string | number | null | undefined): number =>
  value === null || value === undefined ? 0 : Number(value);
const iso = (value: string | Date | null | undefined): string | null =>
  value === null || value === undefined ? null
    : value instanceof Date ? value.toISOString() : String(value);
const day = (value: string | Date | null | undefined): string | null => {
  if (value === null || value === undefined) return null;
  return typeof value === 'string' ? value.slice(0, 10) : iso(value)!.slice(0, 10);
};

interface HeaderRow {
  id: string;
  doc_no: string;
  doc_type: string;
  source_type: string;
  source_id: string;
  partner_id: string | null;
  handler_user_id: string | null;
  status: string;
  remark: string;
  created_by_id: string;
  posted_at: string | Date | null;
  posted_by_id: string | null;
  created_at: string | Date;
  updated_at: string | Date;
}
interface LineRow {
  id: string;
  doc_id: string;
  source_line_id: string | null;
  item_id: string;
  warehouse_id: string;
  batch_no: string;
  qty: string | number;
  return_qty: string | number;
  note: string | null;
}
interface ResolvedLine {
  readonly sourceLineId: string;
  readonly itemId: string;
  readonly warehouseId: string;
  readonly batchNo: string;
  readonly qty: number;
  readonly returnQty: number;
  readonly note: string | null;
  readonly partnerId: string | null;
}
interface RefRow { id: string; name: string | null; code?: string }
interface ItemRow {
  id: string; code: string; name: string | null;
  spec: string | null; unit_code: string;
}

async function countOf(base: Knex.QueryBuilder): Promise<number> {
  const row = (await base.clone().clear('select').count('* as count').first()) as
    | { count?: string | number }
    | undefined;
  return Number(row?.count ?? 0);
}

async function requireWarehouse(knex: Knex, id: string): Promise<void> {
  const row = await knex<{ id: string; status: string }>('warehouses')
    .select('id', 'status').where({ id }).first();
  if (row === undefined) return fail('warehouse-not-found', id);
  if (row.status !== 'active') return fail('warehouse-inactive', id);
}

async function requireItems(knex: Knex, ids: readonly string[]): Promise<void> {
  const uniqueIds = [...new Set(ids)];
  if (uniqueIds.length === 0) return;
  const rows = await knex<{ id: string; status: string }>('items')
    .select('id', 'status').whereIn('id', uniqueIds);
  const found = new Map(rows.map((row) => [row.id, row.status]));
  for (const id of uniqueIds) {
    if (!found.has(id)) return fail('item-not-found', id);
    if (found.get(id) !== 'active') return fail('item-inactive', id);
  }
}

async function requirePerson(knex: Knex, userId: string): Promise<void> {
  const row = await knex<{ user_id: string; status: string }>('employees')
    .select('user_id', 'status').where({ user_id: userId }).first();
  if (row === undefined || row.status !== 'active') return fail('person-invalid', userId);
}

async function isActivePerson(knex: Knex, userId: string): Promise<boolean> {
  const row = await knex<{ user_id: string; status: string }>('employees')
    .select('user_id').where({ user_id: userId, status: 'active' }).first();
  return row !== undefined;
}

/** 给同一来源行算已占用数量：建单算草稿，过账重查只算已过账的退货。 */
async function consumedOf(
  knex: Knex,
  sourceLineId: string,
  options: { readonly postedOnly?: boolean; readonly draftsOnly?: boolean; readonly excludeDocId?: string } = {},
): Promise<number> {
  const result = await knex.raw<{ rows?: readonly { qty: string | number }[] }>(
    `select coalesce(sum(l.return_qty), 0) as qty
       from return_doc_lines l join return_docs d on d.id = l.doc_id
      where l.source_line_id = ? and d.id <> ? and d.status <> 'void' ${options.draftsOnly === true ? "and d.status = 'draft'" : options.postedOnly === true ? "and d.status = 'posted'" : ''}`,
    [sourceLineId, options.excludeDocId ?? ''],
  );
  return num(result.rows?.[0]?.qty);
}

async function lockSourceQty(
  knex: Knex,
  sourceType: ReturnSourceType,
  kind: ReturnKind,
  sourceLineId: string,
): Promise<number> {
  const table = sourceType === 'stock_doc'
    ? 'stock_doc_lines'
    : kind === 'purchase' ? 'purchase_order_lines' : 'sales_order_lines';
  const column = sourceType === 'stock_doc' ? 'qty'
    : kind === 'purchase' ? 'received_qty' : 'shipped_qty';
  const result = await knex.raw<{ rows?: readonly { qty: string | number }[] }>(
    `select ${column} as qty from ${table} where id = ? for update`,
    [sourceLineId],
  );
  const row = result.rows?.[0];
  if (row === undefined) return fail('source-invalid', sourceLineId);
  return num(row.qty);
}

/** 来源头、来源行、仓库与物料都在这里校验；请求体不写 partnerId / qty / batchNo。 */
async function resolveLines(
  knex: Knex,
  kind: ReturnKind,
  sourceType: ReturnSourceType,
  sourceId: string,
  inputs: readonly ReturnLineInput[],
  excludeDocId?: string,
): Promise<readonly ResolvedLine[]> {
  if (sourceType !== 'stock_doc' && sourceType !== 'order') return fail('source-invalid', sourceType);
  if (inputs.length === 0) return fail('qty-exceed', 'empty-lines');
  const wanted = new Map<string, number>();
  for (const input of inputs) {
    if (typeof input.sourceLineId !== 'string' || input.sourceLineId === '') {
      return fail('source-invalid', 'sourceLineId');
    }
    if (typeof input.returnQty !== 'number' || !Number.isFinite(input.returnQty) || input.returnQty <= 0) {
      return fail('qty-exceed', input.sourceLineId);
    }
    if ((input.note ?? '').length > 500) return fail('qty-exceed', 'note');
    wanted.set(input.sourceLineId, (wanted.get(input.sourceLineId) ?? 0) + input.returnQty);
  }

  const resolved: ResolvedLine[] = [];
  if (sourceType === 'stock_doc') {
    const reason = kind === 'purchase' ? 'purchase_receipt' : 'sales_issue';
    const header = await knex<{ id: string; status: string; reason: string; partner_id: string | null }>('stock_docs')
      .select('id', 'status', 'reason', 'partner_id').where({ id: sourceId }).first();
    if (header === undefined || header.status !== 'posted' || header.reason !== reason) {
      return fail('source-invalid', sourceId);
    }
    const ids = [...wanted.keys()];
    const rows = await knex<LineRow>('stock_doc_lines')
      .select('id', 'item_id', 'warehouse_id', 'batch_no', 'qty')
      .where({ doc_id: sourceId }).whereIn('id', ids);
    const byId = new Map(rows.map((row) => [row.id, row]));
    for (const [sourceLineId, returnQty] of wanted) {
      const row = byId.get(sourceLineId);
      if (row === undefined) return fail('source-invalid', sourceLineId);
      resolved.push({
        sourceLineId,
        itemId: row.item_id,
        warehouseId: row.warehouse_id,
        batchNo: row.batch_no,
        qty: num(row.qty),
        returnQty,
        note: inputs.find((line) => line.sourceLineId === sourceLineId)?.note ?? null,
        partnerId: header.partner_id,
      });
    }
  } else {
    const headerTable = kind === 'purchase' ? 'purchase_orders' : 'sales_orders';
    const lineTable = kind === 'purchase' ? 'purchase_order_lines' : 'sales_order_lines';
    const partnerColumn = kind === 'purchase' ? 'supplier_id' : 'customer_id';
    const progressColumn = kind === 'purchase' ? 'received_qty' : 'shipped_qty';
    const header = await knex<Record<string, string | null>>(headerTable)
      .select('id', 'status', partnerColumn, 'warehouse_id')
      .where({ id: sourceId }).first();
    if (header === undefined || header.status === 'cancelled') return fail('source-invalid', sourceId);
    const orderPartnerId: string | null = header[partnerColumn] ?? null;
    const rows = await knex<Record<string, string | number | null>>(lineTable)
      .select('id', 'item_id', progressColumn).where({ order_id: sourceId })
      .whereIn('id', [...wanted.keys()]);
    const byId = new Map(rows.map((row) => [String(row.id), row]));
    for (const [sourceLineId, returnQty] of wanted) {
      const row = byId.get(sourceLineId);
      if (row === undefined) return fail('source-invalid', sourceLineId);
      const warehouseId = inputs.find((line) => line.sourceLineId === sourceLineId)?.warehouseId
        ?? (header.warehouse_id === null ? undefined : String(header.warehouse_id));
      if (warehouseId === undefined || warehouseId === '') return fail('warehouse-not-found', sourceLineId);
      resolved.push({
        sourceLineId,
        itemId: String(row.item_id),
        warehouseId,
        batchNo: '',
        qty: num(row[progressColumn]),
        returnQty,
        note: inputs.find((line) => line.sourceLineId === sourceLineId)?.note ?? null,
        partnerId: orderPartnerId,
      });
    }
  }

  const partners = new Set(resolved.map((line) => line.partnerId ?? ''));
  if (partners.size > 1) return fail('partner-mixed');
  const warehouses = [...new Set(resolved.map((line) => line.warehouseId))];
  for (const warehouseId of warehouses) await requireWarehouse(knex, warehouseId);
  await requireItems(knex, resolved.map((line) => line.itemId));
  for (const line of resolved) {
    // 订单行的进度已是净值：已过账退货被 syncOrderProgress 减过一次，不能再扣。
    const consumed = await consumedOf(knex, line.sourceLineId, {
      excludeDocId,
      ...(sourceType === 'order' ? { draftsOnly: true } : {}),
    });
    if (line.returnQty > Math.max(0, line.qty - consumed)) {
      return fail('qty-exceed', line.sourceLineId);
    }
  }
  return resolved;
}

export class DatabaseReturnsReader implements ReturnsReader {
  public constructor(
    private readonly database: DatabaseManager,
    private readonly docFiles: DocFiles,
  ) {}

  private async knex(): Promise<Knex> {
    return await this.database.connection().client<Knex>();
  }

  public async list(kind: ReturnKind, query: ReturnListQuery): Promise<Page<ReturnDocRecord>> {
    const knex = await this.knex();
    const base = knex<HeaderRow>('return_docs').modify((builder) => {
      void builder.where('doc_type', kind);
      if (query.status !== undefined) void builder.where('status', query.status);
      if (query.partnerId !== undefined) void builder.where('partner_id', query.partnerId);
      if (query.q !== undefined && query.q !== '') {
        void builder.where((inner) => {
          inner.whereILike('doc_no', `%${query.q}%`).orWhereILike('remark', `%${query.q}%`);
        });
      }
      if (query.from !== undefined) void builder.where('created_at', '>=', query.from);
      if (query.to !== undefined) void builder.where('created_at', '<=', query.to);
    });
    const total = await countOf(base);
    const rows = (await base.clone().orderBy('created_at', 'desc')
      .limit(query.pageSize).offset((query.page - 1) * query.pageSize)) as HeaderRow[];
    const refs = await refsOf(knex, rows);
    const items = await Promise.all(rows.map(async (row) =>
      viewOf(knex, this.docFiles, row, undefined, refs)));
    return { items, total };
  }

  public async detail(kind: ReturnKind, id: string): Promise<ReturnDocRecord | undefined> {
    const knex = await this.knex();
    const row = await knex<HeaderRow>('return_docs').where({ id, doc_type: kind }).first();
    if (row === undefined) return undefined;
    return await viewOf(knex, this.docFiles, row, id, await refsOf(knex, [row]));
  }

  public async sourceOptions(
    kind: ReturnKind,
    query: SourceOptionQuery,
  ): Promise<Page<SourceOption>> {
    const knex = await this.knex();
    const reason = kind === 'purchase' ? 'purchase_receipt' : 'sales_issue';
    const docs = await knex<{
      id: string; doc_no: string; doc_date: string | Date | null;
      partner_id: string | null; status: string; reason: string;
    }>('stock_docs')
      .select('id', 'doc_no', 'doc_date', 'partner_id')
      .where({ status: 'posted', reason })
      .modify((builder) => {
        if (query.partnerId !== undefined) void builder.where('partner_id', query.partnerId);
        if (query.q !== undefined && query.q !== '') void builder.whereILike('doc_no', `%${query.q}%`);
      }).orderBy('created_at', 'desc') as {
        id: string; doc_no: string; doc_date: string | Date | null;
        partner_id: string | null; status: string; reason: string;
      }[];
    const ids = docs.map((row) => row.id);
    const lines = ids.length === 0 ? []
      : await knex<LineRow>('stock_doc_lines')
        .select('id', 'doc_id', 'item_id', 'warehouse_id', 'batch_no', 'qty')
        .whereIn('doc_id', ids).orderBy('id', 'asc') as LineRow[];
    const consumed = new Map<string, number>();
    for (const line of lines) {
      if (!consumed.has(line.id)) consumed.set(line.id, await consumedOf(knex, line.id));
    }
    const partners = await refsOf(knex, docs as unknown as HeaderRow[]);
    const all = docs.map((doc) => ({
      id: doc.id,
      docNo: doc.doc_no,
      docDate: day(doc.doc_date),
      partner: partners.partners.get(doc.partner_id ?? '') ?? null,
      lines: lines.filter((line) => line.doc_id === doc.id)
        .map((line) => ({
          sourceLineId: line.id,
          itemId: line.item_id,
          warehouseId: line.warehouse_id,
          batchNo: line.batch_no,
          remainQty: Math.max(0, num(line.qty) - (consumed.get(line.id) ?? 0)),
        }))
        .filter((line) => line.remainQty > 0),
    })).filter((doc) => doc.lines.length > 0);
    const start = (query.page - 1) * query.pageSize;
    return { items: all.slice(start, start + query.pageSize), total: all.length };
  }

  public async financeOptions(query: FinanceOptionQuery): Promise<Page<FinanceOption>> {
    const knex = await this.knex();
    const docs = await knex<HeaderRow>('return_docs')
      .select('id', 'doc_no', 'partner_id', 'status', 'posted_at', 'created_at')
      .where({ doc_type: 'sales', status: 'posted' })
      .modify((builder) => {
        if (query.customerId !== undefined) void builder.where('partner_id', query.customerId);
        if (query.q !== undefined && query.q !== '') void builder.whereILike('doc_no', `%${query.q}%`);
      }).orderBy('created_at', 'desc') as HeaderRow[];
    const ids = docs.map((row) => row.id);
    const lines = ids.length === 0 ? []
      : await knex<LineRow>('return_doc_lines')
        .select('id', 'doc_id', 'item_id', 'return_qty')
        .whereIn('doc_id', ids).orderBy('id', 'asc') as LineRow[];
    const all = docs.map((doc) => ({
      id: doc.id,
      docNo: doc.doc_no,
      returnDate: day(doc.posted_at ?? doc.created_at),
      status: doc.status as ReturnStatus,
      customerId: doc.partner_id,
      lines: lines.filter((line) => line.doc_id === doc.id)
        .map((line) => ({ itemId: line.item_id, qty: num(line.return_qty) })),
    }));
    const start = (query.page - 1) * query.pageSize;
    return { items: all.slice(start, start + query.pageSize), total: all.length };
  }
}

interface Refs {
  handlers: Map<string, { userId: string; name: string }>;
  partners: Map<string, { id: string; code: string; name: string }>;
}

async function refsOf(knex: Knex, rows: readonly HeaderRow[]): Promise<Refs> {
  const ids = (pick: (row: HeaderRow) => string | null): string[] =>
    [...new Set(rows.map(pick).filter((value): value is string => typeof value === 'string' && value !== ''))];
  const userIds = ids((row) => row.handler_user_id);
  const partnerIds = ids((row) => row.partner_id);
  const [users, partners] = await Promise.all([
    userIds.length === 0 ? [] : knex<RefRow>('user').select('id', 'name').whereIn('id', userIds),
    partnerIds.length === 0 ? []
      : knex<RefRow>('partners').select('id', 'code', 'name').whereIn('id', partnerIds),
  ]);
  const handlerMap = new Map(users.map((row) => [row.id, { userId: row.id, name: row.name ?? row.id }]));
  for (const id of userIds) if (!handlerMap.has(id)) handlerMap.set(id, { userId: id, name: id });
  return {
    handlers: handlerMap,
    partners: new Map(partners.map((row) => [row.id, { id: row.id, code: row.code ?? '', name: row.name ?? '' }])),
  };
}

async function warehouseOf(knex: Knex, id: string): Promise<{ id: string; name: string } | null> {
  const row = await knex<{ id: string; name: string | null }>('warehouses')
    .select('id', 'name').where({ id }).first();
  return row === undefined ? null : { id: row.id, name: row.name ?? '' };
}

async function viewOf(
knex: Knex,
docFiles: DocFiles,
row: HeaderRow,
withLines: string | undefined,
refs: Refs,
): Promise<ReturnDocRecord> {
  const lines = withLines === undefined ? []
    : await knex<LineRow>('return_doc_lines').where({ doc_id: withLines }).orderBy('id', 'asc');
  const consumed = new Map<string, number>();
  for (const line of lines) {
    if (line.source_line_id !== null && !consumed.has(line.source_line_id)) {
      consumed.set(line.source_line_id, await consumedOf(knex, line.source_line_id));
    }
  }
  const items = await knex<ItemRow>('items')
    .select('id', 'code', 'name', 'spec', 'unit_code')
    .whereIn('id', [...new Set(lines.map((line) => line.item_id))]);
  const itemMap = new Map(items.map((row) => [row.id, {
    id: row.id, code: row.code, name: row.name ?? '',
    spec: row.spec, unitCode: row.unit_code,
  }]));
  const warehouseId = lines[0]?.warehouse_id;
  return {
    id: row.id,
    docNo: row.doc_no,
    docType: row.doc_type as ReturnKind,
    sourceType: row.source_type as ReturnSourceType,
    sourceId: row.source_id,
    status: row.status as ReturnStatus,
    partner: refs.partners.get(row.partner_id ?? '') ?? null,
    handler: refs.handlers.get(row.handler_user_id ?? '') ?? null,
    warehouse: warehouseId === undefined ? null : await warehouseOf(knex, warehouseId),
    remark: row.remark,
    createdAt: String(iso(row.created_at)),
    updatedAt: String(iso(row.updated_at)),
    lines: lines.map((line) => ({
      id: line.id,
      sourceLineId: line.source_line_id,
      itemId: line.item_id,
      warehouseId: line.warehouse_id,
      batchNo: line.batch_no,
      qty: num(line.qty),
      returnQty: num(line.return_qty),
      remainQty: Math.max(0, num(line.qty) - (consumed.get(line.source_line_id ?? '') ?? 0)),
      note: line.note,
      item: itemMap.get(line.item_id) ?? {
        id: line.item_id, code: '', name: '', spec: null, unitCode: '',
      },
    })),
    files: withLines === undefined ? [] : await docFiles.filesOf(knex, 'return_doc', row.id),
  };
}


export class DatabaseReturnsMutations implements ReturnsMutations {
  public constructor(
    private readonly database: DatabaseManager,
    private readonly codes: CodeService,
    private readonly docFiles: DocFiles,
    private readonly stockMutations: StockMutations,
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

  public async create(
    kind: ReturnKind,
    input: CreateReturnInput,
    byUserId: string,
  ): Promise<ReturnDocRecord> {
    if (input.remark !== undefined && input.remark.length > 1000) return fail('source-invalid', 'remark');
    return await this.inTransaction(undefined, async (tx) => {
      const knex = await this.knex(tx);
      const lines = await resolveLines(knex, kind, input.sourceType, input.sourceId, input.lines);
      const handlerUserId = await this.handlerOf(knex, input.handlerUserId, byUserId);
      const now = new Date();
      const docNo = await this.codes.nextCode(tx, CODE_PREFIXES.returnDoc);
      const id = randomUUID();
      await knex('return_docs').insert({
        id,
        doc_no: docNo,
        doc_type: kind,
        source_type: input.sourceType,
        source_id: input.sourceId,
        partner_id: lines[0]?.partnerId ?? null,
        handler_user_id: handlerUserId,
        status: 'draft',
        remark: input.remark ?? '',
        created_by_id: byUserId,
        created_at: now,
        updated_at: now,
      });
      await this.insertLines(knex, id, lines);
      await this.docFiles.bind(knex, 'return_doc', id, input.fileIds, byUserId);
      return await this.detailIn(tx, kind, id);
    });
  }

  public async update(
    kind: ReturnKind,
    id: string,
    input: UpdateReturnInput,
    byUserId: string,
  ): Promise<ReturnDocRecord> {
    return await this.inTransaction(undefined, async (tx) => {
      const knex = await this.knex(tx);
      const header = await this.requireDraft(knex, kind, id);
      if (input.handlerUserId === undefined && input.remark === undefined &&
          input.fileIds === undefined && input.lines === undefined) {
        return fail('empty-update');
      }
      if (input.handlerUserId !== undefined && input.handlerUserId !== null) {
        await requirePerson(knex, input.handlerUserId);
      }
      if (input.lines !== undefined) {
        const lines = await resolveLines(
          knex, kind, header.source_type as ReturnSourceType, header.source_id, input.lines, id,
        );
        await knex('return_doc_lines').where({ doc_id: id }).delete();
        await this.insertLines(knex, id, lines);
      }
      await knex('return_docs').where({ id }).update({
        ...(input.handlerUserId === undefined ? {} : { handler_user_id: input.handlerUserId }),
        ...(input.remark === undefined ? {} : { remark: input.remark }),
        updated_at: new Date(),
      });
      await this.docFiles.bind(knex, 'return_doc', id, input.fileIds, byUserId);
      return await this.detailIn(tx, kind, id);
    });
  }

  public async post(
    kind: ReturnKind,
    id: string,
    byUserId: string,
    transaction?: DatabaseConnection,
  ): Promise<PostResult> {
    return await this.inTransaction(transaction, async (tx) => {
      const knex = await this.knex(tx);
      const header = await this.requireDraft(knex, kind, id);
      const lines = await knex<LineRow>('return_doc_lines')
        .where({ doc_id: id }).orderBy('id', 'asc');
      if (lines.length === 0) return fail('qty-exceed', 'empty-lines');
      const sourceType = header.source_type as ReturnSourceType;
      for (const line of lines) {
        const sourceQty = await lockSourceQty(
          knex, sourceType, kind, String(line.source_line_id),
        );
        const own = num(line.return_qty);
        if (sourceType === 'order') {
          // 订单行是净值，已过账退货已经扣过；只看这一单是否超过当前净值。
          if (own > sourceQty + 1e-6) return fail('qty-exceed', String(line.source_line_id));
        } else {
          const posted = await consumedOf(knex, String(line.source_line_id), { postedOnly: true });
          if (posted + own > sourceQty + 1e-6) return fail('qty-exceed', String(line.source_line_id));
        }
      }
      if (sourceType === 'order') {
        const table = kind === 'purchase' ? 'purchase_orders' : 'sales_orders';
        await knex.raw(`select id from ${table} where id = ? for update`, [header.source_id]);
      }
      const generated = await this.stockMutations.createDoc({
        docType: kind === 'purchase' ? 'out' : 'in',
        reason: kind === 'purchase' ? 'purchase_return' : 'sales_return',
        lines: lines.map((line) => ({
          itemId: line.item_id,
          warehouseId: line.warehouse_id,
          batchNo: line.batch_no,
          qty: num(line.return_qty),
        })),
      }, byUserId, tx);
      const stockDocId = String(generated.id);
      const link: Record<string, string> = { return_doc_id: id };
      if (sourceType === 'order') {
        link.source_type = kind === 'purchase' ? 'purchase_order' : 'sales_order';
        link.source_id = header.source_id;
      } else {
        const source = await knex<{
          id: string; source_type: string | null; source_id: string | null;
        }>('stock_docs')
          .select('source_type', 'source_id').where({ id: header.source_id }).first();
        if (source?.source_type === 'purchase_order' || source?.source_type === 'sales_order') {
          link.source_type = source.source_type;
          link.source_id = source.source_id ?? '';
        }
      }
      await knex('stock_docs').where({ id: stockDocId }).update(link);
      try {
        await this.stockMutations.post(stockDocId, byUserId, tx);
      } catch (error) {
        if (error instanceof StockRuleError && error.code === 'insufficient') return fail('insufficient');
        throw error;
      }
        await knex('return_docs').where({ id }).update({
        status: 'posted', posted_at: new Date(), posted_by_id: byUserId, updated_at: new Date(),
      });
      return { returnDoc: await this.detailIn(tx, kind, id), stockDocId };
    });
  }

  /**
   * R-020 页面片：作废原因由页面必填。退货单没有专门的原因列，原因附在备注末尾留痕；
   * 老客户端不带原因时行为与加片前一致（备注不动）。
   */
  public async void(
    kind: ReturnKind,
    id: string,
    _byUserId: string,
    reason?: string,
  ): Promise<ReturnDocRecord> {
    return await this.inTransaction(undefined, async (tx) => {
      const knex = await this.knex(tx);
      const row = await this.requireDraft(knex, kind, id);
      const note = reason === undefined ? '' : reason.trim().slice(0, 500);
      const remark = note
        ? `${row.remark}${row.remark ? '\n' : ''}[void reason: ${note}]`
        : row.remark;
      await knex('return_docs').where({ id }).update({
        status: 'void', remark, updated_at: new Date(),
      });
      return await this.detailIn(tx, kind, id);
    });
  }

  private async handlerOf(
    knex: Knex,
    handlerUserId: string | null | undefined,
    byUserId: string,
  ): Promise<string | null> {
    if (handlerUserId !== undefined && handlerUserId !== null) {
      await requirePerson(knex, handlerUserId);
      return handlerUserId;
    }
    return handlerUserId === undefined && await isActivePerson(knex, byUserId) ? byUserId : null;
  }

  private async requireDraft(
    knex: Knex,
    kind: ReturnKind,
    id: string,
  ): Promise<HeaderRow> {
    const result = await knex.raw<{ rows?: readonly HeaderRow[] }>(
      `select * from return_docs where id = ? and doc_type = ? for update`,
      [id, kind],
    );
    const row = result.rows?.[0];
    if (row === undefined) return fail('return-not-found', id);
    if (row.status !== 'draft') return fail('return-not-draft', id);
    return row;
  }

  private async insertLines(
    knex: Knex,
    docId: string,
    lines: readonly ResolvedLine[],
  ): Promise<void> {
    for (const line of lines) {
      await knex('return_doc_lines').insert({
        id: randomUUID(),
        doc_id: docId,
        source_line_id: line.sourceLineId,
        item_id: line.itemId,
        warehouse_id: line.warehouseId,
        batch_no: line.batchNo,
        qty: line.qty,
        return_qty: line.returnQty,
        note: line.note,
      });
    }
  }

  private async detailIn(
    tx: DatabaseConnection,
    kind: ReturnKind,
    id: string,
  ): Promise<ReturnDocRecord> {
    const knex = await this.knex(tx);
    const row = await knex<HeaderRow>('return_docs').where({ id, doc_type: kind }).first();
    if (row === undefined) return fail('return-not-found', id);
    const doc = await viewOf(knex, this.docFiles, row, id, await refsOf(knex, [row]));
    return { ...doc, files: await this.docFiles.filesOf(knex, 'return_doc', id) };
  }
}

export const returnsReaderToken: ServiceToken<ReturnsReader> =
  createServiceToken<ReturnsReader>('app/returns-reader');
export const returnsMutationsToken: ServiceToken<ReturnsMutations> =
  createServiceToken<ReturnsMutations>('app/returns-mutations');

export default class ReturnsProvider extends ServiceProvider<Application> {
  public readonly name: string = 'app.returns';

  public override register(): void {
    this.app.container.singleton(returnsReaderToken, () => {
      const database = this.app.container.resolve(databaseManagerToken);
      return new DatabaseReturnsReader(database, this.app.container.resolve(docFilesToken));
    });
    this.app.container.singleton(returnsMutationsToken, () => {
      const database = this.app.container.resolve(databaseManagerToken);
      return new DatabaseReturnsMutations(
        database,
        this.app.container.resolve(codeServiceToken),
        this.app.container.resolve(docFilesToken),
        this.app.container.resolve(stockMutationsToken),
      );
    });
  }
}
