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

/**
 * R-019 MVP：物料、计量单位、物料分类的读服务与写服务。
 *
 * 读服务经 HTTP 读端点用，返回副本；写服务把校验、咨询锁与事务放在一起：
 * - 建、改都在事务开头取固定键的 `pg_advisory_xact_lock`，锁内重读引用的单位与
 *   分类，再写入。停用单位前也取同一把锁、重查引用，避免并发建物料绕过检查。
 * - 物料编码由 R-016 的发号服务在业务事务内领：物料 `CODE_PREFIXES.item`（M），
 *   产品 `CODE_PREFIXES.product`（P）。回滚即归还；唯一约束再兜一层。
 * - 编码与 id 不可改：写服务根本没有收它们的入参，端点还会拒掉请求体里的 `code`。
 *
 * 不提供删除。停用代替，且单位被引用时不许停用。
 */
const STRUCTURE_LOCK_KEY = 'hs-erp:items:structure';

export type ItemRuleCode =
  | 'invalid-input'
  | 'item-not-found'
  | 'unit-not-found'
  | 'category-not-found'
  | 'code-taken'
  | 'unit-code-taken'
  | 'category-code-taken'
  | 'item-code-immutable'
  | 'empty-patch'
  | 'unit-in-use'
  | 'unit-inactive'
  | 'category-inactive'
  | 'item-inactive'
  | 'invalid-parent'
  | 'limit-invalid'
  | 'aux-unit-invalid'
  | 'number-invalid'
  | 'category-too-deep';

export class ItemRuleError extends Error {
  public constructor(
    readonly code: ItemRuleCode,
    readonly detail?: string,
  ) {
    super(detail ?? `Item rule violated: ${code}`);
    this.name = 'ItemRuleError';
  }
}

function fail(code: ItemRuleCode, detail?: string): never {
  throw new ItemRuleError(code, detail);
}

export interface ItemRecord {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly spec: string | null;
  readonly itemType: string;
  readonly categoryCode: string | null;
  readonly unitCode: string;
  readonly status: string;
  readonly legacyCode: string | null;
  readonly note: string | null;
  readonly createdById: string;
  readonly createdAt: string | Date;
  readonly updatedAt: string | Date;
  // 复刻波 0 加片。decimal 在 Postgres 里读回来可能是字符串，viewItem 统一转成 number。
  readonly englishName: string | null;
  readonly stockMin: number | null;
  readonly stockMax: number | null;
  readonly basePurchasePrice: number | null;
  readonly baseSalesPrice: number | null;
  readonly barcode: string | null;
  readonly brand: string | null;
  readonly manufacturerModel: string | null;
  readonly auxUnitCode: string | null;
  readonly unitRatio: number | null;
  readonly purchaseLeadDays: number | null;
  /** R-070：来料必检开关，默认关；只记录，不拦没有检验单的入库。 */
  readonly inspectionRequired: boolean;
}

export interface UnitRecord {
  readonly code: string;
  readonly name: string;
  readonly decimals: number;
  readonly status: string;
  readonly createdAt: string | Date;
  readonly updatedAt: string | Date;
}

export interface CategoryRecord {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly parentId: string | null;
  readonly status: string;
  readonly createdAt: string | Date;
  readonly updatedAt: string | Date;
  readonly sort: number;
  /** 从根到它自己；读的时候沿 parentId 算，不落库。 */
  readonly path?: readonly { readonly code: string; readonly name: string }[];
}

export interface DictionaryQuery {
  readonly page: number;
  readonly pageSize: number;
  readonly q?: string;
  readonly status?: string;
  /** `root` 取顶层；其它值精确匹配父 id。 */
  readonly parentId?: string;
}

export interface ItemQuery extends DictionaryQuery {
  readonly itemType?: string;
  readonly categoryCode?: string;
  readonly brand?: string;
  readonly includeSubcategories?: boolean;
}

interface Page<T> {
  readonly items: readonly T[];
  readonly total: number;
}

export interface CreateItemInput {
  readonly name: string;
  readonly itemType: string;
  readonly spec?: string | null;
  readonly categoryCode?: string | null;
  readonly unitCode: string;
  readonly legacyCode?: string | null;
  readonly note?: string | null;
  readonly englishName?: string | null;
  readonly stockMin?: number | null;
  readonly stockMax?: number | null;
  readonly basePurchasePrice?: number | null;
  readonly baseSalesPrice?: number | null;
  readonly barcode?: string | null;
  readonly brand?: string | null;
  readonly manufacturerModel?: string | null;
  readonly auxUnitCode?: string | null;
  readonly unitRatio?: number | null;
  readonly purchaseLeadDays?: number | null;
}

export interface UpdateItemInput {
  readonly name?: string;
  readonly spec?: string | null;
  readonly itemType?: string;
  readonly categoryCode?: string | null;
  readonly unitCode?: string;
  readonly status?: string;
  readonly legacyCode?: string | null;
  readonly note?: string | null;
  readonly englishName?: string | null;
  readonly stockMin?: number | null;
  readonly stockMax?: number | null;
  readonly basePurchasePrice?: number | null;
  readonly baseSalesPrice?: number | null;
  readonly barcode?: string | null;
  readonly brand?: string | null;
  readonly manufacturerModel?: string | null;
  readonly auxUnitCode?: string | null;
  readonly unitRatio?: number | null;
  readonly purchaseLeadDays?: number | null;
}

export interface CreateUnitInput {
  readonly code: string;
  readonly name: string;
  readonly decimals?: number;
}

export interface UpdateUnitInput {
  readonly name?: string;
  readonly decimals?: number;
  readonly status?: string;
}

export interface CreateCategoryInput {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly parentId?: string | null;
  readonly sort?: number;
}

export interface UpdateCategoryInput {
  readonly name?: string;
  readonly parentId?: string | null;
  readonly status?: string;
  readonly sort?: number;
}

export interface ItemsReader {
  list(query: ItemQuery): Promise<Page<ItemRecord>>;
  detail(id: string): Promise<ItemRecord | undefined>;
  listUnits(query: DictionaryQuery): Promise<Page<UnitRecord>>;
  unitDetail(code: string): Promise<UnitRecord | undefined>;
  listCategories(query: DictionaryQuery): Promise<Page<CategoryRecord>>;
  categoryDetail(id: string): Promise<CategoryRecord | undefined>;
}

export interface ItemsMutations {
  create(
    input: CreateItemInput,
    actorId: string,
    transaction?: DatabaseConnection,
  ): Promise<ItemRecord>;
  update(
    id: string,
    input: UpdateItemInput,
    transaction?: DatabaseConnection,
  ): Promise<ItemRecord>;
  createUnit(input: CreateUnitInput): Promise<UnitRecord>;
  updateUnit(code: string, input: UpdateUnitInput): Promise<UnitRecord>;
  createCategory(input: CreateCategoryInput): Promise<CategoryRecord>;
  updateCategory(id: string, input: UpdateCategoryInput): Promise<CategoryRecord>;
}

const iso = (value: string | Date): string =>
  value instanceof Date ? value.toISOString() : String(value);

const nullableText = (value: string | null | undefined): string | null => {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? null : trimmed;
};

const numberOrNull = (value: number | string | null | undefined): number | null =>
  value === undefined || value === null ? null : Number(value);

function viewItem(row: ItemRecord): ItemRecord {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    spec: row.spec ?? null,
    itemType: row.itemType,
    categoryCode: row.categoryCode ?? null,
    unitCode: row.unitCode,
    status: row.status,
    legacyCode: row.legacyCode ?? null,
    note: row.note ?? null,
    createdById: row.createdById,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
    englishName: row.englishName ?? null,
    stockMin: numberOrNull(row.stockMin),
    stockMax: numberOrNull(row.stockMax),
    basePurchasePrice: numberOrNull(row.basePurchasePrice),
    baseSalesPrice: numberOrNull(row.baseSalesPrice),
    barcode: row.barcode ?? null,
    brand: row.brand ?? null,
    manufacturerModel: row.manufacturerModel ?? null,
    auxUnitCode: row.auxUnitCode ?? null,
    unitRatio: numberOrNull(row.unitRatio),
    purchaseLeadDays: numberOrNull(row.purchaseLeadDays),
    inspectionRequired: Boolean(row.inspectionRequired),
  };
}

function viewUnit(row: UnitRecord): UnitRecord {
  return {
    code: row.code,
    name: row.name,
    decimals: Number(row.decimals),
    status: row.status,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

/** 从根到它自己；沿 parentId 往上取，缺父或成环就停，不让坏数据卡住读端点。 */
function categoryPath(
  row: CategoryRecord,
  byId: ReadonlyMap<string, CategoryRecord>,
): readonly { readonly code: string; readonly name: string }[] {
  const path: { code: string; name: string }[] = [];
  const seen = new Set<string>();
  let cursor: CategoryRecord | undefined = row;
  while (cursor !== undefined && !seen.has(cursor.id)) {
    seen.add(cursor.id);
    path.unshift({ code: cursor.code, name: cursor.name });
    if (cursor.parentId === null || cursor.parentId === '') break;
    cursor = byId.get(cursor.parentId);
  }
  return path;
}

function viewCategory(
  row: CategoryRecord,
  all: readonly CategoryRecord[],
): CategoryRecord {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    parentId: row.parentId ?? null,
    status: row.status,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
    sort: Number(row.sort ?? 0),
    path: categoryPath(row, new Map(all.map((entry) => [entry.id, entry]))),
  };
}

/** 状态与类型只认字面量；这不是人员信息，也不查其它角色的授权。 */
const STATUSES = ['active', 'inactive'] as const;
const ITEM_TYPES = ['material', 'product'] as const;

function status(value: string | undefined, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (!(STATUSES as readonly string[]).includes(value)) {
    return fail('invalid-input', field);
  }
  return value;
}

function itemType(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!(ITEM_TYPES as readonly string[]).includes(value)) {
    return fail('invalid-input', 'itemType');
  }
  return value;
}

function text(
  value: string | undefined,
  field: string,
  max: number,
  required = false,
): string | undefined {
  if (value === undefined) {
    if (required) return fail('invalid-input', field);
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > max) {
    return fail('invalid-input', field);
  }
  return trimmed;
}

function unitCode(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return text(value, 'unitCode', 16, true);
}

function categoryCode(value: string | null | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return text(value, 'categoryCode', 32, true) ?? null;
}

/* 复刻波 0 加片的服务层校验。越界一律抛规则码，由端点映射成 422。 */
type NumberInput = number | string | null | undefined;

const numeric = (value: NumberInput): number | null =>
  value === undefined || value === null ? null : Number(value);

function nonNegative(
  value: NumberInput,
  code: ItemRuleCode,
  field: string,
): number | null {
  const parsed = numeric(value);
  if (parsed !== null && (!Number.isFinite(parsed) || parsed < 0)) {
    return fail(code, field);
  }
  return parsed;
}

/** 上下限都为负或下限大于上限：ITEM_LIMIT_INVALID。 */
function stockLimits(
  min: NumberInput,
  max: NumberInput,
): { readonly stockMin: number | null; readonly stockMax: number | null } {
  const stockMin = nonNegative(min, 'limit-invalid', 'stockMin');
  const stockMax = nonNegative(max, 'limit-invalid', 'stockMax');
  if (stockMin !== null && stockMax !== null && stockMin > stockMax) {
    return fail('limit-invalid', 'stockMin>stockMax');
  }
  return { stockMin, stockMax };
}

function leadDays(value: NumberInput): number | null {
  const parsed = numeric(value);
  if (
    parsed !== null &&
    (!Number.isInteger(parsed) || parsed < 0 || parsed > 3650)
  ) {
    return fail('number-invalid', 'purchaseLeadDays');
  }
  return parsed;
}

function unitRatioValue(value: NumberInput): number | null {
  const parsed = numeric(value);
  if (parsed !== null && (!Number.isFinite(parsed) || parsed <= 0)) {
    return fail('aux-unit-invalid', 'unitRatio');
  }
  return parsed;
}

/** 辅助单位与换算率要么都给、要么都不给（null 表示清空）。 */
function assertAuxPair(
  auxUnitCode: string | null,
  unitRatio: number | null,
): void {
  if ((auxUnitCode !== null) !== (unitRatio !== null)) {
    fail('aux-unit-invalid', 'auxUnitCode/unitRatio');
  }
}

function extText(
  value: string | null | undefined,
  field: string,
  max: number,
): string | null {
  if (value === undefined || value === null) return null;
  return text(value, field, max) ?? null;
}

function pageOf<T>(
  rows: readonly T[],
  query: DictionaryQuery,
): Page<T> {
  const start = (query.page - 1) * query.pageSize;
  return { items: rows.slice(start, start + query.pageSize), total: rows.length };
}

function matches(row: Record<string, unknown>, q: string | undefined): boolean {
  if (q === undefined) return true;
  return ['code', 'name', 'spec', 'legacyCode'].some((field) => {
    const value = row[field];
    return typeof value === 'string' && value.toLowerCase().includes(q.toLowerCase());
  });
}

export class DatabaseItemsReader implements ItemsReader {
  public constructor(private readonly database: DatabaseManager) {}

  public async list(query: ItemQuery): Promise<Page<ItemRecord>> {
    const rows = await this.database.repository<ItemRecord>('items').findMany();
    // includeSubcategories=1 时先把根类目的子孙码展开；不传时仍精确匹配。
    let categoryCodes: readonly string[] | undefined;
    if (query.categoryCode !== undefined && query.includeSubcategories === true) {
      categoryCodes = await this.subtreeCodes(query.categoryCode);
    }
    const selected = rows.filter(
      (row) =>
        (query.status === undefined || row.status === query.status) &&
        (query.itemType === undefined || row.itemType === query.itemType) &&
        (query.categoryCode === undefined ||
          (categoryCodes === undefined
            ? row.categoryCode === query.categoryCode
            : categoryCodes.includes(row.categoryCode ?? ''))) &&
        (query.brand === undefined || row.brand === query.brand) &&
        matches(row as unknown as Record<string, unknown>, query.q),
    );
    selected.sort((left, right) =>
      left.code < right.code ? -1 : left.code > right.code ? 1 : 0,
    );
    const result = pageOf(selected, query);
    return { ...result, items: result.items.map(viewItem) };
  }

  public async detail(id: string): Promise<ItemRecord | undefined> {
    const row = await this.database
      .repository<ItemRecord>('items')
      .findOne({ filter: { id } });
    return row === undefined ? undefined : viewItem(row);
  }

  public async listUnits(query: DictionaryQuery): Promise<Page<UnitRecord>> {
    const rows = await this.database.repository<UnitRecord>('units').findMany();
    const selected = rows.filter(
      (row) =>
        (query.status === undefined || row.status === query.status) &&
        matches(row as unknown as Record<string, unknown>, query.q),
    );
    selected.sort((left, right) =>
      left.code < right.code ? -1 : left.code > right.code ? 1 : 0,
    );
    const result = pageOf(selected, query);
    return { ...result, items: result.items.map(viewUnit) };
  }

  public async unitDetail(code: string): Promise<UnitRecord | undefined> {
    const row = await this.database
      .repository<UnitRecord>('units')
      .findOne({ filter: { code } });
    return row === undefined ? undefined : viewUnit(row);
  }

  public async listCategories(
    query: DictionaryQuery,
  ): Promise<Page<CategoryRecord>> {
    const rows = await this.database
      .repository<CategoryRecord>('itemCategories')
      .findMany();
    const selected = rows.filter(
      (row) =>
        (query.status === undefined || row.status === query.status) &&
        (query.parentId === undefined ||
          (query.parentId === 'root'
            ? row.parentId === null || row.parentId === ''
            : row.parentId === query.parentId)) &&
        matches(row as unknown as Record<string, unknown>, query.q),
    );
    selected.sort((left, right) =>
      left.code < right.code ? -1 : left.code > right.code ? 1 : 0,
    );
    const result = pageOf(selected, query);
    return {
      ...result,
      items: result.items.map((row) => viewCategory(row, rows)),
    };
  }

  public async categoryDetail(id: string): Promise<CategoryRecord | undefined> {
    const rows = await this.database
      .repository<CategoryRecord>('itemCategories')
      .findMany();
    const row = rows.find((entry) => entry.id === id);
    return row === undefined ? undefined : viewCategory(row, rows);
  }

  /** 根类目加全部子孙的 code；母子关系沿 parentId 读，坏链与环都不无限跑。 */
  private async subtreeCodes(code: string): Promise<readonly string[]> {
    const rows = await this.database
      .repository<CategoryRecord>('itemCategories')
      .findMany();
    const root = rows.find((entry) => entry.code === code);
    if (root === undefined) return [code];
    const byParent = new Map<string, CategoryRecord[]>();
    for (const row of rows) {
      const parent = row.parentId ?? '';
      byParent.set(parent, [...(byParent.get(parent) ?? []), row]);
    }
    const codes: string[] = [];
    const queue = [root];
    const seen = new Set<string>();
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (seen.has(current.id)) continue;
      seen.add(current.id);
      codes.push(current.code);
      for (const child of byParent.get(current.id) ?? []) queue.push(child);
    }
    return codes;
  }
}

export class DatabaseItemsMutations implements ItemsMutations {
  public constructor(
    private readonly database: DatabaseManager,
    private readonly codes: CodeService,
  ) {}

  public async create(
    input: CreateItemInput,
    actorId: string,
    transaction?: DatabaseConnection,
  ): Promise<ItemRecord> {
    return await this.inTransaction(transaction, async (tx) => {
      await this.lockStructure(tx);
      const name = text(input.name, 'name', 128, true)!;
      const type = itemType(input.itemType)!;
      const basicUnit = unitCode(input.unitCode)!;
      await this.requireUnit(tx, basicUnit);
      const { stockMin, stockMax } = stockLimits(input.stockMin, input.stockMax);
      const basePurchasePrice = nonNegative(
        input.basePurchasePrice,
        'number-invalid',
        'basePurchasePrice',
      );
      const baseSalesPrice = nonNegative(
        input.baseSalesPrice,
        'number-invalid',
        'baseSalesPrice',
      );
      const purchaseLeadDays = leadDays(input.purchaseLeadDays);
      const ratio = unitRatioValue(input.unitRatio);
      const auxUnitCode = input.auxUnitCode ?? null;
      assertAuxPair(auxUnitCode, ratio);
      if (auxUnitCode !== null) {
        await this.requireAuxUnit(tx, auxUnitCode, basicUnit);
      }
      const category = categoryCode(input.categoryCode);
      if (category !== null && category !== undefined) {
        await this.requireCategory(tx, category);
      }
      const code = await this.codes.nextCode(
        tx,
        type === 'product' ? CODE_PREFIXES.product : CODE_PREFIXES.item,
      );
      const now = new Date();
      const row = await tx
        .repository<ItemRecord>('items')
        .createOne({
          values: {
            id: randomId(),
            code,
            name,
            spec: nullableText(input.spec),
            itemType: type,
            categoryCode: category ?? null,
            unitCode: basicUnit,
            status: 'active',
            legacyCode: nullableText(input.legacyCode),
            note: nullableText(input.note),
            englishName: extText(input.englishName, 'englishName', 128),
            stockMin,
            stockMax,
            basePurchasePrice,
            baseSalesPrice,
            barcode: extText(input.barcode, 'barcode', 64),
            brand: extText(input.brand, 'brand', 64),
            manufacturerModel: extText(input.manufacturerModel, 'manufacturerModel', 128),
            auxUnitCode,
            unitRatio: ratio,
            purchaseLeadDays,
            createdById: actorId,
            createdAt: now,
            updatedAt: now,
          },
        })
        .catch((error: unknown) => {
          if (isUniqueConstraintViolation(error)) return fail('code-taken');
          throw error;
        });
      return viewItem(row.record);
    });
  }

  public async update(
    id: string,
    input: UpdateItemInput,
    transaction?: DatabaseConnection,
  ): Promise<ItemRecord> {
    return await this.inTransaction(transaction, async (tx) => {
      await this.lockStructure(tx);
      const current = await this.requireItem(tx, id);
      if (current.status === 'inactive' && input.status !== 'active') {
        return fail('item-inactive');
      }
      const basicUnit = input.unitCode === undefined
        ? current.unitCode
        : unitCode(input.unitCode)!;
      if (input.unitCode !== undefined) await this.requireUnit(tx, basicUnit);
      if (input.categoryCode !== undefined && input.categoryCode !== null) {
        await this.requireCategory(tx, input.categoryCode);
      }
      const merged = (patch: NumberInput, value: number | null): number | null =>
        patch === undefined ? value : patch === null ? null : Number(patch);
      const limits = stockLimits(
        merged(input.stockMin, current.stockMin),
        merged(input.stockMax, current.stockMax),
      );
      const purchasePrice = nonNegative(
        merged(input.basePurchasePrice, current.basePurchasePrice),
        'number-invalid',
        'basePurchasePrice',
      );
      const salesPrice = nonNegative(
        merged(input.baseSalesPrice, current.baseSalesPrice),
        'number-invalid',
        'baseSalesPrice',
      );
      const lead = leadDays(merged(input.purchaseLeadDays, current.purchaseLeadDays));
      const ratio = unitRatioValue(merged(input.unitRatio, current.unitRatio));
      const auxUnitCode = input.auxUnitCode === undefined
        ? current.auxUnitCode ?? null
        : input.auxUnitCode;
      assertAuxPair(auxUnitCode, ratio);
      if (auxUnitCode !== null) {
        await this.requireAuxUnit(tx, auxUnitCode, basicUnit);
      }
      const nextStatus = status(input.status, 'status');
      const { record } = await tx
        .repository<ItemRecord>('items')
        .updateOne({
          filter: { id },
          values: {
            ...(input.name === undefined
              ? {}
              : { name: text(input.name, 'name', 128, true)! }),
            ...(input.spec === undefined ? {} : { spec: nullableText(input.spec) }),
            ...(input.itemType === undefined ? {} : { itemType: itemType(input.itemType)! }),
            ...(input.categoryCode === undefined
              ? {}
              : { categoryCode: categoryCode(input.categoryCode) ?? null }),
            ...(input.unitCode === undefined ? {} : { unitCode: basicUnit }),
            ...(nextStatus === undefined ? {} : { status: nextStatus }),
            ...(input.legacyCode === undefined
              ? {}
              : { legacyCode: nullableText(input.legacyCode) }),
            ...(input.note === undefined ? {} : { note: nullableText(input.note) }),
            ...(input.englishName === undefined
              ? {}
              : { englishName: extText(input.englishName, 'englishName', 128) }),
            ...(input.stockMin === undefined ? {} : { stockMin: limits.stockMin }),
            ...(input.stockMax === undefined ? {} : { stockMax: limits.stockMax }),
            ...(input.basePurchasePrice === undefined
              ? {}
              : { basePurchasePrice: purchasePrice }),
            ...(input.baseSalesPrice === undefined
              ? {}
              : { baseSalesPrice: salesPrice }),
            ...(input.barcode === undefined
              ? {}
              : { barcode: extText(input.barcode, 'barcode', 64) }),
            ...(input.brand === undefined
              ? {}
              : { brand: extText(input.brand, 'brand', 64) }),
            ...(input.manufacturerModel === undefined
              ? {}
              : { manufacturerModel: extText(input.manufacturerModel, 'manufacturerModel', 128) }),
            ...(input.auxUnitCode === undefined ? {} : { auxUnitCode }),
            ...(input.unitRatio === undefined ? {} : { unitRatio: ratio }),
            ...(input.purchaseLeadDays === undefined
              ? {}
              : { purchaseLeadDays: lead }),
            updatedAt: new Date(),
          },
        });
      return viewItem(record);
    });
  }

  public async createUnit(input: CreateUnitInput): Promise<UnitRecord> {
    return await this.inTransaction(undefined, async (tx) => {
      await this.lockStructure(tx);
      const code = text(input.code, 'code', 16, true)!;
      const name = text(input.name, 'name', 64, true)!;
      const decimals = input.decimals ?? 0;
      if (!Number.isInteger(decimals) || decimals < 0 || decimals > 10) {
        return fail('invalid-input', 'decimals');
      }
      const now = new Date();
      const row = await tx
        .repository<UnitRecord>('units')
        .createOne({
          values: { code, name, decimals, status: 'active', createdAt: now, updatedAt: now },
        })
        .catch((error: unknown) => {
          if (isUniqueConstraintViolation(error)) return fail('unit-code-taken');
          throw error;
        });
      return viewUnit(row.record);
    });
  }

  public async updateUnit(
    code: string,
    input: UpdateUnitInput,
  ): Promise<UnitRecord> {
    return await this.inTransaction(undefined, async (tx) => {
      await this.lockStructure(tx);
      const current = await this.requireUnit(tx, code);
      const nextStatus = status(input.status, 'status');
      if (
        nextStatus === 'inactive' &&
        (await this.itemCountByUnit(tx, code)) > 0
      ) {
        return fail('unit-in-use');
      }
      const decimals = input.decimals;
      if (
        decimals !== undefined &&
        (!Number.isInteger(decimals) || decimals < 0 || decimals > 10)
      ) {
        return fail('invalid-input', 'decimals');
      }
      if (
        input.name === undefined &&
        decimals === undefined &&
        nextStatus === undefined
      ) {
        return fail('empty-patch');
      }
      const { record } = await tx
        .repository<UnitRecord>('units')
        .updateOne({
          filter: { code },
          values: {
            ...(input.name === undefined ? {} : { name: text(input.name, 'name', 64, true)! }),
            ...(decimals === undefined ? {} : { decimals }),
            ...(nextStatus === undefined ? {} : { status: nextStatus }),
            updatedAt: new Date(),
          },
        });
      // 并发里另一条物料可能刚引用了它：提交前再查一次，引用数不为零就不让停用。
      if (nextStatus === 'inactive' && (await this.itemCountByUnit(tx, code)) > 0) {
        return fail('unit-in-use');
      }
      return viewUnit({ ...record, status: nextStatus ?? current.status });
    });
  }

  public async createCategory(
    input: CreateCategoryInput,
  ): Promise<CategoryRecord> {
    return await this.inTransaction(undefined, async (tx) => {
      await this.lockStructure(tx);
      const id = text(input.id, 'id', 64, true)!;
      const code = text(input.code, 'code', 32, true)!;
      const name = text(input.name, 'name', 64, true)!;
      const parentId = nullableText(input.parentId);
      if (parentId !== null && parentId === id) {
        return fail('invalid-parent');
      }
      if (parentId !== null) await this.checkCategoryDepth(tx, parentId, id);
      const sort = input.sort ?? 0;
      const now = new Date();
      const row = await tx
        .repository<CategoryRecord>('itemCategories')
        .createOne({
          values: { id, code, name, parentId, sort, status: 'active', createdAt: now, updatedAt: now },
        })
        .catch((error: unknown) => {
          if (isUniqueConstraintViolation(error)) return fail('category-code-taken');
          throw error;
        });
      const all = await tx
        .repository<CategoryRecord>('itemCategories')
        .findMany();
      return viewCategory(row.record, all);
    });
  }

  public async updateCategory(
    id: string,
    input: UpdateCategoryInput,
  ): Promise<CategoryRecord> {
    return await this.inTransaction(undefined, async (tx) => {
      await this.lockStructure(tx);
      await this.requireCategoryById(tx, id);
      const parentId =
        input.parentId === undefined ? undefined : nullableText(input.parentId);
      if (parentId === id) {
        return fail('invalid-parent');
      }
      if (parentId !== undefined && parentId !== null) {
        await this.checkCategoryDepth(tx, parentId, id);
      }
      const nextStatus = status(input.status, 'status');
      const sort = input.sort ?? 0;
      if (
        input.name === undefined &&
        parentId === undefined &&
        nextStatus === undefined &&
        input.sort === undefined
      ) {
        return fail('empty-patch');
      }
      const { record } = await tx
        .repository<CategoryRecord>('itemCategories')
        .updateOne({
          filter: { id },
          values: {
            ...(input.name === undefined ? {} : { name: text(input.name, 'name', 64, true)! }),
            ...(parentId === undefined ? {} : { parentId }),
            ...(nextStatus === undefined ? {} : { status: nextStatus }),
            ...(input.sort === undefined ? {} : { sort }),
            updatedAt: new Date(),
          },
        });
      const all = await tx
        .repository<CategoryRecord>('itemCategories')
        .findMany();
      return viewCategory(record, all);
    });
  }

  private async inTransaction<T>(
    transaction: DatabaseConnection | undefined,
    work: (tx: DatabaseConnection) => Promise<T>,
  ): Promise<T> {
    if (transaction !== undefined) return await work(transaction);
    return await this.database.transaction(work);
  }

  /** 结构变更串行化；锁随事务结束释放。读端点不取锁。 */
  private async lockStructure(tx: DatabaseConnection): Promise<void> {
    if (tx.dialect !== 'postgres') return;
    const knex = await tx.client<Knex>();
    await knex.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [
      STRUCTURE_LOCK_KEY,
    ]);
  }

  private async requireItem(
    tx: DatabaseConnection,
    id: string,
  ): Promise<ItemRecord> {
    const row = await tx.repository<ItemRecord>('items').findOne({ filter: { id } });
    if (row === undefined) return fail('item-not-found');
    return row;
  }

  private async requireUnit(
    tx: DatabaseConnection,
    code: string,
  ): Promise<UnitRecord> {
    const row = await tx.repository<UnitRecord>('units').findOne({ filter: { code } });
    if (row === undefined) return fail('unit-not-found');
    if (row.status !== 'active') return fail('unit-inactive');
    return row;
  }

  private async requireCategoryById(
    tx: DatabaseConnection,
    id: string,
  ): Promise<CategoryRecord> {
    const row = await tx
      .repository<CategoryRecord>('itemCategories')
      .findOne({ filter: { id } });
    if (row === undefined) return fail('category-not-found');
    return row;
  }

  private async requireCategory(
    tx: DatabaseConnection,
    code: string,
  ): Promise<CategoryRecord> {
    const row = await tx
      .repository<CategoryRecord>('itemCategories')
      .findOne({ filter: { code } });
    if (row === undefined) return fail('category-not-found');
    if (row.status !== 'active') return fail('category-inactive');
    return row;
  }

  /** 辅助单位必须在用、不等于基本单位；失败都归 ITEM_AUX_UNIT_INVALID。 */
  private async requireAuxUnit(
    tx: DatabaseConnection,
    code: string,
    basicUnit: string,
  ): Promise<void> {
    if (code === basicUnit) return fail('aux-unit-invalid', 'auxUnitCode=basicUnit');
    const row = await tx.repository<UnitRecord>('units').findOne({ filter: { code } });
    if (row === undefined || row.status !== 'active') {
      return fail('aux-unit-invalid', 'auxUnitCode');
    }
  }

  /**
   * 沿父链查而不是只看直接父：碰到自己或已有环交 CATEGORY_INVALID_PARENT，
   * 父链已经到第三级再往下挂就是第四层，交 CATEGORY_TOO_DEEP。
   */
  private async checkCategoryDepth(
    tx: DatabaseConnection,
    parentId: string,
    selfId: string,
  ): Promise<void> {
    let cursor: string | null = parentId;
    const seen = new Set<string>();
    let depth = 1;
    while (cursor !== null && cursor !== '') {
      if (cursor === selfId || seen.has(cursor)) return fail('invalid-parent');
      seen.add(cursor);
      const parent = await this.requireCategoryById(tx, cursor);
      if (depth >= 3) return fail('category-too-deep');
      cursor = parent.parentId ?? null;
      depth += 1;
    }
  }

  private async itemCountByUnit(
    tx: DatabaseConnection,
    unitCode: string,
  ): Promise<number> {
    return await tx
      .repository<ItemRecord>('items')
      .count({ filter: { unitCode } });
  }
}

/** UUID v4，避免引入新依赖；业务编码由发号服务给。 */
function randomId(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0'));
  return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10, 12).join('')}`;
}

export const itemsReaderToken: ServiceToken<ItemsReader> =
  createServiceToken<ItemsReader>('app/items-reader');
export const itemsMutationsToken: ServiceToken<ItemsMutations> =
  createServiceToken<ItemsMutations>('app/items-mutations');

export default class ItemsProvider extends ServiceProvider<Application> {
  public readonly name: string = 'app.items';

  public override register(): void {
    this.app.container.singleton(itemsReaderToken, () => {
      const database = this.app.container.resolve(databaseManagerToken);
      return new DatabaseItemsReader(database);
    });
    this.app.container.singleton(itemsMutationsToken, () => {
      const database = this.app.container.resolve(databaseManagerToken);
      const codes = this.app.container.resolve(codeServiceToken);
      return new DatabaseItemsMutations(database, codes);
    });
  }
}
