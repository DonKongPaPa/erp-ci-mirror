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

/**
 * R-025 S2：班次定义的读服务、内部服务与写服务。
 *
 * 读服务只回十列，逐列拼装；内部服务 `listActiveShifts()` 只有这一个方法，不经 HTTP、
 * 不查授权，给将来的报工与排班用。两者都返回副本，调用方改不动库里的行。
 *
 * 写服务把校验、咨询锁与事务放在一起：
 * - 建、改名排序、停用、启用都在事务开头取固定键的 `pg_advisory_xact_lock`，
 *   锁内重读再写。并发建同编码只有一个成功，另一个 code-exists（端点 409）；
 *   并发停用同一条只有一个成功，另一个 already-inactive（端点 409）。
 * - 编码的主键唯一约束再兜一层。
 * - 起止与休息段不可改：update 的入参里根本没有它们，端点也会先拒掉这类键。
 */
const STRUCTURE_LOCK_KEY = 'hs-erp:shifts:structure';
const CODE_PATTERN = /^[A-Z0-9][A-Z0-9_-]{0,31}$/u;

export type ShiftRuleCode =
  | 'invalid-code'
  | 'invalid-title'
  | 'invalid-minute'
  | 'invalid-break'
  | 'empty-range'
  | 'break-out-of-range'
  | 'code-exists'
  | 'shift-not-found'
  | 'invalid-update'
  | 'field-immutable'
  | 'already-inactive'
  | 'already-active';

export class ShiftRuleError extends Error {
  public constructor(
    readonly code: ShiftRuleCode,
    readonly detail?: string,
  ) {
    super(detail ?? `Shift rule violated: ${code}`);
    this.name = 'ShiftRuleError';
  }
}

function fail(code: ShiftRuleCode, detail?: string): never {
  throw new ShiftRuleError(code, detail);
}

/** 一张班次的十列，与迁移逐列对应；没有人员列、没有派生的跨天或时长列。 */
export interface ShiftRecord {
  readonly id: string;
  readonly title: string;
  readonly startMinute: number;
  readonly endMinute: number;
  readonly breakStartMinute: number | null;
  readonly breakEndMinute: number | null;
  readonly active: boolean;
  readonly sortOrder: number;
  readonly createdAt: string | Date;
  readonly updatedAt: string | Date;
}

export interface ShiftListQuery {
  readonly page: number;
  readonly pageSize: number;
  readonly includeInactive: boolean;
}

export interface CreateShiftInput {
  readonly id: string;
  readonly title: string;
  readonly startMinute: number;
  readonly endMinute: number;
  readonly breakStartMinute?: number | null;
  readonly breakEndMinute?: number | null;
  readonly sortOrder?: number;
}

export interface UpdateShiftInput {
  readonly title?: string;
  readonly sortOrder?: number;
}

/** 给别的模块用的内部服务，第一版只有这一个方法。 */
export interface ShiftService {
  listActiveShifts(): Promise<readonly ShiftRecord[]>;
}

/** HTTP 读端点用的查询；列筛选与排序只写这一处。 */
export interface ShiftReader extends ShiftService {
  list(query: ShiftListQuery): Promise<{
    readonly items: readonly ShiftRecord[];
    readonly total: number;
  }>;
  detail(id: string): Promise<ShiftRecord | undefined>;
}

export interface ShiftMutations {
  create(
    input: CreateShiftInput,
    transaction?: DatabaseConnection,
  ): Promise<ShiftRecord>;
  update(
    id: string,
    input: UpdateShiftInput,
    transaction?: DatabaseConnection,
  ): Promise<ShiftRecord>;
  setActive(
    id: string,
    active: boolean,
    transaction?: DatabaseConnection,
  ): Promise<ShiftRecord>;
}

const iso = (value: string | Date): string =>
  value instanceof Date ? value.toISOString() : String(value);

/** 逐列拼一份副本：调用方改返回值不会改到仓储里的行。 */
function view(row: ShiftRecord): ShiftRecord {
  return {
    id: row.id,
    title: row.title,
    startMinute: Number(row.startMinute),
    endMinute: Number(row.endMinute),
    breakStartMinute:
      row.breakStartMinute === null || row.breakStartMinute === undefined
        ? null
        : Number(row.breakStartMinute),
    breakEndMinute:
      row.breakEndMinute === null || row.breakEndMinute === undefined
        ? null
        : Number(row.breakEndMinute),
    active: Boolean(row.active),
    sortOrder: Number(row.sortOrder),
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

function compareShifts(left: ShiftRecord, right: ShiftRecord): number {
  if (left.sortOrder !== right.sortOrder) {
    return left.sortOrder < right.sortOrder ? -1 : 1;
  }
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

/** 0–1439 的整数分钟数；路由的 zod 也守一遍，这里是写服务的独立防线。 */
function minute(value: unknown, label: string): number {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > 1439
  ) {
    return fail('invalid-minute', label);
  }
  return value;
}

/**
 * 跨天不存成列：end < start 是跨天，end > start 是当天，相等不合法。
 * 休息段整段在开始之后或整段在结束之前（跨天班），当天班则整段在起止之间。
 */
function validateTimes(input: CreateShiftInput): void {
  const start = minute(input.startMinute, 'startMinute');
  const end = minute(input.endMinute, 'endMinute');
  if (start === end) {
    return fail('empty-range');
  }
  const hasStart = input.breakStartMinute !== undefined && input.breakStartMinute !== null;
  const hasEnd = input.breakEndMinute !== undefined && input.breakEndMinute !== null;
  if (hasStart !== hasEnd) {
    return fail('invalid-break');
  }
  if (hasStart) {
    const breakStart = minute(input.breakStartMinute, 'breakStartMinute');
    const breakEnd = minute(input.breakEndMinute, 'breakEndMinute');
    if (breakStart >= breakEnd) {
      return fail('break-out-of-range');
    }
    const insideSameDay = start <= breakStart && breakEnd <= end;
    const insideCrossDay =
      end < start && (breakStart >= start || breakEnd <= end);
    if (!insideSameDay && !insideCrossDay) {
      return fail('break-out-of-range');
    }
  }
}

export function validateShiftCode(input: string): string {
  const code = input.trim();
  if (!CODE_PATTERN.test(code)) {
    return fail('invalid-code');
  }
  return code;
}

export function validateShiftTitle(input: string): string {
  const title = input.trim();
  if (title.length < 1 || title.length > 64) {
    return fail('invalid-title');
  }
  return title;
}

export class DatabaseShiftReader implements ShiftReader {
  public constructor(private readonly database: DatabaseManager) {}

  public async list(query: ShiftListQuery): Promise<{
    readonly items: readonly ShiftRecord[];
    readonly total: number;
  }> {
    const rows = await this.rows(
      query.includeInactive ? undefined : { active: true },
    );
    rows.sort(compareShifts);
    const start = (query.page - 1) * query.pageSize;
    return {
      items: rows.slice(start, start + query.pageSize).map(view),
      total: rows.length,
    };
  }

  public async detail(id: string): Promise<ShiftRecord | undefined> {
    const row = await this.database
      .repository<ShiftRecord>('shifts')
      .findOne({ filter: { id } });
    return row === undefined ? undefined : view(row);
  }

  /** 不给 HTTP、不查授权：返回值是副本，改它不会写回库。 */
  public async listActiveShifts(): Promise<readonly ShiftRecord[]> {
    const rows = await this.rows({ active: true });
    rows.sort(compareShifts);
    return rows.map(view);
  }

  private async rows(
    filter: Record<string, unknown> | undefined,
  ): Promise<ShiftRecord[]> {
    const repository = this.database.repository<ShiftRecord>('shifts');
    return [
      ...(filter === undefined
        ? await repository.findMany()
        : await repository.findMany({ filter })),
    ];
  }
}

export class DatabaseShiftMutations implements ShiftMutations {
  public constructor(private readonly database: DatabaseManager) {}

  public async create(
    input: CreateShiftInput,
    transaction?: DatabaseConnection,
  ): Promise<ShiftRecord> {
    return await this.inTransaction(transaction, async (tx) => {
      await this.lockStructure(tx);
      const id = validateShiftCode(input.id);
      const title = validateShiftTitle(input.title);
      validateTimes(input);
      if ((await this.findOne(tx, id)) !== undefined) {
        return fail('code-exists');
      }
      const now = new Date();
      const row = await tx
        .repository<ShiftRecord>('shifts')
        .createOne({
          values: {
            id,
            title,
            startMinute: input.startMinute,
            endMinute: input.endMinute,
            breakStartMinute: input.breakStartMinute ?? null,
            breakEndMinute: input.breakEndMinute ?? null,
            active: true,
            sortOrder: input.sortOrder ?? 0,
            createdAt: now,
            updatedAt: now,
          },
        })
        .catch((error: unknown) => {
          if (isUniqueConstraintViolation(error)) {
            return fail('code-exists');
          }
          throw error;
        });
      return view(row.record);
    });
  }

  public async update(
    id: string,
    input: UpdateShiftInput,
    transaction?: DatabaseConnection,
  ): Promise<ShiftRecord> {
    return await this.inTransaction(transaction, async (tx) => {
      await this.lockStructure(tx);
      await this.require(tx, id);
      if (input.title === undefined && input.sortOrder === undefined) {
        return fail('invalid-update');
      }
      if (input.title !== undefined) {
        validateShiftTitle(input.title);
      }
      const { record } = await tx
        .repository<ShiftRecord>('shifts')
        .updateOne({
          filter: { id },
          values: {
            ...(input.title === undefined ? {} : { title: input.title.trim() }),
            ...(input.sortOrder === undefined ? {} : { sortOrder: input.sortOrder }),
            updatedAt: new Date(),
          },
        });
      return view(record);
    });
  }

  public async setActive(
    id: string,
    active: boolean,
    transaction?: DatabaseConnection,
  ): Promise<ShiftRecord> {
    return await this.inTransaction(transaction, async (tx) => {
      await this.lockStructure(tx);
      const current = await this.require(tx, id);
      if (current.active === active) {
        return fail(active ? 'already-active' : 'already-inactive');
      }
      const { record } = await tx
        .repository<ShiftRecord>('shifts')
        .updateOne({ filter: { id }, values: { active, updatedAt: new Date() } });
      return view(record);
    });
  }

  /** 调用方已开事务时复用它：并发用例能把两个事务扣在写之前交错。 */
  private async inTransaction<T>(
    transaction: DatabaseConnection | undefined,
    work: (tx: DatabaseConnection) => Promise<T>,
  ): Promise<T> {
    if (transaction !== undefined) {
      return await work(transaction);
    }
    return await this.database.transaction(work);
  }

  private async findOne(
    tx: DatabaseConnection,
    id: string,
  ): Promise<ShiftRecord | undefined> {
    return await tx.repository<ShiftRecord>('shifts').findOne({ filter: { id } });
  }

  private async require(
    tx: DatabaseConnection,
    id: string,
  ): Promise<ShiftRecord> {
    const row = await this.findOne(tx, id);
    if (row === undefined) {
      return fail('shift-not-found');
    }
    return row;
  }

  /** 结构变更串行化；锁随事务结束释放。读端点不取锁。 */
  private async lockStructure(tx: DatabaseConnection): Promise<void> {
    if (tx.dialect !== 'postgres') {
      return;
    }
    const knex = await tx.client<Knex>();
    await knex.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [
      STRUCTURE_LOCK_KEY,
    ]);
  }
}

export const shiftServiceToken: ServiceToken<ShiftService> =
  createServiceToken<ShiftService>('app/shift-service');
export const shiftReaderToken: ServiceToken<ShiftReader> =
  createServiceToken<ShiftReader>('app/shift-reader');
export const shiftMutationsToken: ServiceToken<ShiftMutations> =
  createServiceToken<ShiftMutations>('app/shift-mutations');

export default class ShiftsProvider extends ServiceProvider<Application> {
  public readonly name: string = 'app.shifts';

  public override register(): void {
    this.app.container.singleton(shiftServiceToken, () => {
      const database = this.app.container.resolve(databaseManagerToken);
      return new DatabaseShiftReader(database);
    });
    this.app.container.singleton(shiftReaderToken, () =>
      this.app.container.resolve(shiftServiceToken),
    );
    this.app.container.singleton(shiftMutationsToken, () => {
      const database = this.app.container.resolve(databaseManagerToken);
      return new DatabaseShiftMutations(database);
    });
  }
}
