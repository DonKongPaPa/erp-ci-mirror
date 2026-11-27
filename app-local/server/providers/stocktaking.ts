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
import {
  StockRuleError,
  stockMutationsToken,
  type StockMutations,
} from './inventory.js';

/**
 * R-020 波 1：盘点单读写服务。
 *
 * 加行时的 systemQty 是现存量快照，盘点期间不冻结库存；结束时按快照算盈亏，
 * 在同事务里生成盘盈入库与盘亏出库两张 other_in / other_out，并走既有过账路径
 * （锁现存量行、写流水）。锁盘点单头保证重复结束只有一次成功；部分唯一索引兜底。
 */
export type StocktakingStatus = 'staging' | 'finished' | 'void';
export type StocktakingResult = 'balanced' | 'profit' | 'loss';

export type StocktakingRuleCode =
  | 'stocktaking-not-found'
  | 'stocktaking-not-staging'
  | 'actual-required'
  | 'supervisor-required'
  | 'duplicate-item'
  | 'warehouse-not-found'
  | 'warehouse-inactive'
  | 'item-not-found'
  | 'item-inactive'
  | 'person-invalid'
  | 'line-invalid'
  | 'empty-update'
  | 'insufficient';

export class StocktakingRuleError extends Error {
  public constructor(
    readonly code: StocktakingRuleCode,
    readonly detail?: string,
  ) {
    super(detail ?? `Stocktaking rule violated: ${code}`);
    this.name = 'StocktakingRuleError';
  }
}

function fail(code: StocktakingRuleCode, detail?: string): never {
  throw new StocktakingRuleError(code, detail);
}

/** 过账失败照库存的既有规则码回给调用方，不另造盘点自己的库存码。 */
function stockError(error: unknown): never {
  if (error instanceof StockRuleError) {
    if (error.code === 'insufficient') return fail('insufficient', error.detail);
    if (error.code === 'warehouse-not-found' || error.code === 'warehouse-inactive' ||
        error.code === 'item-not-found' || error.code === 'item-inactive' ||
        error.code === 'line-invalid' || error.code === 'person-invalid') {
      return fail(error.code, error.detail);
    }
  }
  throw error;
}

export interface PersonRef { readonly userId: string; readonly name: string; }
export interface WarehouseRef { readonly id: string; readonly name: string; }
export interface ItemRef {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly spec: string | null;
  readonly unitCode: string;
  readonly barcode: string | null;
}

export interface StocktakingLineRecord {
  readonly id: string;
  readonly itemId: string;
  readonly systemQty: number;
  readonly actualQty: number | null;
  readonly deltaQty: number | null;
  readonly result: StocktakingResult | null;
  readonly note: string | null;
  readonly item: ItemRef;
}

export interface StocktakingSummary {
  readonly id: string;
  readonly docNo: string;
  readonly docDate: string;
  readonly status: StocktakingStatus;
  readonly warehouse: WarehouseRef;
  readonly handler: PersonRef | null;
  readonly supervisor: PersonRef | null;
  readonly remark: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface StocktakingRecord extends StocktakingSummary {
  readonly lines: readonly StocktakingLineRecord[];
  readonly files: readonly DocFileView[];
}

export interface FinishResult {
  readonly stocktaking: StocktakingRecord;
  readonly profitDocId: string | null;
  readonly lossDocId: string | null;
}

export interface PageQuery {
  readonly page: number;
  readonly pageSize: number;
}
export interface StocktakingListQuery extends PageQuery {
  readonly warehouseId?: string;
  readonly status?: StocktakingStatus;
  readonly from?: string;
  readonly to?: string;
  readonly q?: string;
}
export interface Page<T> {
  readonly items: readonly T[];
  readonly total: number;
}

export interface StocktakingLineInput {
  readonly itemId: string;
  readonly actualQty?: number | null;
  readonly note?: string | null;
}
export interface CreateStocktakingInput {
  readonly warehouseId: string;
  readonly docDate?: string | null;
  readonly handlerUserId?: string | null;
  readonly remark?: string;
  readonly fileIds?: readonly string[];
  readonly lines?: readonly StocktakingLineInput[];
}
export interface UpdateStocktakingInput {
  readonly handlerUserId?: string | null;
  readonly remark?: string;
  readonly fileIds?: readonly string[];
  readonly lines?: readonly StocktakingLineInput[];
}

export interface StocktakingReader {
  list(query: StocktakingListQuery): Promise<Page<StocktakingSummary>>;
  detail(id: string): Promise<StocktakingRecord | undefined>;
}

export interface StocktakingMutations {
  create(input: CreateStocktakingInput, byUserId: string): Promise<StocktakingRecord>;
  update(id: string, input: UpdateStocktakingInput, byUserId: string): Promise<StocktakingRecord>;
  finish(
    id: string,
    supervisorUserId: string,
    byUserId: string,
    transaction?: DatabaseConnection,
  ): Promise<FinishResult>;
  void(id: string, byUserId: string): Promise<StocktakingRecord>;
}

interface HeaderRow {
  id: string;
  doc_no: string;
  doc_date: string | Date;
  warehouse_id: string;
  handler_user_id: string | null;
  supervisor_user_id: string | null;
  status: string;
  remark: string;
  created_at: string | Date;
  updated_at: string | Date;
}
interface LineRow {
  id: string;
  doc_id: string;
  item_id: string;
  system_qty: string | number;
  actual_qty: string | number | null;
  delta_qty: string | number | null;
  result: string | null;
  note: string | null;
}
interface RefRow { id: string; name: string | null; }
interface ItemRow {
  id: string;
  code: string;
  name: string;
  spec: string | null;
  unit_code: string;
  barcode: string | null;
}

const num = (value: string | number): number => Number(value);
const nullableNum = (value: string | number | null | undefined): number | null =>
  value === null || value === undefined ? null : num(value);

function dayString(value: string | Date): string {
  if (typeof value === 'string') return value.slice(0, 10);
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${value.getFullYear()}-${month}-${day}`;
}

/** 新建不传盘点日期时按 Asia/Shanghai 的当天填，与出入库单同一口径。 */
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

async function requireWarehouse(knex: Knex, id: string): Promise<void> {
  const row = await knex<{ id: string; status: string }>('warehouses')
    .select('id', 'status').where({ id }).first();
  if (row === undefined) return fail('warehouse-not-found', id);
  if (row.status !== 'active') return fail('warehouse-inactive', id);
}

async function requirePerson(knex: Knex, userId: string): Promise<void> {
  const row = await knex<{ user_id: string; status: string }>('employees')
    .select('user_id', 'status').where({ user_id: userId }).first();
  if (row === undefined || row.status !== 'active') return fail('person-invalid', userId);
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

/** 现存量按 (itemId, warehouseId) 跨批次求和，作为加行时的快照。 */
async function systemQtyOf(knex: Knex, itemId: string, warehouseId: string): Promise<number> {
  const result = await knex.raw<{ rows?: readonly { qty: string | number | null }[] }>(
    `select coalesce(sum(qty), 0) as qty
       from stock_balances where item_id = ? and warehouse_id = ?`,
    [itemId, warehouseId],
  );
  return num(result.rows?.[0]?.qty ?? 0);
}

function validateLines(lines: readonly StocktakingLineInput[]): void {
  const seen = new Set<string>();
  for (const line of lines) {
    if (typeof line.itemId !== 'string' || line.itemId.trim() === '') return fail('line-invalid');
    if (seen.has(line.itemId)) return fail('duplicate-item', line.itemId);
    seen.add(line.itemId);
    if (line.actualQty !== undefined && line.actualQty !== null &&
        (!Number.isFinite(line.actualQty) || line.actualQty < 0)) {
      return fail('line-invalid', 'actualQty');
    }
    if ((line.note ?? '').length > 500) return fail('line-invalid', 'note');
  }
}

function summaryOf(
  row: HeaderRow,
  warehouses: Map<string, WarehouseRef>,
  people: Map<string, PersonRef>,
): StocktakingSummary {
  return {
    id: row.id,
    docNo: row.doc_no,
    docDate: dayString(row.doc_date),
    status: row.status as StocktakingStatus,
    warehouse: warehouses.get(row.warehouse_id) ?? { id: row.warehouse_id, name: row.warehouse_id },
    handler: row.handler_user_id === null ? null : (people.get(row.handler_user_id) ?? null),
    supervisor: row.supervisor_user_id === null ? null : (people.get(row.supervisor_user_id) ?? null),
    remark: row.remark,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

function itemView(row: ItemRow): ItemRef {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    spec: row.spec ?? null,
    unitCode: row.unit_code,
    barcode: row.barcode ?? null,
  };
}

function lineView(row: LineRow, items: Map<string, ItemRef>): StocktakingLineRecord {
  const fallback: ItemRef = {
    id: row.item_id, code: row.item_id, name: row.item_id,
    spec: null, unitCode: '', barcode: null,
  };
  return {
    id: row.id,
    itemId: row.item_id,
    systemQty: num(row.system_qty),
    actualQty: nullableNum(row.actual_qty),
    deltaQty: nullableNum(row.delta_qty),
    result: row.result as StocktakingResult | null,
    note: row.note ?? null,
    item: items.get(row.item_id) ?? fallback,
  };
}

export class DatabaseStocktakingReader implements StocktakingReader {
  public constructor(
    private readonly database: DatabaseManager,
    private readonly docFiles: DocFiles,
  ) {}

  private async knex(): Promise<Knex> {
    return await this.database.connection().client<Knex>();
  }

  public async list(query: StocktakingListQuery): Promise<Page<StocktakingSummary>> {
    const knex = await this.knex();
    const base = knex<HeaderRow>('stocktaking_docs').modify((builder) => {
      if (query.warehouseId !== undefined) void builder.where('warehouse_id', query.warehouseId);
      if (query.status !== undefined) void builder.where('status', query.status);
      if (query.q !== undefined && query.q !== '') {
        void builder.where((inner) => {
          inner.whereILike('doc_no', `%${query.q}%`).orWhereILike('remark', `%${query.q}%`);
        });
      }
      if (query.from !== undefined) void builder.where('doc_date', '>=', query.from);
      if (query.to !== undefined) void builder.where('doc_date', '<=', query.to);
    });
    const total = await countOf(base);
    const rows = (await base.clone()
      .orderBy('created_at', 'desc')
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize)) as HeaderRow[];
    const refs = await refsOf(knex, rows);
    return {
      items: rows.map((row) => summaryOf(row, refs.warehouses, refs.people)),
      total,
    };
  }

  public async detail(id: string): Promise<StocktakingRecord | undefined> {
    return await readDetail(await this.knex(), this.docFiles, id);
  }
}

async function readDetail(
  knex: Knex,
  docFiles: DocFiles,
  id: string,
): Promise<StocktakingRecord | undefined> {
  const row = await knex<HeaderRow>('stocktaking_docs').where({ id }).first();
  if (row === undefined) return undefined;
  const lineRows = await knex<LineRow>('stocktaking_doc_lines')
    .where({ doc_id: id }).orderBy('id', 'asc');
  const refs = await refsOf(knex, [row]);
  const itemRows = await knex<ItemRow>('items')
    .select('id', 'code', 'name', 'spec', 'unit_code', 'barcode')
    .whereIn('id', lineRows.map((line) => line.item_id));
  const items = new Map(itemRows.map((item) => [item.id, itemView(item)]));
  return {
    ...summaryOf(row, refs.warehouses, refs.people),
    lines: lineRows.map((line) => lineView(line, items)),
    files: await docFiles.filesOf(knex, 'stocktaking', id),
  };
}

async function refsOf(knex: Knex, rows: readonly HeaderRow[]): Promise<{
  warehouses: Map<string, WarehouseRef>;
  people: Map<string, PersonRef>;
}> {
  const warehouseIds = [...new Set(rows.map((row) => row.warehouse_id))];
  const userIds = [...new Set(rows.flatMap((row) => [
    row.handler_user_id, row.supervisor_user_id,
  ]).filter((id): id is string => id !== null))];
  const [warehouses, people] = await Promise.all([
    warehouseIds.length === 0
      ? []
      : knex<RefRow>('warehouses').select('id', 'name').whereIn('id', warehouseIds),
    userIds.length === 0
      ? []
      : knex<RefRow>('user').select('id', 'name').whereIn('id', userIds),
  ]);
  return {
    warehouses: new Map(warehouses.map((row) => [row.id, { id: row.id, name: row.name ?? row.id }])),
    people: new Map(people.map((row) => [row.id, { userId: row.id, name: row.name ?? row.id }])),
  };
}

export class DatabaseStocktakingMutations implements StocktakingMutations {
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

  public async create(input: CreateStocktakingInput, byUserId: string): Promise<StocktakingRecord> {
    validateLines(input.lines ?? []);
    if (input.remark !== undefined && input.remark.length > 1000) return fail('line-invalid', 'remark');
    return await this.inTransaction(undefined, async (tx) => {
      const knex = await this.knex(tx);
      await requireWarehouse(knex, input.warehouseId);
      await requireItems(knex, (input.lines ?? []).map((line) => line.itemId));
      if (input.handlerUserId !== undefined && input.handlerUserId !== null) {
        await requirePerson(knex, input.handlerUserId);
      }
      const now = new Date();
      const docNo = await this.codes.nextCode(tx, 'PD');
      const id = randomUUID();
      await knex('stocktaking_docs').insert({
        id,
        doc_no: docNo,
        doc_date: input.docDate ?? today(),
        warehouse_id: input.warehouseId,
        handler_user_id: input.handlerUserId ?? byUserId,
        supervisor_user_id: null,
        status: 'staging',
        remark: input.remark ?? '',
        created_by_id: byUserId,
        created_at: now,
        updated_at: now,
      });
      await this.insertLines(knex, id, input.warehouseId, input.lines ?? []);
      await this.docFiles.bind(knex, 'stocktaking', id, input.fileIds, byUserId);
      return await this.detailIn(tx, id);
    });
  }

  public async update(
    id: string,
    input: UpdateStocktakingInput,
    byUserId: string,
  ): Promise<StocktakingRecord> {
    return await this.inTransaction(undefined, async (tx) => {
      const knex = await this.knex(tx);
      const row = await this.requireStaging(knex, id);
      if (input.handlerUserId === undefined && input.remark === undefined &&
          input.fileIds === undefined && input.lines === undefined) {
        return fail('empty-update');
      }
      if (input.lines !== undefined) validateLines(input.lines);
      if (input.handlerUserId !== undefined && input.handlerUserId !== null) {
        await requirePerson(knex, input.handlerUserId);
      }
      if (input.lines !== undefined) {
        await requireItems(knex, input.lines.map((line) => line.itemId));
      }
      await knex('stocktaking_docs').where({ id }).update({
        ...(input.handlerUserId === undefined ? {} : { handler_user_id: input.handlerUserId }),
        ...(input.remark === undefined ? {} : { remark: input.remark }),
        updated_at: new Date(),
      });
      if (input.lines !== undefined) {
        await knex('stocktaking_doc_lines').where({ doc_id: id }).delete();
        await this.insertLines(knex, id, row.warehouse_id, input.lines);
      }
      await this.docFiles.bind(knex, 'stocktaking', id, input.fileIds, byUserId);
      return await this.detailIn(tx, id);
    });
  }

  public async finish(
    id: string,
    supervisorUserId: string,
    byUserId: string,
    transaction?: DatabaseConnection,
  ): Promise<FinishResult> {
    return await this.inTransaction(transaction, async (tx) => {
      const knex = await this.knex(tx);
      await this.requireStaging(knex, id);
      if (typeof supervisorUserId !== 'string' || supervisorUserId.trim() === '') {
        return fail('supervisor-required');
      }
      await requirePerson(knex, supervisorUserId);
      const lines = await knex<LineRow>('stocktaking_doc_lines')
        .where({ doc_id: id }).orderBy('id', 'asc');
      for (const line of lines) {
        if (line.actual_qty === null || line.actual_qty === undefined) {
          return fail('actual-required', line.id);
        }
      }
      const header = await knex<HeaderRow>('stocktaking_docs').where({ id }).first();
      if (header === undefined) return fail('stocktaking-not-found', id);
      const results = lines.map((line) => {
        const delta = num(line.actual_qty as string | number) - num(line.system_qty);
        return {
          id: line.id,
          itemId: line.item_id,
          delta,
          result: delta === 0 ? 'balanced' : delta > 0 ? 'profit' : 'loss',
        } as const;
      });
      for (const result of results) {
        await knex('stocktaking_doc_lines').where({ id: result.id }).update({
          delta_qty: result.delta,
          result: result.result,
        });
      }
      const docDate = dayString(header.doc_date);
      const profit = results.filter((line) => line.result === 'profit');
      const loss = results.filter((line) => line.result === 'loss');
      const profitDocId = await this.generateDoc('in', 'other_in', profit, {
        docDate, warehouseId: header.warehouse_id, stocktakingId: id,
      }, byUserId, tx);
      const lossDocId = await this.generateDoc('out', 'other_out', loss, {
        docDate, warehouseId: header.warehouse_id, stocktakingId: id,
      }, byUserId, tx);
      await knex('stocktaking_docs').where({ id }).update({
        supervisor_user_id: supervisorUserId,
        status: 'finished',
        updated_at: new Date(),
      });
      return {
        stocktaking: await this.detailIn(tx, id),
        profitDocId,
        lossDocId,
      };
    });
  }

  public async void(id: string, _byUserId: string): Promise<StocktakingRecord> {
    return await this.inTransaction(undefined, async (tx) => {
      const knex = await this.knex(tx);
      await this.requireStaging(knex, id);
      await knex('stocktaking_docs').where({ id }).update({
        status: 'void',
        updated_at: new Date(),
      });
      return await this.detailIn(tx, id);
    });
  }

  private async generateDoc(
    docType: 'in' | 'out',
    reason: 'other_in' | 'other_out',
    lines: readonly { readonly itemId: string; readonly delta: number }[],
    link: { docDate: string; warehouseId: string; stocktakingId: string },
    byUserId: string,
    tx: DatabaseConnection,
  ): Promise<string | null> {
    if (lines.length === 0) return null;
    let docId: string;
    try {
      const doc = await this.stockMutations.createDoc({
        docType,
        reason,
        docDate: link.docDate,
        stocktakingId: link.stocktakingId,
        lines: lines.map((line) => ({
          itemId: line.itemId,
          warehouseId: link.warehouseId,
          batchNo: '',
          qty: Math.abs(line.delta),
        })),
      }, byUserId, tx);
      docId = String(doc.id);
      await this.stockMutations.post(docId, byUserId, tx);
    } catch (error) {
      return stockError(error);
    }
    return docId;
  }

  private async requireStaging(knex: Knex, id: string): Promise<HeaderRow> {
    const result = await knex.raw<{ rows?: readonly HeaderRow[] }>(
      `select * from stocktaking_docs where id = ? for update`,
      [id],
    );
    const row = result.rows?.[0];
    if (row === undefined) return fail('stocktaking-not-found', id);
    if (row.status !== 'staging') return fail('stocktaking-not-staging', id);
    return row;
  }

  private async insertLines(
    knex: Knex,
    docId: string,
    warehouseId: string,
    lines: readonly StocktakingLineInput[],
  ): Promise<void> {
    for (const line of lines) {
      await knex('stocktaking_doc_lines').insert({
        id: randomUUID(),
        doc_id: docId,
        item_id: line.itemId.trim(),
        system_qty: await systemQtyOf(knex, line.itemId.trim(), warehouseId),
        actual_qty: line.actualQty ?? null,
        delta_qty: null,
        result: null,
        note: line.note ?? null,
      });
    }
  }

  private async detailIn(tx: DatabaseConnection, id: string): Promise<StocktakingRecord> {
    const row = await readDetail(await this.knex(tx), this.docFiles, id);
    if (row === undefined) return fail('stocktaking-not-found', id);
    return row;
  }
}

export const stocktakingReaderToken: ServiceToken<StocktakingReader> =
  createServiceToken<StocktakingReader>('app/stocktaking-reader');
export const stocktakingMutationsToken: ServiceToken<StocktakingMutations> =
  createServiceToken<StocktakingMutations>('app/stocktaking-mutations');

export default class StocktakingProvider extends ServiceProvider<Application> {
  public readonly name: string = 'app.stocktaking';

  public override register(): void {
    this.app.container.singleton(stocktakingReaderToken, () => {
      const database = this.app.container.resolve(databaseManagerToken);
      return new DatabaseStocktakingReader(database, this.app.container.resolve(docFilesToken));
    });
    this.app.container.singleton(stocktakingMutationsToken, () => {
      const database = this.app.container.resolve(databaseManagerToken);
      return new DatabaseStocktakingMutations(
        database,
        this.app.container.resolve(codeServiceToken),
        this.app.container.resolve(docFilesToken),
        this.app.container.resolve(stockMutationsToken),
      );
    });
  }
}
