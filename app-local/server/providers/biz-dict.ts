import { randomUUID } from 'node:crypto';

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

/**
 * R-072 业务字典的读服务与写服务，以及给别的模块共用的 `assertActiveCodes`。
 *
 * 一张表装九种类型：name/sort/status 人人有，rate 只归 tax_rate，
 * startDate/endDate/description 只归 project。适用性在服务端校验（设计第 35 行），
 * 不写进数据库约束。单据存码引用，这里只管字典本身，不碰单据。
 */

export const BIZ_DICT_TYPES = [
  'project',
  'settlement',
  'supplier_group',
  'customer_group',
  'income_type',
  'expense_type',
  'invoice_type',
  'tax_rate',
  'fund_account',
] as const;

export type BizDictType = (typeof BIZ_DICT_TYPES)[number];

export const DICT_TYPE_LABEL_KEYS: Readonly<
  Record<BizDictType, string>
> = Object.fromEntries(
  BIZ_DICT_TYPES.map((type) => [type, `bizDict.types.${type}`]),
) as Readonly<Record<BizDictType, string>>;

export interface BizDictEntry {
  readonly id: string;
  readonly dictType: string;
  readonly code: string;
  readonly name: string;
  readonly rate: number | null;
  readonly startDate: string | null;
  readonly endDate: string | null;
  readonly description: string | null;
  readonly isDefault: boolean;
  readonly sort: number;
  readonly status: 'active' | 'inactive';
  readonly createdAt: string;
  readonly updatedAt: string;
  // createdById 是审计列，任何读响应都不回。
}

export interface BizDictCreateInput {
  readonly dictType: string;
  readonly code: string;
  readonly name: string;
  readonly rate?: number;
  readonly startDate?: string;
  readonly endDate?: string;
  readonly description?: string;
  readonly isDefault?: boolean;
  readonly sort?: number;
}

export interface BizDictUpdateInput {
  readonly name?: string;
  readonly rate?: number | null;
  readonly startDate?: string | null;
  readonly endDate?: string | null;
  readonly description?: string | null;
  readonly isDefault?: boolean;
  readonly sort?: number;
  readonly status?: 'active' | 'inactive';
}

export type BizDictRuleCode =
  | 'type-invalid'
  | 'code-taken'
  | 'code-immutable'
  | 'empty-patch'
  | 'field-not-applicable'
  | 'value-invalid'
  | 'code-inactive'
  | 'not-found';

/** 服务层的规则错误；端点按 code 映射到设计里的 `DICT_*` 规则码。 */
export class BizDictRuleError extends Error {
  public constructor(
    readonly code: BizDictRuleCode,
    readonly detail?: string,
  ) {
    super(`Business dictionary rule violated: ${code}`);
    this.name = 'BizDictRuleError';
  }
}

function fail(code: BizDictRuleCode, detail?: string): never {
  throw new BizDictRuleError(code, detail);
}

/** `dictType` 必须落在九个首批类型里。 */
export function assertDictType(dictType: string): BizDictType {
  if (!(BIZ_DICT_TYPES as readonly string[]).includes(dictType)) {
    fail('type-invalid', dictType);
  }
  return dictType as BizDictType;
}

interface ApplicableFields {
  readonly rate?: unknown;
  readonly startDate?: unknown;
  readonly endDate?: unknown;
  readonly description?: unknown;
}

/** 给不适用该字段的类型填值（含 PATCH 传 null 清空）都拒绝。 */
export function assertApplicableFields(
  dictType: BizDictType,
  input: ApplicableFields,
): void {
  const present = (value: unknown): boolean => value !== undefined;
  if (dictType !== 'tax_rate' && present(input.rate)) {
    fail('field-not-applicable', 'rate');
  }
  if (dictType !== 'project') {
    for (const field of ['startDate', 'endDate', 'description'] as const) {
      if (present(input[field])) {
        fail('field-not-applicable', field);
      }
    }
  }
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

function validDate(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    DATE_PATTERN.test(value) &&
    !Number.isNaN(Date.parse(`${value}T00:00:00Z`))
  );
}

interface EntryValues {
  readonly name?: unknown;
  readonly rate?: unknown;
  readonly startDate?: unknown;
  readonly endDate?: unknown;
}

/** 名称非空、税率是 0 到 100 的两位小数、结束日期不早于开始日期。 */
export function assertEntryValues(input: EntryValues): void {
  if (input.name !== undefined) {
    if (typeof input.name !== 'string' || input.name.trim() === '') {
      fail('value-invalid', 'name');
    }
  }
  if (input.rate !== undefined && input.rate !== null) {
    if (
      typeof input.rate !== 'number' ||
      !Number.isFinite(input.rate) ||
      input.rate < 0 ||
      input.rate > 100 ||
      Math.abs(input.rate * 100 - Math.round(input.rate * 100)) > 1e-9
    ) {
      fail('value-invalid', 'rate');
    }
  }
  for (const field of ['startDate', 'endDate'] as const) {
    const value = input[field];
    if (value !== undefined && value !== null && !validDate(value)) {
      fail('value-invalid', field);
    }
  }
  if (
    validDate(input.startDate) &&
    validDate(input.endDate) &&
    input.endDate < input.startDate
  ) {
    fail('value-invalid', 'endDate');
  }
}

/**
 * 给各单据的写服务共用：给定码必须都是该类型里 `active` 的一行。
 * 调用方把 `code-inactive` 映射成自己的 `*_DICT_CODE_INVALID`；不复制校验逻辑。
 */
export async function assertActiveCodes(
  tx: DatabaseConnection,
  dictType: string,
  codes: readonly string[],
): Promise<void> {
  const wanted = [...new Set(codes)];
  if (wanted.length === 0) {
    return;
  }
  const active = await tx
    .repository<BizDictEntry>('bizDictEntries')
    .findMany({ filter: { dictType, status: 'active' } });
  const known = new Set(active.map((entry) => entry.code));
  for (const code of wanted) {
    if (!known.has(code)) {
      fail('code-inactive', code);
    }
  }
}

interface StoredEntry {
  readonly id: string;
  readonly dictType: string;
  readonly code: string;
  readonly name: string;
  readonly rate: number | string | null;
  readonly startDate: string | Date | null;
  readonly endDate: string | Date | null;
  readonly description: string | null;
  readonly isDefault: boolean;
  readonly sort: number;
  readonly status: 'active' | 'inactive';
  readonly createdById: string;
  readonly createdAt: string | Date;
  readonly updatedAt: string | Date;
}

const iso = (value: string | Date): string =>
  value instanceof Date ? value.toISOString() : String(value);

const day = (value: string | Date | null): string | null => {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value);
};

const view = (row: StoredEntry): BizDictEntry => ({
  id: row.id,
  dictType: row.dictType,
  code: row.code,
  name: row.name,
  rate: row.rate === null ? null : Number(row.rate),
  startDate: day(row.startDate),
  endDate: day(row.endDate),
  description: row.description,
  isDefault: row.isDefault,
  sort: Number(row.sort),
  status: row.status,
  createdAt: iso(row.createdAt),
  updatedAt: iso(row.updatedAt),
});

const compareEntries = (left: BizDictEntry, right: BizDictEntry): number => {
  if (left.sort !== right.sort) return left.sort - right.sort;
  return left.code < right.code ? -1 : left.code > right.code ? 1 : 0;
};

export interface BizDictListQuery {
  readonly dictType: string;
  /** `all` 是在用加已停用；不带仍只回在用，别的调用方不受影响。 */
  readonly status?: 'active' | 'inactive' | 'all';
  readonly q?: string;
  readonly page: number;
  readonly pageSize: number;
}

export interface BizDictReader {
  list(query: BizDictListQuery): Promise<{
    readonly items: readonly BizDictEntry[];
    readonly total: number;
  }>;
  detail(id: string): Promise<BizDictEntry | undefined>;
  create(input: BizDictCreateInput, actorId: string): Promise<BizDictEntry>;
  update(id: string, patch: BizDictUpdateInput): Promise<BizDictEntry>;
  reorder(
    dictType: string,
    ids: readonly string[],
  ): Promise<readonly BizDictEntry[]>;
}

export class DatabaseBizDictReader implements BizDictReader {
  public constructor(private readonly database: DatabaseManager) {}

  public async list(query: BizDictListQuery): Promise<{
    readonly items: readonly BizDictEntry[];
    readonly total: number;
  }> {
    const dictType = assertDictType(query.dictType);
    const filter: Record<string, string> =
      query.status === 'all'
        ? { dictType }
        : { dictType, status: query.status ?? 'active' };
    const rows = await this.database
      .repository<StoredEntry>('bizDictEntries')
      .findMany({ filter });
    const term = query.q?.toLowerCase();
    const items = rows
      .filter(
        (row) =>
          term === undefined ||
          term === '' ||
          row.code.toLowerCase().includes(term) ||
          row.name.toLowerCase().includes(term),
      )
      .map(view)
      .sort(compareEntries);
    const total = items.length;
    return {
      items: items.slice((query.page - 1) * query.pageSize, query.page * query.pageSize),
      total,
    };
  }

  public async detail(id: string): Promise<BizDictEntry | undefined> {
    const row = await this.database
      .repository<StoredEntry>('bizDictEntries')
      .findOne({ filter: { id } });
    return row === undefined ? undefined : view(row);
  }

  public async create(
    input: BizDictCreateInput,
    actorId: string,
  ): Promise<BizDictEntry> {
    const dictType = assertDictType(input.dictType);
    assertApplicableFields(dictType, input);
    assertEntryValues(input);
    const existing = await this.database
      .repository<StoredEntry>('bizDictEntries')
      .findOne({ filter: { dictType, code: input.code } });
    if (existing !== undefined) {
      fail('code-taken', input.code);
    }
    const now = new Date().toISOString();
    try {
      return await this.database.transaction(async (tx) => {
        await this.clearDefault(tx, dictType);
        const values = {
          id: randomUUID(),
          dictType,
          code: input.code,
          name: input.name.trim(),
          rate: input.rate ?? null,
          startDate: input.startDate ?? null,
          endDate: input.endDate ?? null,
          description: input.description ?? null,
          isDefault: input.isDefault ?? false,
          sort: input.sort ?? 0,
          status: 'active' as const,
          createdById: actorId,
          createdAt: now,
          updatedAt: now,
        };
        const { record } = await tx
          .repository<StoredEntry>('bizDictEntries')
          .createOne({ values });
        return view(record);
      });
    } catch (error) {
      if (isUniqueConstraintViolation(error)) {
        fail('code-taken', input.code);
      }
      throw error;
    }
  }

  public async update(
    id: string,
    patch: BizDictUpdateInput,
  ): Promise<BizDictEntry> {
    const keys = Object.keys(patch) as readonly (keyof BizDictUpdateInput)[];
    if (keys.length === 0) {
      fail('empty-patch');
    }
    return await this.database.transaction(async (tx) => {
      const repo = tx.repository<StoredEntry>('bizDictEntries');
      const row = await repo.findOne({ filter: { id } });
      if (row === undefined) {
        fail('not-found', id);
      }
      const dictType = assertDictType(row.dictType);
      assertApplicableFields(dictType, patch);
      // 日期互为约束：只改 endDate 时也要拿库里原有的 startDate 比较。
      assertEntryValues({
        name: patch.name ?? row.name,
        rate:
          patch.rate === undefined
            ? row.rate === null
              ? null
              : Number(row.rate)
            : patch.rate,
        startDate:
          patch.startDate === undefined ? day(row.startDate) : patch.startDate,
        endDate: patch.endDate === undefined ? day(row.endDate) : patch.endDate,
      });
      if (patch.isDefault === true) {
        await this.clearDefault(tx, dictType, id);
      }
      const { record } = await repo.updateOne({
        filter: { id },
        values: {
          ...patch,
          ...(patch.name === undefined ? {} : { name: patch.name.trim() }),
          updatedAt: new Date().toISOString(),
        },
      });
      return view(record);
    });
  }

  public async reorder(
    dictType: string,
    ids: readonly string[],
  ): Promise<readonly BizDictEntry[]> {
    const type = assertDictType(dictType);
    return await this.database.transaction(async (tx) => {
      const repo = tx.repository<StoredEntry>('bizDictEntries');
      const rows = await repo.findMany({ filter: { dictType: type, status: 'active' } });
      const rank = new Map(ids.map((id, index) => [id, index] as const));
      // 没给到的行排在给了的行之后，相互之间仍按原来的 sort、code。
      const ordered = [...rows].sort((left, right) => {
        const a = rank.get(left.id);
        const b = rank.get(right.id);
        if (a !== undefined && b !== undefined) return a - b;
        if (a !== undefined) return -1;
        if (b !== undefined) return 1;
        return compareEntries(view(left), view(right));
      });
      for (const [index, row] of ordered.entries()) {
        await repo.updateOne({
          filter: { id: row.id },
          values: { sort: index, updatedAt: new Date().toISOString() },
        });
      }
      const after = await repo.findMany({
        filter: { dictType: type, status: 'active' },
      });
      return after.map(view).sort(compareEntries);
    });
  }

  private async clearDefault(
    tx: DatabaseConnection,
    dictType: string,
    exceptId?: string,
  ): Promise<void> {
    const repo = tx.repository<StoredEntry>('bizDictEntries');
    const defaults = await repo.findMany({
      filter: { dictType, isDefault: true },
    });
    // 逐行按主键清，不用 `$ne`：v3 的过滤简写对标量最稳。
    for (const row of defaults) {
      if (row.id === exceptId) continue;
      await repo.updateOne({
        filter: { id: row.id },
        values: { isDefault: false },
      });
    }
  }
}

export const bizDictReaderToken: ServiceToken<DatabaseBizDictReader> =
  createServiceToken<DatabaseBizDictReader>('app/biz-dict-reader');

export default class BizDictProvider extends ServiceProvider<Application> {
  public readonly name: string = 'app.biz-dict';

  public override register(): void {
    this.app.container.singleton(bizDictReaderToken, () => {
      const database = this.app.container.resolve(databaseManagerToken);
      return new DatabaseBizDictReader(database);
    });
  }
}
