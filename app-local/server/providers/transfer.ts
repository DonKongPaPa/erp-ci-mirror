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
 * R-020 波 1：调拨单读写服务。
 *
 * 建单是草稿；过账在同一事务里生成调出 other_out 与调入 other_in 两张出入库单，
 * 并调用既有过账路径逐行锁现存量。调出不够时整事务回滚：两张单都不落、状态不变。
 */
export type TransferStatus = 'draft' | 'posted' | 'void';

export type TransferRuleCode =
  | 'transfer-not-found'
  | 'transfer-not-draft'
  | 'transfer-qty-invalid'
  | 'transfer-insufficient'
  | 'transfer-same-warehouse'
  | 'warehouse-not-found'
  | 'warehouse-inactive'
  | 'item-not-found'
  | 'item-inactive'
  | 'person-invalid'
  | 'line-invalid'
  | 'empty-update';

export class TransferRuleError extends Error {
  public constructor(
    readonly code: TransferRuleCode,
    readonly detail?: string,
  ) {
    super(detail ?? `Transfer rule violated: ${code}`);
    this.name = 'TransferRuleError';
  }
}

function fail(code: TransferRuleCode, detail?: string): never {
  throw new TransferRuleError(code, detail);
}

/** 过账失败照库存的既有规则码回给调用方，不另造调拨自己的规则码。 */
function stockError(error: unknown): never {
  if (error instanceof StockRuleError) {
    if (error.code === 'insufficient') return fail('transfer-insufficient', error.detail);
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
}

export interface TransferLineRecord {
  readonly id: string;
  readonly itemId: string;
  readonly qty: number;
  readonly transferQty: number | null;
  readonly note: string | null;
  readonly item: ItemRef;
}

export interface TransferSummary {
  readonly id: string;
  readonly docNo: string;
  readonly docDate: string | null;
  readonly status: TransferStatus;
  readonly warehouseIn: WarehouseRef;
  readonly warehouseOut: WarehouseRef | null;
  readonly handler: PersonRef | null;
  readonly remark: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface TransferRecord extends TransferSummary {
  readonly lines: readonly TransferLineRecord[];
  readonly files: readonly DocFileView[];
}

export interface PostResult {
  readonly transfer: TransferRecord;
  readonly outDocId: string | null;
  readonly inDocId: string;
}

export interface PageQuery {
  readonly page: number;
  readonly pageSize: number;
}
export interface TransferListQuery extends PageQuery {
  readonly transferInWarehouseId?: string;
  readonly transferOutWarehouseId?: string;
  readonly status?: TransferStatus;
  readonly from?: string;
  readonly to?: string;
  readonly q?: string;
}
export interface Page<T> {
  readonly items: readonly T[];
  readonly total: number;
}

export interface TransferLineInput {
  readonly itemId: string;
  readonly qty: number;
  readonly transferQty?: number | null;
  readonly note?: string | null;
}
export interface CreateTransferInput {
  readonly transferInWarehouseId: string;
  readonly transferOutWarehouseId?: string | null;
  readonly docDate?: string | null;
  readonly handlerUserId?: string | null;
  readonly remark?: string;
  readonly fileIds?: readonly string[];
  readonly lines: readonly TransferLineInput[];
}
export interface UpdateTransferInput {
  readonly transferInWarehouseId?: string;
  readonly transferOutWarehouseId?: string | null;
  readonly docDate?: string | null;
  readonly handlerUserId?: string | null;
  readonly remark?: string;
  readonly fileIds?: readonly string[];
  readonly lines?: readonly TransferLineInput[];
}

export interface TransferReader {
  list(query: TransferListQuery): Promise<Page<TransferSummary>>;
  detail(id: string): Promise<TransferRecord | undefined>;
}

export interface TransferMutations {
  create(input: CreateTransferInput, byUserId: string): Promise<TransferRecord>;
  update(id: string, input: UpdateTransferInput, byUserId: string): Promise<TransferRecord>;
  post(id: string, byUserId: string, transaction?: DatabaseConnection): Promise<PostResult>;
  void(id: string, byUserId: string): Promise<TransferRecord>;
}

interface HeaderRow {
  id: string;
  doc_no: string;
  doc_date: string | Date | null;
  transfer_in_warehouse_id: string;
  transfer_out_warehouse_id: string | null;
  handler_user_id: string | null;
  status: string;
  remark: string;
  created_at: string | Date;
  updated_at: string | Date;
}
interface LineRow {
  id: string;
  doc_id: string;
  item_id: string;
  qty: string | number;
  transfer_qty: string | number | null;
  note: string | null;
}
interface RefRow { id: string; name: string | null; }
interface ItemRow {
  id: string;
  code: string;
  name: string;
  spec: string | null;
  unit_code: string;
}

const num = (value: string | number): number => Number(value);
const nullableNum = (value: string | number | null | undefined): number | null =>
  value === null || value === undefined ? null : num(value);
const dayString = (value: string | Date | null): string | null =>
  value === null ? null : typeof value === 'string' ? value.slice(0, 10) :
    `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;

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

function validateLines(lines: readonly TransferLineInput[]): void {
  if (lines.length === 0) return fail('line-invalid', 'empty');
  const seen = new Set<string>();
  for (const line of lines) {
    if (typeof line.itemId !== 'string' || line.itemId.trim() === '') return fail('line-invalid');
    if (seen.has(line.itemId)) return fail('line-invalid', 'duplicate');
    seen.add(line.itemId);
    if (typeof line.qty !== 'number' || !Number.isFinite(line.qty) || line.qty <= 0) {
      return fail('transfer-qty-invalid', 'qty');
    }
    const effective = line.transferQty === undefined || line.transferQty === null
      ? line.qty : line.transferQty;
    if (typeof effective !== 'number' || !Number.isFinite(effective) ||
        effective <= 0 || effective > line.qty) {
      return fail('transfer-qty-invalid', 'transferQty');
    }
    if ((line.note ?? '').length > 500) return fail('line-invalid', 'note');
  }
}

function summaryOf(
  row: HeaderRow,
  warehouses: Map<string, WarehouseRef>,
  people: Map<string, PersonRef>,
): TransferSummary {
  const fallback = (id: string): WarehouseRef => ({ id, name: id });
  return {
    id: row.id,
    docNo: row.doc_no,
    docDate: dayString(row.doc_date),
    status: row.status as TransferStatus,
    warehouseIn: warehouses.get(row.transfer_in_warehouse_id) ?? fallback(row.transfer_in_warehouse_id),
    warehouseOut: row.transfer_out_warehouse_id === null
      ? null
      : (warehouses.get(row.transfer_out_warehouse_id) ?? fallback(row.transfer_out_warehouse_id)),
    handler: row.handler_user_id === null ? null : (people.get(row.handler_user_id) ?? null),
    remark: row.remark,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

function itemView(row: ItemRow): ItemRef {
  return {
    id: row.id, code: row.code, name: row.name,
    spec: row.spec ?? null, unitCode: row.unit_code,
  };
}

function lineView(row: LineRow, items: Map<string, ItemRef>): TransferLineRecord {
  const fallback: ItemRef = { id: row.item_id, code: row.item_id, name: row.item_id, spec: null, unitCode: '' };
  return {
    id: row.id,
    itemId: row.item_id,
    qty: num(row.qty),
    transferQty: nullableNum(row.transfer_qty),
    note: row.note ?? null,
    item: items.get(row.item_id) ?? fallback,
  };
}

async function readDetail(
  knex: Knex,
  docFiles: DocFiles,
  id: string,
): Promise<TransferRecord | undefined> {
  const row = await knex<HeaderRow>('transfer_docs').where({ id }).first();
  if (row === undefined) return undefined;
  const lineRows = await knex<LineRow>('transfer_doc_lines')
    .where({ doc_id: id }).orderBy('id', 'asc');
  const refs = await refsOf(knex, [row]);
  const itemRows = await knex<ItemRow>('items')
    .select('id', 'code', 'name', 'spec', 'unit_code')
    .whereIn('id', lineRows.map((line) => line.item_id));
  const items = new Map(itemRows.map((item) => [item.id, itemView(item)]));
  return {
    ...summaryOf(row, refs.warehouses, refs.people),
    lines: lineRows.map((line) => lineView(line, items)),
    files: await docFiles.filesOf(knex, 'transfer', id),
  };
}

async function refsOf(knex: Knex, rows: readonly HeaderRow[]): Promise<{
  warehouses: Map<string, WarehouseRef>;
  people: Map<string, PersonRef>;
}> {
  const warehouseIds = [...new Set(rows.flatMap((row) => [
    row.transfer_in_warehouse_id, row.transfer_out_warehouse_id,
  ].filter((id): id is string => id !== null)))];
  const userIds = [...new Set(rows.map((row) => row.handler_user_id)
    .filter((id): id is string => id !== null))];
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

export class DatabaseTransferReader implements TransferReader {
  public constructor(
    private readonly database: DatabaseManager,
    private readonly docFiles: DocFiles,
  ) {}

  private async knex(): Promise<Knex> {
    return await this.database.connection().client<Knex>();
  }

  public async list(query: TransferListQuery): Promise<Page<TransferSummary>> {
    const knex = await this.knex();
    const base = knex<HeaderRow>('transfer_docs').modify((builder) => {
      if (query.transferInWarehouseId !== undefined) {
        void builder.where('transfer_in_warehouse_id', query.transferInWarehouseId);
      }
      if (query.transferOutWarehouseId !== undefined) {
        void builder.where('transfer_out_warehouse_id', query.transferOutWarehouseId);
      }
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

  public async detail(id: string): Promise<TransferRecord | undefined> {
    return await readDetail(await this.knex(), this.docFiles, id);
  }
}

export class DatabaseTransferMutations implements TransferMutations {
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

  public async create(input: CreateTransferInput, byUserId: string): Promise<TransferRecord> {
    return await this.inTransaction(undefined, async (tx) => {
      await this.assertHeader(tx, input.transferInWarehouseId, input.transferOutWarehouseId ?? null);
      validateLines(input.lines);
      const knex = await this.knex(tx);
      await requireItems(knex, input.lines.map((line) => line.itemId));
      if (input.handlerUserId !== undefined && input.handlerUserId !== null) {
        await requirePerson(knex, input.handlerUserId);
      }
      const now = new Date();
      const docNo = await this.codes.nextCode(tx, 'DB');
      const id = randomUUID();
      await knex('transfer_docs').insert({
        id,
        doc_no: docNo,
        doc_date: input.docDate ?? null,
        transfer_in_warehouse_id: input.transferInWarehouseId,
        transfer_out_warehouse_id: input.transferOutWarehouseId ?? null,
        handler_user_id: input.handlerUserId ?? byUserId,
        status: 'draft',
        remark: input.remark ?? '',
        created_by_id: byUserId,
        created_at: now,
        updated_at: now,
      });
      await this.insertLines(knex, id, input.lines);
      await this.docFiles.bind(knex, 'transfer', id, input.fileIds, byUserId);
      return await this.detailIn(tx, id);
    });
  }

  public async update(
    id: string,
    input: UpdateTransferInput,
    byUserId: string,
  ): Promise<TransferRecord> {
    return await this.inTransaction(undefined, async (tx) => {
      const knex = await this.knex(tx);
      const header = await this.requireDraft(knex, id);
      if (input.transferInWarehouseId === undefined && input.transferOutWarehouseId === undefined &&
          input.docDate === undefined && input.handlerUserId === undefined &&
          input.remark === undefined && input.fileIds === undefined && input.lines === undefined) {
        return fail('empty-update');
      }
      const warehouseIn = input.transferInWarehouseId ?? header.transfer_in_warehouse_id;
      const warehouseOut = input.transferOutWarehouseId === undefined
        ? header.transfer_out_warehouse_id : input.transferOutWarehouseId;
      await this.assertHeader(tx, warehouseIn, warehouseOut);
      if (input.lines !== undefined) {
        validateLines(input.lines);
        await requireItems(knex, input.lines.map((line) => line.itemId));
      }
      if (input.handlerUserId !== undefined && input.handlerUserId !== null) {
        await requirePerson(knex, input.handlerUserId);
      }
      await knex('transfer_docs').where({ id }).update({
        ...(input.transferInWarehouseId === undefined ? {} : { transfer_in_warehouse_id: input.transferInWarehouseId }),
        ...(input.transferOutWarehouseId === undefined ? {} : { transfer_out_warehouse_id: input.transferOutWarehouseId }),
        ...(input.docDate === undefined ? {} : { doc_date: input.docDate }),
        ...(input.handlerUserId === undefined ? {} : { handler_user_id: input.handlerUserId }),
        ...(input.remark === undefined ? {} : { remark: input.remark }),
        updated_at: new Date(),
      });
      if (input.lines !== undefined) {
        await knex('transfer_doc_lines').where({ doc_id: id }).delete();
        await this.insertLines(knex, id, input.lines);
      }
      await this.docFiles.bind(knex, 'transfer', id, input.fileIds, byUserId);
      return await this.detailIn(tx, id);
    });
  }

  public async post(
    id: string,
    byUserId: string,
    transaction?: DatabaseConnection,
  ): Promise<PostResult> {
    return await this.inTransaction(transaction, async (tx) => {
      const knex = await this.knex(tx);
      const header = await this.requireDraft(knex, id);
      const lines = await knex<LineRow>('transfer_doc_lines')
        .where({ doc_id: id }).orderBy('id', 'asc');
      if (lines.length === 0) return fail('line-invalid', 'empty');
      const qtyByItem = lines.map((line) => {
        const qty = num(line.qty);
        const transferQty = line.transfer_qty === null ? qty : num(line.transfer_qty);
        if (!Number.isFinite(qty) || !Number.isFinite(transferQty) ||
            transferQty <= 0 || transferQty > qty) {
          return fail('transfer-qty-invalid', line.id);
        }
        return { itemId: line.item_id, qty: transferQty };
      });
      const docDate = dayString(header.doc_date);
      let outDocId: string | null = null;
      if (header.transfer_out_warehouse_id !== null) {
        outDocId = await this.generateDoc(
          'out', 'other_out', header.transfer_out_warehouse_id, qtyByItem,
          id, docDate, byUserId, tx,
        );
      }
      const inDocId = await this.generateDoc(
        'in', 'other_in', header.transfer_in_warehouse_id, qtyByItem,
        id, docDate, byUserId, tx,
      );
      if (inDocId === null) return fail('line-invalid', 'empty');
      await knex('transfer_docs').where({ id }).update({
        status: 'posted',
        updated_at: new Date(),
      });
      return { transfer: await this.detailIn(tx, id), outDocId, inDocId };
    });
  }

  public async void(id: string, _byUserId: string): Promise<TransferRecord> {
    return await this.inTransaction(undefined, async (tx) => {
      const knex = await this.knex(tx);
      await this.requireDraft(knex, id);
      await knex('transfer_docs').where({ id }).update({
        status: 'void',
        updated_at: new Date(),
      });
      return await this.detailIn(tx, id);
    });
  }

  private async assertHeader(
    tx: DatabaseConnection,
    warehouseIn: string,
    warehouseOut: string | null,
  ): Promise<void> {
    if (warehouseIn === warehouseOut && warehouseOut !== null) return fail('transfer-same-warehouse');
    const knex = await this.knex(tx);
    await requireWarehouse(knex, warehouseIn);
    if (warehouseOut !== null) await requireWarehouse(knex, warehouseOut);
  }

  private async generateDoc(
    docType: 'in' | 'out',
    reason: 'other_in' | 'other_out',
    warehouseId: string,
    lines: readonly { readonly itemId: string; readonly qty: number }[],
    transferDocId: string,
    docDate: string | null,
    byUserId: string,
    tx: DatabaseConnection,
  ): Promise<string | null> {
    let docId: string;
    try {
      const doc = await this.stockMutations.createDoc({
        docType,
        reason,
        docDate,
        transferDocId,
        lines: lines.map((line) => ({ itemId: line.itemId, warehouseId, qty: line.qty })),
      }, byUserId, tx);
      docId = String(doc.id);
      await this.stockMutations.post(docId, byUserId, tx);
    } catch (error) {
      return stockError(error);
    }
    return docId;
  }

  private async requireDraft(knex: Knex, id: string): Promise<HeaderRow> {
    const result = await knex.raw<{ rows?: readonly HeaderRow[] }>(
      `select * from transfer_docs where id = ? for update`,
      [id],
    );
    const row = result.rows?.[0];
    if (row === undefined) return fail('transfer-not-found', id);
    if (row.status !== 'draft') return fail('transfer-not-draft', id);
    return row;
  }

  private async insertLines(
    knex: Knex,
    docId: string,
    lines: readonly TransferLineInput[],
  ): Promise<void> {
    for (const line of lines) {
      await knex('transfer_doc_lines').insert({
        id: randomUUID(),
        doc_id: docId,
        item_id: line.itemId.trim(),
        qty: line.qty,
        transfer_qty: line.transferQty ?? line.qty,
        note: line.note ?? null,
      });
    }
  }

  private async detailIn(tx: DatabaseConnection, id: string): Promise<TransferRecord> {
    const row = await readDetail(await this.knex(tx), this.docFiles, id);
    if (row === undefined) return fail('transfer-not-found', id);
    return row;
  }
}

export const transferReaderToken: ServiceToken<TransferReader> =
  createServiceToken<TransferReader>('app/transfer-reader');
export const transferMutationsToken: ServiceToken<TransferMutations> =
  createServiceToken<TransferMutations>('app/transfer-mutations');

export default class TransferProvider extends ServiceProvider<Application> {
  public readonly name: string = 'app.transfer';

  public override register(): void {
    this.app.container.singleton(transferReaderToken, () => {
      const database = this.app.container.resolve(databaseManagerToken);
      return new DatabaseTransferReader(database, this.app.container.resolve(docFilesToken));
    });
    this.app.container.singleton(transferMutationsToken, () => {
      const database = this.app.container.resolve(databaseManagerToken);
      return new DatabaseTransferMutations(
        database,
        this.app.container.resolve(codeServiceToken),
        this.app.container.resolve(docFilesToken),
        this.app.container.resolve(stockMutationsToken),
      );
    });
  }
}
