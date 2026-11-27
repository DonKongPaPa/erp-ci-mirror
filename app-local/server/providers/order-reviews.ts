import { randomUUID } from 'node:crypto';

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
import type { Knex } from 'knex';

import {
  employeeServiceToken,
  type EmployeeService,
} from './employee-service.js';

/**
 * R-064 订单评审的读服务与写服务。
 *
 * 五项结论写进子表、随整单替换，与头同一个事务。重新评审不删旧记录：确认时
 * `select … for update` 锁住销售订单头，把同一订单原来 confirmed 的评审置 void，
 * 再确认新的这一条 —— 并发两次确认时后一个看到前一个的 confirmed，按兜底规则码拒绝。
 * 不建部分唯一索引（方言差异大），不变量由这里守。
 *
 * 读响应只拼设计的窄形状：评审人与经办人只有 userId、name，不回 createdById、
 * 邮箱、电话、价格与金额。
 */

export const REVIEW_FACTORS = [
  'man', 'machine', 'material', 'method', 'environment',
] as const;
export type Factor = (typeof REVIEW_FACTORS)[number];
export type ReviewStatus = 'draft' | 'submitted' | 'confirmed' | 'void';

export type ReviewRuleCode =
  | 'not-found'
  | 'not-draft'
  | 'not-submitted'
  | 'factors-incomplete'
  | 'person-invalid'
  | 'delivery-invalid'
  | 'order-invalid'
  | 'confirmed-exists';

export class ReviewRuleError extends Error {
  public constructor(
    readonly code: ReviewRuleCode,
    readonly detail?: string,
  ) {
    super(
      detail === undefined
        ? `Review rule violated: ${code}`
        : `Review rule violated: ${code} (${detail})`,
    );
    this.name = 'ReviewRuleError';
  }
}

function fail(code: ReviewRuleCode, detail?: string): never {
  throw new ReviewRuleError(code, detail);
}

export interface ReviewLineInput {
  readonly factor: Factor;
  readonly conclusion: string;
  readonly note?: string;
}

export interface ReviewLine {
  readonly id: string;
  readonly factor: Factor;
  readonly conclusion: string;
  readonly note: string | null;
}

export interface PersonRef {
  readonly userId: string;
  readonly name: string;
}

export interface OrderReview {
  readonly id: string;
  readonly salesOrderId: string;
  readonly status: ReviewStatus;
  readonly reviewer: PersonRef;
  readonly reviewedAt: string;
  readonly confirmedDeliveryDate: string | null;
  readonly confirmedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lines: readonly ReviewLine[];
  readonly salesOrder: {
    readonly id: string;
    readonly orderNo: string;
    readonly orderDate: string;
    readonly status: string;
  } | null;
}

/** 列表行不带 lines，也不带 salesOrder（详情才有）。 */
export type OrderReviewSummary = Omit<OrderReview, 'lines' | 'salesOrder'>;

export interface ReviewListQuery {
  readonly salesOrderId?: string;
  readonly status?: ReviewStatus;
  readonly reviewerUserId?: string;
  readonly from?: string;
  readonly to?: string;
  readonly page: number;
  readonly pageSize: number;
}

export interface CreateReviewInput {
  readonly salesOrderId: string;
  readonly reviewerUserId: string;
  readonly lines: readonly ReviewLineInput[];
}

export interface UpdateReviewInput {
  readonly reviewerUserId?: string;
  readonly lines?: readonly ReviewLineInput[];
}

export interface OrderReviewReader {
  list(query: ReviewListQuery): Promise<{
    readonly items: readonly OrderReviewSummary[];
    readonly total: number;
  }>;
  detail(id: string): Promise<OrderReview | undefined>;
  summary(id: string): Promise<OrderReviewSummary | undefined>;
}

export interface OrderReviewMutations {
  create(input: CreateReviewInput, actorId: string): Promise<OrderReview>;
  update(id: string, patch: UpdateReviewInput): Promise<OrderReview>;
  submit(id: string): Promise<OrderReview>;
  confirm(
    id: string,
    confirmedDeliveryDate: string,
    tx?: DatabaseConnection,
  ): Promise<OrderReview>;
  void(id: string): Promise<OrderReview>;
}

interface ReviewRow {
  id: string;
  sales_order_id: string;
  status: ReviewStatus;
  reviewer_user_id: string;
  reviewed_at: string | Date;
  confirmed_delivery_date: string | Date | null;
  confirmed_at: string | Date | null;
  created_by_id: string;
  created_at: string | Date;
  updated_at: string | Date;
}
interface ReviewLineRow {
  id: string;
  review_id: string;
  factor: Factor;
  conclusion: string;
  note: string | null;
}
interface OrderRow {
  id: string;
  order_no: string;
  order_date: string | Date;
  status: string;
}

const iso = (value: string | Date): string =>
  value instanceof Date ? value.toISOString() : String(value);

const day = (value: string | Date | null): string | null => {
  if (value === null) return null;
  return value instanceof Date
    ? new Intl.DateTimeFormat('sv-SE', {
      timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(value)
    : String(value).slice(0, 10);
};

/** 设计里的 reviewedAt 形如 2026-11-27T23:35:00+08:00，带时区、精确到秒。 */
const shanghaiTimestamp = (value: string | Date): string => {
  const date = value instanceof Date ? value : new Date(value);
  const parts = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23',
  }).format(date);
  return `${parts.replace(' ', 'T')}+08:00`;
};

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

function validDay(value: string): boolean {
  return DATE_PATTERN.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

/** 五项各一行、不重复、结论非空；自由文本，不解读内容（待补查默认 1）。 */
function assertFactors(lines: readonly ReviewLineInput[]): void {
  if (lines.length !== REVIEW_FACTORS.length) fail('factors-incomplete');
  const seen = new Set<string>();
  for (const line of lines) {
    if (
      !(REVIEW_FACTORS as readonly string[]).includes(line.factor) ||
      seen.has(line.factor) ||
      typeof line.conclusion !== 'string' ||
      line.conclusion.trim() === ''
    ) {
      fail('factors-incomplete', line.factor);
    }
    seen.add(line.factor);
  }
}

function summaryOf(row: ReviewRow): OrderReviewSummary {
  return {
    id: row.id,
    salesOrderId: row.sales_order_id,
    status: row.status,
    reviewer: { userId: row.reviewer_user_id, name: '' },
    reviewedAt: shanghaiTimestamp(row.reviewed_at),
    confirmedDeliveryDate: day(row.confirmed_delivery_date),
    confirmedAt:
      row.confirmed_at === null ? null : shanghaiTimestamp(row.confirmed_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

export class DatabaseOrderReviewReader implements OrderReviewReader {
  public constructor(
    private readonly database: DatabaseManager,
    private readonly people: EmployeeService,
  ) {}

  private async knex(): Promise<Knex> {
    return await this.database.connection().client<Knex>();
  }

  private async withNames(
    rows: readonly OrderReviewSummary[],
  ): Promise<readonly OrderReviewSummary[]> {
    const displays = await this.people.displayByIds(
      rows.map((row) => row.reviewer.userId),
    );
    return rows.map((row) => ({
      ...row,
      reviewer: {
        userId: row.reviewer.userId,
        name: displays[row.reviewer.userId]?.name ?? '',
      },
    }));
  }

  public async list(query: ReviewListQuery): Promise<{
    readonly items: readonly OrderReviewSummary[];
    readonly total: number;
  }> {
    const knex = await this.knex();
    const base = knex<ReviewRow>('order_reviews').modify((builder) => {
      if (query.salesOrderId !== undefined) void builder.where('sales_order_id', query.salesOrderId);
      if (query.status !== undefined) void builder.where('status', query.status);
      if (query.reviewerUserId !== undefined) void builder.where('reviewer_user_id', query.reviewerUserId);
      if (query.from !== undefined) void builder.where('reviewed_at', '>=', query.from);
      if (query.to !== undefined) void builder.where('reviewed_at', '<=', query.to);
    });
    const counted = await base.clone().count({ count: '*' }).first() as
      | { count?: number | string }
      | undefined;
    const total = Number(counted?.count ?? 0);
    const rows = await base
      .clone()
      .orderBy('created_at', 'desc')
      .orderBy('id', 'asc')
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize) as ReviewRow[];
    return { items: await this.withNames(rows.map(summaryOf)), total };
  }

  public async summary(id: string): Promise<OrderReviewSummary | undefined> {
    const knex = await this.knex();
    const row = await knex<ReviewRow>('order_reviews').where({ id }).first();
    return row === undefined ? undefined : (await this.withNames([summaryOf(row)]))[0];
  }

  public async detail(id: string): Promise<OrderReview | undefined> {
    const knex = await this.knex();
    const row = await knex<ReviewRow>('order_reviews').where({ id }).first();
    if (row === undefined) return undefined;
    const [lines, order, displays] = await Promise.all([
      knex<ReviewLineRow>('order_review_lines')
        .where({ review_id: row.id }).orderBy('id', 'asc'),
      knex<OrderRow>('sales_orders')
        .select('id', 'order_no', 'order_date', 'status').where({ id: row.sales_order_id }).first(),
      this.people.displayByIds([row.reviewer_user_id]),
    ]);
    return {
      ...summaryOf(row),
      reviewer: {
        userId: row.reviewer_user_id,
        name: displays[row.reviewer_user_id]?.name ?? '',
      },
      lines: lines.map((line) => ({
        id: line.id,
        factor: line.factor,
        conclusion: line.conclusion,
        note: line.note,
      })),
      salesOrder: order === undefined ? null : {
        id: order.id,
        orderNo: order.order_no,
        orderDate: day(order.order_date) ?? '',
        status: order.status,
      },
    };
  }
}

export class DatabaseOrderReviewMutations implements OrderReviewMutations {
  public constructor(
    private readonly database: DatabaseManager,
    private readonly people: EmployeeService,
  ) {}

  private async knex(tx?: DatabaseConnection): Promise<Knex> {
    return await (tx ?? this.database.connection()).client<Knex>();
  }

  private async inTransaction<T>(
    tx: DatabaseConnection | undefined,
    work: (connection: DatabaseConnection) => Promise<T>,
  ): Promise<T> {
    return tx === undefined ? await this.database.transaction(work) : await work(tx);
  }

  private async requireActivePerson(userId: string): Promise<void> {
    if (!(await this.people.isActive(userId))) fail('person-invalid', userId);
  }

  private async requireOrder(
    knex: Knex,
    salesOrderId: string,
    lock = false,
  ): Promise<OrderRow> {
    let query = knex<OrderRow>('sales_orders')
      .select('id', 'order_no', 'order_date', 'status')
      .where({ id: salesOrderId });
    if (lock) query = query.forUpdate();
    const order = await query.first();
    if (order === undefined || order.status === 'cancelled') {
      fail('order-invalid', salesOrderId);
    }
    return order;
  }

  private async requireReview(
    knex: Knex,
    id: string,
    lock = false,
  ): Promise<ReviewRow> {
    let query = knex<ReviewRow>('order_reviews').where({ id });
    if (lock) query = query.forUpdate();
    const row = await query.first();
    if (row === undefined) fail('not-found', id);
    return row;
  }

  private async replaceLines(
    knex: Knex,
    reviewId: string,
    lines: readonly ReviewLineInput[],
  ): Promise<void> {
    assertFactors(lines);
    await knex('order_review_lines').where({ review_id: reviewId }).delete();
    for (const line of lines) {
      await knex('order_review_lines').insert({
        id: randomUUID(),
        review_id: reviewId,
        factor: line.factor,
        conclusion: line.conclusion.trim(),
        note: line.note === undefined || line.note === '' ? null : line.note,
      });
    }
  }

  /** 写服务返回详情：同一个连接读回，避免事务里刚写的行在别处读不到。 */
  private async readBack(
    knex: Knex,
    id: string,
  ): Promise<OrderReview> {
    const row = await this.requireReview(knex, id);
    const [lines, order, displays] = await Promise.all([
      knex<ReviewLineRow>('order_review_lines')
        .where({ review_id: row.id }).orderBy('id', 'asc'),
      knex<OrderRow>('sales_orders')
        .select('id', 'order_no', 'order_date', 'status')
        .where({ id: row.sales_order_id }).first(),
      this.people.displayByIds([row.reviewer_user_id]),
    ]);
    return {
      ...summaryOf(row),
      reviewer: {
        userId: row.reviewer_user_id,
        name: displays[row.reviewer_user_id]?.name ?? '',
      },
      lines: lines.map((line) => ({
        id: line.id, factor: line.factor,
        conclusion: line.conclusion, note: line.note,
      })),
      salesOrder: order === undefined ? null : {
        id: order.id, orderNo: order.order_no,
        orderDate: day(order.order_date) ?? '', status: order.status,
      },
    };
  }

  public async create(
    input: CreateReviewInput,
    actorId: string,
  ): Promise<OrderReview> {
    assertFactors(input.lines);
    await this.requireActivePerson(input.reviewerUserId);
    return await this.inTransaction(undefined, async (tx) => {
      const knex = await this.knex(tx);
      await this.requireOrder(knex, input.salesOrderId);
      const now = new Date().toISOString();
      const id = randomUUID();
      await knex('order_reviews').insert({
        id,
        sales_order_id: input.salesOrderId,
        status: 'draft',
        reviewer_user_id: input.reviewerUserId,
        reviewed_at: now,
        confirmed_delivery_date: null,
        confirmed_at: null,
        created_by_id: actorId,
        created_at: now,
        updated_at: now,
      });
      await this.replaceLines(knex, id, input.lines);
      return await this.readBack(knex, id);
    });
  }

  public async update(
    id: string,
    patch: UpdateReviewInput,
  ): Promise<OrderReview> {
    if (patch.reviewerUserId !== undefined) {
      await this.requireActivePerson(patch.reviewerUserId);
    }
    if (patch.lines !== undefined) assertFactors(patch.lines);
    return await this.inTransaction(undefined, async (tx) => {
      const knex = await this.knex(tx);
      const row = await this.requireReview(knex, id, true);
      if (row.status !== 'draft') fail('not-draft', row.status);
      if (patch.reviewerUserId !== undefined) {
        await knex('order_reviews').where({ id }).update({
          reviewer_user_id: patch.reviewerUserId,
          updated_at: new Date().toISOString(),
        });
      }
      if (patch.lines !== undefined) {
        await this.replaceLines(knex, id, patch.lines);
      }
      return await this.readBack(knex, id);
    });
  }

  public async submit(id: string): Promise<OrderReview> {
    return await this.inTransaction(undefined, async (tx) => {
      const knex = await this.knex(tx);
      const row = await this.requireReview(knex, id, true);
      if (row.status !== 'draft') fail('not-draft', row.status);
      await this.requireActivePerson(row.reviewer_user_id);
      const lines = await knex<ReviewLineRow>('order_review_lines')
        .where({ review_id: id });
      if (lines.length !== REVIEW_FACTORS.length) fail('factors-incomplete');
      const now = new Date().toISOString();
      await knex('order_reviews').where({ id }).update({
        status: 'submitted', reviewed_at: now, updated_at: now,
      });
      return await this.readBack(knex, id);
    });
  }

  public async confirm(
    id: string,
    confirmedDeliveryDate: string,
    tx?: DatabaseConnection,
  ): Promise<OrderReview> {
    if (!validDay(confirmedDeliveryDate)) fail('delivery-invalid', confirmedDeliveryDate);
    return await this.inTransaction(tx, async (connection) => {
      const knex = await this.knex(connection);
      const row = await this.requireReview(knex, id);
      // 锁之前的快照：旧的一轮评审在这里就算「待替代」；等锁期间新出现的才是并发冲突。
      const before = await knex<ReviewRow>('order_reviews')
        .select('id').where({ sales_order_id: row.sales_order_id, status: 'confirmed' })
        .whereNot('id', id);
      const beforeIds = new Set(before.map((entry) => entry.id));
      // 锁住订单头：同一订单的两次确认在这里串行，第二次能看到第一次的 confirmed。
      const order = await this.requireOrder(knex, row.sales_order_id, true);
      const fresh = await this.requireReview(knex, id, true);
      if (fresh.status !== 'submitted') fail('not-submitted', fresh.status);
      if (confirmedDeliveryDate < (day(order.order_date) ?? '')) {
        fail('delivery-invalid', confirmedDeliveryDate);
      }
      const others = await knex<ReviewRow>('order_reviews')
        .select('id').where({ sales_order_id: row.sales_order_id, status: 'confirmed' })
        .whereNot('id', id);
      if (others.some((entry) => !beforeIds.has(entry.id))) {
        fail('confirmed-exists', row.sales_order_id);
      }
      const now = new Date().toISOString();
      await knex('order_reviews').whereIn('id', others.map((entry) => entry.id))
        .update({ status: 'void', updated_at: now });
      await knex('order_reviews').where({ id }).update({
        status: 'confirmed',
        confirmed_delivery_date: confirmedDeliveryDate,
        confirmed_at: now,
        updated_at: now,
      });
      return await this.readBack(knex, id);
    });
  }

  public async void(id: string): Promise<OrderReview> {
    return await this.inTransaction(undefined, async (tx) => {
      const knex = await this.knex(tx);
      const row = await this.requireReview(knex, id, true);
      if (row.status !== 'void') {
        await knex('order_reviews').where({ id }).update({
          status: 'void', updated_at: new Date().toISOString(),
        });
      }
      return await this.readBack(knex, id);
    });
  }
}

export const orderReviewReaderToken: ServiceToken<DatabaseOrderReviewReader> =
  createServiceToken<DatabaseOrderReviewReader>('app/order-review-reader');
export const orderReviewMutationsToken: ServiceToken<DatabaseOrderReviewMutations> =
  createServiceToken<DatabaseOrderReviewMutations>('app/order-review-mutations');

export default class OrderReviewsProvider extends ServiceProvider<Application> {
  public readonly name: string = 'app.order-reviews';

  public override register(): void {
    this.app.container.singleton(orderReviewReaderToken, () => {
      const database = this.app.container.resolve(databaseManagerToken);
      const people = this.app.container.resolve(employeeServiceToken);
      return new DatabaseOrderReviewReader(database, people);
    });
    this.app.container.singleton(orderReviewMutationsToken, () => {
      const database = this.app.container.resolve(databaseManagerToken);
      const people = this.app.container.resolve(employeeServiceToken);
      return new DatabaseOrderReviewMutations(database, people);
    });
  }
}
