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

import { codeServiceToken, type CodeService } from './codes.js';

/**
 * R-023 W3-1 基础设置的读服务与写服务。
 *
 * 五类设置共用一张一张表自己的读写方法；工价单独一组，unitPrice 只在服务层读出来，
 * 由路由按 mesSettings.priceView 决定要不要放这个键（没有该动作就不是 null，是整键不出现）。
 * 六个开关/限制列原样读写，不解释语义、不进任何规则。
 * 停用已被引用的工序返回 in-use（422 MES_SETTING_IN_USE）；W3-3 工单表建好后在这里
 * 追加它的引用判定，本片只实现 processRouteSteps 这一条入口。
 */

export const MES_SETTING_KINDS = [
  'workCenters', 'operations', 'processRoutes', 'defectItems',
] as const;
export type MesSettingKind = (typeof MES_SETTING_KINDS)[number];
export type MesListKind = MesSettingKind | 'reportRules';

export type MesRuleCode =
  | 'not-found'
  | 'code-taken'
  | 'empty-patch'
  | 'in-use'
  | 'invalid-value';

export class MesRuleError extends Error {
  public constructor(
    readonly code: MesRuleCode,
    readonly detail?: string,
  ) {
    super(`MES setting rule violated: ${code}`);
    this.name = 'MesRuleError';
  }
}

function fail(code: MesRuleCode, detail?: string): never {
  throw new MesRuleError(code, detail);
}

export type MesRow = Record<string, unknown>;

export interface MesListQuery {
  readonly active?: 'active' | 'inactive' | 'all';
  readonly q?: string;
  readonly page: number;
  readonly pageSize: number;
}

export interface MesPriceQuery {
  readonly itemId?: string;
  readonly operationId?: string;
  readonly page: number;
  readonly pageSize: number;
}

export interface MesPriceInput {
  readonly itemId: string;
  readonly operationId: string;
  readonly unitPrice?: number | null;
  readonly note?: string | null;
}

export interface MesSettingsReader {
  list(kind: MesListKind, query: MesListQuery): Promise<{
    readonly items: readonly MesRow[];
    readonly total: number;
  }>;
  create(kind: MesSettingKind, input: MesRow, actorId: string): Promise<MesRow>;
  update(kind: MesSettingKind, id: string, patch: MesRow): Promise<MesRow>;
  updateRule(code: string, value: string, actorId: string): Promise<MesRow>;
  listPrices(query: MesPriceQuery): Promise<{
    readonly items: readonly MesRow[];
    readonly total: number;
  }>;
  upsertPrice(input: MesPriceInput, actorId: string): Promise<MesRow>;
  /** 停用前的引用判定入口：现在只看 processRouteSteps，W3-3 工单在这里追加。 */
  assertOperationDeactivatable(operationId: string): Promise<void>;
}

const COLUMNS: Readonly<Record<MesListKind, readonly string[]>> = {
  workCenters: [
    'id', 'code', 'name', 'managerUserId', 'workerCount', 'active', 'createdAt', 'updatedAt',
  ],
  operations: [
    'id', 'code', 'name', 'defaultWorkCenterId', 'sortOrder', 'unitHourlyCapacity',
    'equipmentRequired', 'handoverConfirm', 'inspectionFree', 'autoComplete',
    'currentReportLimit', 'previousReportLimit', 'displayStatus', 'active',
    'createdAt', 'updatedAt',
  ],
  processRoutes: ['id', 'docNo', 'name', 'productId', 'active', 'createdAt', 'updatedAt'],
  defectItems: ['id', 'code', 'name', 'active', 'createdAt'],
  reportRules: ['id', 'code', 'value', 'updatedAt'],
};

const WRITE_KEYS: Readonly<Record<MesSettingKind, readonly string[]>> = {
  workCenters: ['name', 'managerUserId', 'workerCount', 'active'],
  operations: [
    'name', 'defaultWorkCenterId', 'sortOrder', 'unitHourlyCapacity',
    'equipmentRequired', 'handoverConfirm', 'inspectionFree', 'autoComplete',
    'currentReportLimit', 'previousReportLimit', 'displayStatus', 'active',
  ],
  processRoutes: ['name', 'productId', 'active'],
  defectItems: ['name', 'active'],
};

const HAS_UPDATED_AT: Readonly<Record<MesSettingKind, boolean>> = {
  workCenters: true,
  operations: true,
  processRoutes: true,
  defectItems: false,
};

const CODE_FIELD: Readonly<Record<MesSettingKind, string>> = {
  workCenters: 'code',
  operations: 'code',
  processRoutes: 'docNo',
  defectItems: 'code',
};

/** 服务端发号的两类：不良品项 BL、工艺流程 GY。 */
const SERVER_CODES: Readonly<Partial<Record<MesSettingKind, string>>> = {
  processRoutes: 'GY',
  defectItems: 'BL',
};

const asText = (value: unknown): string =>
  typeof value === 'string' ? value : '';

const iso = (value: unknown): string =>
  value instanceof Date ? value.toISOString() : String(value);

const decimal = (value: unknown): number | null => {
  if (value === null || value === undefined) return null;
  return Number(value);
};

const pick = (row: MesRow, keys: readonly string[]): MesRow =>
  Object.fromEntries(keys.map((key) => [key, row[key]]));

function view(kind: MesListKind, row: MesRow): MesRow {
  const item = pick(row, COLUMNS[kind]);
  item.createdAt = iso(item.createdAt);
  if (Object.prototype.hasOwnProperty.call(item, 'updatedAt')) {
    item.updatedAt = iso(item.updatedAt);
  }
  if (kind === 'operations') {
    item.unitHourlyCapacity = decimal(row.unitHourlyCapacity);
  }
  return item;
}

function priceView(row: MesRow): MesRow {
  return {
    id: row.id,
    itemId: row.itemId,
    operationId: row.operationId,
    unitPrice: decimal(row.unitPrice),
    note: row.note ?? null,
    updatedAt: iso(row.updatedAt),
  };
}

export class DatabaseMesSettingsService implements MesSettingsReader {
  public constructor(
    private readonly database: DatabaseManager,
    private readonly codes: CodeService,
  ) {}

  public async list(kind: MesListKind, query: MesListQuery): Promise<{
    readonly items: readonly MesRow[];
    readonly total: number;
  }> {
    const filter: Record<string, string | number | boolean | null> = {};
    if (kind !== 'reportRules' && query.active !== undefined && query.active !== 'all') {
      filter.active = query.active === 'active';
    }
    const rows = await this.database.repository<MesRow>(kind).findMany({
      filter: Object.keys(filter).length === 0 ? undefined : filter as never,
    });
    const term = query.q?.toLowerCase();
    const matched = rows
      .filter((row) => {
        if (term === undefined || term === '') return true;
        const code = asText(row.code ?? row.docNo);
        return code.toLowerCase().includes(term) || asText(row.name).toLowerCase().includes(term);
      })
      .map((row) => view(kind, row))
      .sort((left, right) => {
        const leftOrder = Number(left.sortOrder ?? 0);
        const rightOrder = Number(right.sortOrder ?? 0);
        if (leftOrder !== rightOrder) return leftOrder - rightOrder;
        const leftCode = String(left.code ?? left.docNo ?? left.id);
        const rightCode = String(right.code ?? right.docNo ?? right.id);
        return leftCode < rightCode ? -1 : leftCode > rightCode ? 1 : 0;
      });
    return {
      items: matched.slice((query.page - 1) * query.pageSize, query.page * query.pageSize),
      total: matched.length,
    };
  }

  public async create(
    kind: MesSettingKind,
    input: MesRow,
    actorId: string,
  ): Promise<MesRow> {
    try {
      return await this.database.transaction(async (tx) => {
        const now = new Date().toISOString();
        const codeField = CODE_FIELD[kind];
        const codeFromServer = SERVER_CODES[kind];
        const code = codeFromServer === undefined
          ? input[codeField]
          : await this.codes.nextCode(tx, codeFromServer);
        if (typeof code !== 'string' || code.trim() === '') {
          fail('invalid-value', codeField);
        }
        if (typeof input.name !== 'string' || input.name.trim() === '') {
          fail('invalid-value', 'name');
        }
        if (kind === 'processRoutes' &&
            (typeof input.productId !== 'string' || input.productId === '')) {
          fail('invalid-value', 'productId');
        }
        const values: Record<string, unknown> = {
          id: randomUUID(),
          [codeField]: code,
          name: input.name,
          ...(kind === 'defectItems' ? {} : { createdById: actorId }),
          createdAt: now,
          ...(HAS_UPDATED_AT[kind] ? { updatedAt: now } : {}),
        };
        if (kind === 'workCenters') {
          values.managerUserId = input.managerUserId ?? null;
          values.workerCount = input.workerCount ?? null;
          values.active = true;
        }
        if (kind === 'operations') {
          for (const key of ['defaultWorkCenterId', 'unitHourlyCapacity']) {
            values[key] = input[key] ?? null;
          }
          for (const key of [
            'equipmentRequired', 'handoverConfirm', 'inspectionFree', 'autoComplete',
          ]) {
            values[key] = input[key] ?? null;
          }
          for (const key of ['currentReportLimit', 'previousReportLimit']) {
            values[key] = input[key] ?? null;
          }
          values.sortOrder = input.sortOrder ?? 0;
          values.displayStatus = input.displayStatus ?? 'active';
          values.active = true;
        }
        if (kind === 'processRoutes') {
          values.productId = input.productId;
          values.active = true;
        }
        if (kind === 'defectItems') {
          values.active = true;
        }
        const { record } = await tx.repository<MesRow>(kind).createOne({ values: values as never });
        return view(kind, record);
      });
    } catch (error) {
      if (isUniqueConstraintViolation(error)) {
        fail('code-taken', CODE_FIELD[kind]);
      }
      throw error;
    }
  }

  public async update(
    kind: MesSettingKind,
    id: string,
    patch: MesRow,
  ): Promise<MesRow> {
    const keys = Object.keys(patch);
    if (keys.length === 0) fail('empty-patch');
    for (const key of keys) {
      if (!WRITE_KEYS[kind].includes(key)) fail('invalid-value', key);
    }
    return await this.database.transaction(async (tx) => {
      const repo = tx.repository<MesRow>(kind);
      const row = await repo.findOne({ filter: { id } as never });
      if (row === undefined) fail('not-found', id);
      if (kind === 'operations' && patch.active === false) {
        await this.assertOperationDeactivatableIn(tx, id);
      }
      const { record } = await repo.updateOne({
        filter: { id } as never,
        values: {
          ...patch,
          ...(HAS_UPDATED_AT[kind] ? { updatedAt: new Date().toISOString() } : {}),
        } as never,
      });
      return view(kind, record);
    });
  }

  public async updateRule(
    code: string,
    value: string,
    actorId: string,
  ): Promise<MesRow> {
    return await this.database.transaction(async (tx) => {
      const repo = tx.repository<MesRow>('reportRules');
      const row = await repo.findOne({ filter: { code } as never });
      if (row === undefined) fail('not-found', code);
      const { record } = await repo.updateOne({
        filter: { code } as never,
        values: { value, updatedById: actorId, updatedAt: new Date().toISOString() } as never,
      });
      return view('reportRules', record);
    });
  }

  public async listPrices(query: MesPriceQuery): Promise<{
    readonly items: readonly MesRow[];
    readonly total: number;
  }> {
    const filter: Record<string, string | number | boolean | null> = {};
    if (query.itemId !== undefined) filter.itemId = query.itemId;
    if (query.operationId !== undefined) filter.operationId = query.operationId;
    const rows = await this.database.repository<MesRow>('operationPrices').findMany({
      filter: Object.keys(filter).length === 0 ? undefined : filter as never,
    });
    return {
      items: rows
        .map(priceView)
        .sort((left, right) =>
          String(left.itemId) < String(right.itemId)
            ? -1
            : String(left.itemId) > String(right.itemId)
              ? 1
              : String(left.operationId) < String(right.operationId)
                ? -1
                : String(left.operationId) > String(right.operationId)
                  ? 1
                  : 0,
        )
        .slice((query.page - 1) * query.pageSize, query.page * query.pageSize),
      total: rows.length,
    };
  }

  public async upsertPrice(input: MesPriceInput, actorId: string): Promise<MesRow> {
    try {
      return await this.database.transaction(async (tx) => {
        const repo = tx.repository<MesRow>('operationPrices');
        const existing = await repo.findOne({
          filter: { itemId: input.itemId, operationId: input.operationId } as never,
        });
        const values: Record<string, unknown> = {
          unitPrice: input.unitPrice ?? null,
          note: input.note ?? null,
          updatedById: actorId,
          updatedAt: new Date().toISOString(),
        };
        if (existing === undefined) {
          const { record } = await repo.createOne({
            values: {
              id: randomUUID(),
              itemId: input.itemId,
              operationId: input.operationId,
              ...values,
            } as never,
          });
          return priceView(record);
        }
        const { record } = await repo.updateOne({
          filter: { id: existing.id } as never,
          values: values as never,
        });
        return priceView(record);
      });
    } catch (error) {
      if (isUniqueConstraintViolation(error)) {
        fail('code-taken', 'operationPrices');
      }
      throw error;
    }
  }

  public async assertOperationDeactivatable(operationId: string): Promise<void> {
    await this.database.transaction(async (tx) => {
      await this.assertOperationDeactivatableIn(tx, operationId);
    });
  }

  private async assertOperationDeactivatableIn(
    tx: DatabaseConnection,
    operationId: string,
  ): Promise<void> {
    const steps = await tx.repository<MesRow>('processRouteSteps').findMany({
      filter: { operationId } as never,
    });
    if (steps.length > 0) fail('in-use', operationId);
    // W3-3 的 workOrderOperations 建表后在这里追加同样的引用判定；本片只做上面这一条。
  }
}

export const mesSettingsToken: ServiceToken<DatabaseMesSettingsService> =
  createServiceToken<DatabaseMesSettingsService>('app/mes-settings-reader');

export default class MesSettingsProvider extends ServiceProvider<Application> {
  public readonly name: string = 'app.mes-settings';

  public override register(): void {
    this.app.container.singleton(mesSettingsToken, () => {
      const database = this.app.container.resolve(databaseManagerToken);
      const codes = this.app.container.resolve(codeServiceToken);
      return new DatabaseMesSettingsService(database, codes);
    });
  }
}
