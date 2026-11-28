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
import type { Knex } from 'knex';

import { CODE_PREFIXES, codeServiceToken, type CodeService } from './codes.js';
import { docFilesToken, type DocFiles, type DocFileView } from './doc-files.js';

/**
 * R-019 波 2：BOM 头与行的读写、按生效日期选版、唯一与环校验。
 *
 * 所有写在一个事务里；默认位切换先取进程内咨询锁，部分唯一索引再兜一层并发。
 * `createdById` 只入库不回响应；两个基准价只在 explode 的 totals 上按动作裁。
 * 不提供删除：停用代替，版本失效靠 effectiveFrom / effectiveTo。
 */
const WRITE_LOCK_KEY = 'hs-erp:boms:write';
const MAX_VERSION_LENGTH = 16;
/** 与展开一致：保存时沿子链接查环也最多走 32 层。 */
const MAX_CHAIN_DEPTH = 32;
const NO_END = '9999-12-31';

export type BomRuleCode =
  | 'invalid-input'
  | 'bom-not-found'
  | 'version-taken'
  | 'product-invalid'
  | 'line-duplicated'
  | 'cycle'
  | 'not-effective'
  | 'bom-inactive'
  | 'item-not-found'
  | 'file-not-found'
  | 'file-unavailable';

export class BomRuleError extends Error {
  public constructor(
    readonly code: BomRuleCode,
    readonly detail?: string,
  ) {
    super(detail ?? `BOM rule violated: ${code}`);
    this.name = 'BomRuleError';
  }
}

function fail(code: BomRuleCode, detail?: string): never {
  throw new BomRuleError(code, detail);
}

const DATE = /^\d{4}-\d{2}-\d{2}$/u;

function date(value: unknown, field: string): string {
  if (typeof value !== 'string' || !DATE.test(value)) {
    return fail('invalid-input', field);
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== value
  ) {
    return fail('invalid-input', field);
  }
  return value;
}

function text(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > max) {
    return fail('invalid-input', field);
  }
  return value;
}

function number(value: unknown, field: string): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return fail('invalid-input', field);
  return parsed;
}

function quantity(value: unknown, field: string): number {
  const parsed = number(value, field);
  if (parsed <= 0) return fail('invalid-input', field);
  return parsed;
}

function rate(value: unknown, field: string): number {
  const parsed = number(value, field);
  if (parsed < 0 || parsed > 1) return fail('invalid-input', field);
  return parsed;
}

function nonNegative(value: unknown, field: string): number {
  const parsed = number(value, field);
  if (parsed < 0) return fail('invalid-input', field);
  return parsed;
}

export function round4(value: number): number {
  return Math.round((value + Number.EPSILON) * 10_000) / 10_000;
}

function isoDate(value: string | Date): string {
  return typeof value === 'string'
    ? value.slice(0, 10)
    : value.toISOString().slice(0, 10);
}

function isoTime(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export interface BomHeader {
  readonly id: string;
  readonly docNo: string;
  readonly version: string;
  readonly productId: string;
  readonly isDefault: boolean;
  readonly effectiveFrom: string | Date;
  readonly effectiveTo: string | Date | null;
  readonly dailyOutput: number | string | null;
  readonly status: string;
  readonly remark: string;
  readonly createdById: string;
  readonly createdAt: string | Date;
  readonly updatedAt: string | Date;
}

export interface BomLineRecord {
  readonly id: string;
  readonly bomId: string;
  readonly lineNo: number;
  readonly itemId: string;
  readonly qty: number | string;
  readonly lossRate: number | string;
  readonly childBomId: string | null;
  readonly note: string | null;
}

/** 内部读模型：带价格，但只在 explode 里按动作裁，不进 BomLine.item。 */
export interface BomItem {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly spec: string | null;
  readonly unitCode: string;
  readonly status: string;
  readonly itemType: string;
  readonly brand: string | null;
  readonly manufacturerModel: string | null;
  readonly basePurchasePrice: number | string | null;
}

export interface BomBrief {
  readonly bomId: string;
  readonly docNo: string;
  readonly version: string;
  readonly productId: string;
  readonly isDefault: boolean;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
}

export interface BomLineView {
  readonly id: string;
  readonly lineNo: number;
  readonly itemId: string;
  readonly qty: number;
  readonly lossRate: number;
  readonly childBomId: string | null;
  readonly note: string | null;
  readonly item: {
    readonly id: string;
    readonly code: string;
    readonly name: string;
    readonly spec: string | null;
    readonly unitCode: string;
    readonly brand: string | null;
    readonly manufacturerModel: string | null;
  };
}

export interface BomView {
  readonly id: string;
  readonly docNo: string;
  readonly version: string;
  readonly product: {
    readonly id: string;
    readonly code: string;
    readonly name: string;
    readonly spec: string | null;
    readonly unitCode: string;
  };
  readonly isDefault: boolean;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
  readonly dailyOutput: number | null;
  readonly status: string;
  readonly remark: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lines: readonly BomLineView[];
  readonly files: readonly DocFileView[];
}

export interface BomQuery {
  readonly page: number;
  readonly pageSize: number;
  readonly productId?: string;
  readonly status?: string;
  readonly effectiveOn?: string;
  readonly q?: string;
}

export interface BomLineInput {
  readonly itemId: string;
  readonly qty: number;
  readonly lossRate?: number;
  readonly childBomId?: string;
  readonly note?: string | null;
}

export interface CreateBomInput {
  readonly version: string;
  readonly productId: string;
  readonly isDefault?: boolean;
  readonly effectiveFrom: string;
  readonly effectiveTo?: string | null;
  readonly dailyOutput?: number | null;
  readonly remark?: string;
  readonly fileIds?: readonly string[];
  readonly lines: readonly BomLineInput[];
}

export interface UpdateBomInput {
  readonly version?: string;
  readonly isDefault?: boolean;
  readonly effectiveFrom?: string;
  readonly effectiveTo?: string | null;
  readonly dailyOutput?: number | null;
  readonly status?: string;
  readonly remark?: string;
  readonly fileIds?: readonly string[];
  readonly lines?: readonly BomLineInput[];
}

/** 展开的递归实现只读这张窄接口，版本选取也只有这一处。 */
export interface BomStore {
  header(id: string): Promise<BomHeader | undefined>;
  effective(productId: string, asOf: string): Promise<BomHeader | undefined>;
  lines(bomId: string): Promise<readonly BomLineRecord[]>;
  item(id: string): Promise<BomItem | undefined>;
  files(bomId: string): Promise<readonly DocFileView[]>;
}

export interface BomsReader extends BomStore {
  list(query: BomQuery): Promise<{ readonly items: readonly BomView[]; readonly total: number }>;
  detail(id: string): Promise<BomView | undefined>;
}

export interface BomsMutations {
  create(input: CreateBomInput, actorId: string): Promise<BomView>;
  update(id: string, input: UpdateBomInput): Promise<BomView>;
  void(id: string): Promise<BomView>;
}

export function brief(header: BomHeader): BomBrief {
  return {
    bomId: header.id,
    docNo: header.docNo,
    version: header.version,
    productId: header.productId,
    isDefault: header.isDefault,
    effectiveFrom: isoDate(header.effectiveFrom),
    effectiveTo: header.effectiveTo === null ? null : isoDate(header.effectiveTo),
  };
}

function lineView(line: BomLineRecord, item: BomItem): BomLineView {
  return {
    id: line.id,
    lineNo: line.lineNo,
    itemId: line.itemId,
    qty: Number(line.qty),
    lossRate: Number(line.lossRate),
    childBomId: line.childBomId,
    note: line.note,
    item: {
      id: item.id,
      code: item.code,
      name: item.name,
      spec: item.spec,
      unitCode: item.unitCode,
      brand: item.brand,
      manufacturerModel: item.manufacturerModel,
    },
  };
}

function matches(header: BomHeader, query: BomQuery): boolean {
  const q = query.q?.toLowerCase();
  return (
    (query.productId === undefined || header.productId === query.productId) &&
    (query.status === undefined || header.status === query.status) &&
    (query.effectiveOn === undefined ||
      (isoDate(header.effectiveFrom) <= query.effectiveOn &&
        (header.effectiveTo === null ||
          isoDate(header.effectiveTo) >= query.effectiveOn))) &&
    (q === undefined ||
      header.docNo.toLowerCase().includes(q) ||
      header.version.toLowerCase().includes(q))
  );
}

export class DatabaseBomsReader implements BomsReader {
  public constructor(
    private readonly database: DatabaseManager,
    private readonly docFiles: DocFiles,
  ) {}

  public async header(id: string): Promise<BomHeader | undefined> {
    return await this.database.repository<BomHeader>('boms').findOne({ filter: { id } });
  }

  /** 先按生效区间过滤，再取默认位、最后版本字典序最大；没有就是没有。 */
  public async effective(
    productId: string,
    asOf: string,
  ): Promise<BomHeader | undefined> {
    const rows = await this.database.repository<BomHeader>('boms')
      .findMany({ filter: { productId, status: 'active' } });
    const candidates = rows
      .filter((row) =>
        isoDate(row.effectiveFrom) <= asOf &&
        (row.effectiveTo === null || isoDate(row.effectiveTo) >= asOf) &&
        asOf <= NO_END,
      )
      .sort((left, right) => {
        if (left.isDefault !== right.isDefault) return left.isDefault ? -1 : 1;
        if (left.version !== right.version) {
          return left.version < right.version ? 1 : -1;
        }
        return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
      });
    return candidates[0];
  }

  public async lines(bomId: string): Promise<readonly BomLineRecord[]> {
    return await this.database.repository<BomLineRecord>('bomLines')
      .findMany({
        filter: { bomId },
        sort: {
          kind: 'sort',
          version: 1,
          items: [{ kind: 'field', path: ['lineNo'], direction: 'asc' }],
        },
      });
  }

  public async item(id: string): Promise<BomItem | undefined> {
    return await this.database.repository<BomItem>('items').findOne({ filter: { id } });
  }

  public async files(bomId: string): Promise<readonly DocFileView[]> {
    const knex = await this.database.connection().client<Knex>();
    return await this.docFiles.filesOf(knex, 'bom', bomId);
  }

  public async list(
    query: BomQuery,
  ): Promise<{ readonly items: readonly BomView[]; readonly total: number }> {
    const rows = (await this.database.repository<BomHeader>('boms').findMany())
      .filter((row) => matches(row, query))
      .sort((left, right) =>
        left.docNo < right.docNo ? -1 : left.docNo > right.docNo ? 1 : 0,
      );
    const start = (query.page - 1) * query.pageSize;
    const page = rows.slice(start, start + query.pageSize);
    const items = await Promise.all(page.map(async (row) => await this.view(row)));
    return { items, total: rows.length };
  }

  public async detail(id: string): Promise<BomView | undefined> {
    const header = await this.header(id);
    return header === undefined ? undefined : await this.view(header);
  }

  private async view(header: BomHeader): Promise<BomView> {
    const product = await this.item(header.productId);
    if (product === undefined) return fail('product-invalid');
    const lines = await this.lines(header.id);
    const items = await Promise.all(lines.map(async (line) => {
      const item = await this.item(line.itemId);
      if (item === undefined) return fail('item-not-found');
      return item;
    }));
    return {
      id: header.id,
      docNo: header.docNo,
      version: header.version,
      product: {
        id: product.id, code: product.code, name: product.name,
        spec: product.spec, unitCode: product.unitCode,
      },
      isDefault: header.isDefault,
      effectiveFrom: isoDate(header.effectiveFrom),
      effectiveTo: header.effectiveTo === null ? null : isoDate(header.effectiveTo),
      dailyOutput: header.dailyOutput === null ? null : Number(header.dailyOutput),
      status: header.status,
      remark: header.remark,
      createdAt: isoTime(header.createdAt),
      updatedAt: isoTime(header.updatedAt),
      lines: lines.map((line, index) => lineView(line, items[index])),
      files: await this.files(header.id),
    };
  }
}

export class DatabaseBomsMutations implements BomsMutations {
  public constructor(
    private readonly database: DatabaseManager,
    private readonly codes: CodeService,
    private readonly docFiles: DocFiles,
    private readonly reader: BomsReader,
  ) {}

  public async create(
    input: CreateBomInput,
    actorId: string,
  ): Promise<BomView> {
    const id = await this.inTransaction(async (tx) => {
      await this.lock(tx);
      await this.requireProduct(tx, input.productId);
      const from = date(input.effectiveFrom, 'effectiveFrom');
      const to = input.effectiveTo === undefined || input.effectiveTo === null
        ? null
        : date(input.effectiveTo, 'effectiveTo');
      if (to !== null && to < from) return fail('invalid-input', 'effectiveTo');
      const version = text(input.version, 'version', MAX_VERSION_LENGTH);
      const dailyOutput = input.dailyOutput === undefined || input.dailyOutput === null
        ? null
        : nonNegative(input.dailyOutput, 'dailyOutput');
      const remark = input.remark === undefined ? '' : text(input.remark, 'remark', 1000);
      const isDefault = input.isDefault === true;
      const lines = await this.validateLines(tx, input.lines);
      // 先清掉别的默认再插：部分唯一索引不允许两条在用默认同时存在。
      if (isDefault) await this.clearOtherDefaults(tx, input.productId);
      const docNo = await this.codes.nextCode(tx, CODE_PREFIXES.bom);
      const now = new Date();
      const row = await tx.repository<BomHeader>('boms')
        .createOne({
          values: {
            id: randomId(),
            docNo,
            version,
            productId: input.productId,
            isDefault,
            effectiveFrom: from,
            effectiveTo: to,
            dailyOutput,
            status: 'active',
            remark,
            createdById: actorId,
            createdAt: now,
            updatedAt: now,
          },
        })
        .catch((error: unknown) => {
          if (isUniqueConstraintViolation(error)) return fail('version-taken');
          throw error;
        });
      await this.replaceLines(tx, row.record.id, lines);
      if (input.fileIds !== undefined) {
        await this.docFiles.bind(
          await tx.client<Knex>(), 'bom', row.record.id, input.fileIds, actorId,
        );
      }
      return row.record.id;
    });
    return (await this.reader.detail(id)) ?? fail('bom-not-found');
  }

  public async update(
    id: string,
    input: UpdateBomInput,
  ): Promise<BomView> {
    await this.inTransaction(async (tx) => {
      await this.lock(tx);
      const current = await this.reader.header(id);
      if (current === undefined) return fail('bom-not-found');
      const from = input.effectiveFrom === undefined
        ? isoDate(current.effectiveFrom)
        : date(input.effectiveFrom, 'effectiveFrom');
      const to = input.effectiveTo === undefined
        ? (current.effectiveTo === null ? null : isoDate(current.effectiveTo))
        : (input.effectiveTo === null ? null : date(input.effectiveTo, 'effectiveTo'));
      if (to !== null && to < from) return fail('invalid-input', 'effectiveTo');
      const status = input.status ?? current.status;
      if (status !== 'active' && status !== 'inactive') {
        return fail('invalid-input', 'status');
      }
      // 成品不可改：PATCH 的 schema 也不收 productId。
      const productId = current.productId;
      await this.requireProduct(tx, productId);
      const version = input.version === undefined
        ? current.version
        : text(input.version, 'version', MAX_VERSION_LENGTH);
      const dailyOutput = input.dailyOutput === undefined
        ? (current.dailyOutput === null ? null : Number(current.dailyOutput))
        : (input.dailyOutput === null ? null : nonNegative(input.dailyOutput, 'dailyOutput'));
      const remark = input.remark === undefined
        ? current.remark
        : text(input.remark, 'remark', 1000);
      const isDefault = input.isDefault ?? current.isDefault;
      const lines = input.lines === undefined
        ? undefined
        : await this.validateLines(tx, input.lines, id);

      // 与建单同理：先让别的默认失效，再写自己，避免撞部分唯一索引。
      if (isDefault && status === 'active') {
        await this.clearOtherDefaults(tx, productId, id);
      }
      await tx.repository<BomHeader>('boms')
        .updateOne({
          filter: { id },
          values: {
            version,
            effectiveFrom: from,
            effectiveTo: to,
            dailyOutput,
            status,
            remark,
            isDefault,
            updatedAt: new Date(),
          },
        })
        .catch((error: unknown) => {
          if (isUniqueConstraintViolation(error)) return fail('version-taken');
          throw error;
        });
      if (lines !== undefined) await this.replaceLines(tx, id, lines);
      const actorId = String(current.createdById);
      if (input.fileIds !== undefined) {
        await this.docFiles.bind(
          await tx.client<Knex>(), 'bom', id, input.fileIds, actorId,
        );
      }
    });
    return (await this.reader.detail(id)) ?? fail('bom-not-found');
  }

  public async void(id: string): Promise<BomView> {
    await this.inTransaction(async (tx) => {
      await this.lock(tx);
      const current = await this.reader.header(id);
      if (current === undefined) return fail('bom-not-found');
      await tx.repository<BomHeader>('boms').updateOne({
        filter: { id },
        values: { status: 'inactive', updatedAt: new Date() },
      });
    });
    return (await this.reader.detail(id)) ?? fail('bom-not-found');
  }

  private async inTransaction<T>(work: (tx: DatabaseConnection) => Promise<T>): Promise<T> {
    return await this.database.transaction(work);
  }

  /** 默认位切换串行化；锁随事务释放，部分唯一索引兜底。 */
  private async lock(tx: DatabaseConnection): Promise<void> {
    if (tx.dialect !== 'postgres') return;
    const knex = await tx.client<Knex>();
    await knex.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [WRITE_LOCK_KEY]);
  }

  private async requireProduct(
    tx: DatabaseConnection,
    id: string,
  ): Promise<void> {
    const row = await tx.repository<BomItem>('items').findOne({ filter: { id } });
    if (row === undefined || row.itemType !== 'product' || row.status !== 'active') {
      return fail('product-invalid');
    }
  }

  private async validateLines(
    tx: DatabaseConnection,
    lines: readonly BomLineInput[],
    ownerId?: string,
  ): Promise<readonly BomLineInput[]> {
    const seen = new Set<string>();
    for (const line of lines) {
      const itemId = text(line.itemId, 'itemId', 64);
      if (seen.has(itemId)) return fail('line-duplicated', itemId);
      seen.add(itemId);
      quantity(line.qty, 'qty');
      if (line.lossRate !== undefined) rate(line.lossRate, 'lossRate');
      if (line.note !== undefined && line.note !== null) {
        text(line.note, 'note', 500);
      }
      const item = await tx.repository<BomItem>('items')
        .findOne({ filter: { id: itemId } });
      if (item === undefined || item.status !== 'active') {
        return fail('item-not-found', itemId);
      }
      if (line.childBomId !== undefined && line.childBomId !== null) {
        const child = await tx.repository<BomHeader>('boms')
          .findOne({ filter: { id: line.childBomId } });
        if (child === undefined) return fail('bom-not-found', line.childBomId);
        if (child.status !== 'active') return fail('bom-inactive', line.childBomId);
        await this.assertNoCycle(line.childBomId, ownerId, new Set<string>());
      }
    }
    return lines;
  }

  /**
   * 从新挂的子 BOM 对所有 childBomId 做深度优先：一张 BOM 可以有多条子链接，
   * 只看第一条会漏掉「指向自己的那行排在后面」的环。任一条路径走回 ownerId 就是环；
   * seen 跨分支共享，已走过的节点不会再通向 ownerId，也顺带挡住库里已有的环。
   */
  private async assertNoCycle(
    cursor: string,
    ownerId: string | undefined,
    seen: Set<string>,
  ): Promise<void> {
    const walk = async (id: string, depth: number): Promise<void> => {
      if (id === ownerId) return fail('cycle', id);
      if (depth > MAX_CHAIN_DEPTH) return fail('invalid-input', 'depth');
      if (seen.has(id)) return;
      seen.add(id);
      const header = await this.reader.header(id);
      if (header === undefined) return fail('bom-not-found', id);
      const lines = await this.reader.lines(header.id);
      for (const line of lines) {
        if (line.childBomId !== null && line.childBomId !== '') {
          await walk(line.childBomId, depth + 1);
        }
      }
    };
    await walk(cursor, 1);
  }

  private async clearOtherDefaults(
    tx: DatabaseConnection,
    productId: string,
    keepId?: string,
  ): Promise<void> {
    // 逐行按主键清，$ne 这类简写在 v3 上不稳；锁内重读，部分唯一索引兜底并发。
    const rows = await tx.repository<BomHeader>('boms').findMany({
      filter: { productId, status: 'active', isDefault: true },
    });
    for (const row of rows) {
      if (row.id === keepId) continue;
      await tx.repository<BomHeader>('boms').updateOne({
        filter: { id: row.id },
        values: { isDefault: false, updatedAt: new Date() },
      });
    }
  }

  private async replaceLines(
    tx: DatabaseConnection,
    bomId: string,
    lines: readonly BomLineInput[],
  ): Promise<void> {
    const knex = await tx.client<Knex>();
    await knex('bom_lines').where({ bom_id: bomId }).delete();
    for (const [index, line] of lines.entries()) {
      await knex('bom_lines').insert({
        id: randomId(),
        bom_id: bomId,
        line_no: index + 1,
        item_id: line.itemId,
        qty: line.qty,
        loss_rate: line.lossRate ?? 0,
        child_bom_id: line.childBomId ?? null,
        note: line.note ?? null,
      });
    }
  }
}

/** UUID v4，不引入新依赖；业务编码由发号服务给。 */
function randomId(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0'));
  return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10, 12).join('')}`;
}

export const bomsReaderToken: ServiceToken<BomsReader> =
  createServiceToken<BomsReader>('app/boms-reader');
export const bomsMutationsToken: ServiceToken<BomsMutations> =
  createServiceToken<BomsMutations>('app/boms-mutations');

export default class BomsProvider extends ServiceProvider<Application> {
  public readonly name: string = 'app.boms';

  public override register(): void {
    this.app.container.singleton(bomsReaderToken, () => {
      const database = this.app.container.resolve(databaseManagerToken);
      const docFiles = this.app.container.resolve(docFilesToken);
      return new DatabaseBomsReader(database, docFiles);
    });
    this.app.container.singleton(bomsMutationsToken, () => {
      const database = this.app.container.resolve(databaseManagerToken);
      const codes = this.app.container.resolve(codeServiceToken);
      const docFiles = this.app.container.resolve(docFilesToken);
      const reader = this.app.container.resolve(bomsReaderToken);
      return new DatabaseBomsMutations(database, codes, docFiles, reader);
    });
  }
}
