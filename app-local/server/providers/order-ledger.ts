import type { Application } from '@nocobase/app-server/application';
import {
  databaseManagerToken,
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
 * R-064 订单总台账与首页交付提醒的只读投影：不建表、不落库、不改订单端点。
 *
 * 六段里只有评审与发货有数据源，其余四段三个键回 null（不是 0）—— 0 会让人
 * 误以为「一件没发」。超期判定在服务端算：优先用最新 confirmed 评审的确认交期，
 * 没有时回落到订单的 latestDeliveryDate；自然日按 Asia/Shanghai 算。
 * 响应只回窄列：客户三列、人员两列，没有价格、金额、联系方式。
 */

export interface LedgerSegment {
  readonly status: string | null;
  readonly qty: number | null;
  readonly total: number | null;
}

export interface CustomerSummary {
  readonly id: string;
  readonly code: string;
  readonly name: string;
}

export interface LedgerRow {
  readonly salesOrderId: string;
  readonly orderNo: string;
  readonly orderDate: string;
  readonly status: string;
  readonly customer: CustomerSummary | null;
  readonly projectCode: string | null;
  readonly projectLabel: string | null;
  readonly handler: { readonly userId: string; readonly name: string } | null;
  readonly baselineDate: string | null;
  readonly review: LedgerSegment & {
    readonly confirmedDeliveryDate: string | null;
    readonly reviewer: { readonly userId: string; readonly name: string } | null;
  };
  readonly purchase: LedgerSegment;
  readonly production: LedgerSegment;
  readonly receipt: LedgerSegment;
  readonly shipping: LedgerSegment;
  readonly payment: LedgerSegment;
  readonly overdue: boolean;
  readonly overdueDays: number | null;
  readonly upcoming: boolean;
}

export interface ReminderRow {
  readonly salesOrderId: string;
  readonly orderNo: string;
  readonly customer: CustomerSummary | null;
  readonly baselineDate: string;
  readonly overdueDays: number;
  readonly scope: 'overdue' | 'upcoming';
}

export interface LedgerQuery {
  readonly q?: string;
  readonly customerId?: string;
  readonly projectCode?: string;
  readonly reviewStatus?: 'pending' | 'done';
  readonly overdue?: boolean;
  readonly days: number;
  readonly status?: string;
  readonly page: number;
  readonly pageSize: number;
}

export interface ReminderQuery {
  readonly scope: 'overdue' | 'upcoming';
  readonly days: number;
  readonly limit: number;
}

export interface OrderLedgerReader {
  list(query: LedgerQuery): Promise<{
    readonly items: readonly LedgerRow[];
    readonly total: number;
  }>;
  reminders(query: ReminderQuery): Promise<{
    readonly items: readonly ReminderRow[];
    readonly total: number;
  }>;
}

interface OrderRow {
  id: string;
  order_no: string;
  order_date: string | Date;
  status: string;
  latest_delivery_date: string | Date | null;
  customer_id: string | null;
  project_code: string | null;
  handler_user_id: string | null;
}
interface LineRow {
  order_id: string;
  qty: string | number;
  shipped_qty: string | number;
}
interface ReviewRow {
  id: string;
  sales_order_id: string;
  status: string;
  reviewer_user_id: string;
  confirmed_delivery_date: string | Date | null;
  confirmed_at: string | Date | null;
  created_at: string | Date;
}
interface PartnerRow {
  id: string;
  code: string;
  name: string;
}
interface DictRow {
  code: string;
  name: string;
}

const EMPTY_SEGMENT: LedgerSegment = { status: null, qty: null, total: null };
const num = (value: string | number): number => Number(value);
const day = (value: string | Date | null): string | null => {
  if (value === null) return null;
  return value instanceof Date
    ? new Intl.DateTimeFormat('sv-SE', {
      timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(value)
    : String(value).slice(0, 10);
};
const stamp = (value: string | Date): string =>
  value instanceof Date ? value.toISOString() : String(value);

const shanghaiDay = (date: Date): string =>
  new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date);

const utcDay = (value: string): number => {
  const [year = 0, month = 1, date = 1] = value.split('-').map(Number);
  return Date.UTC(year, month - 1, date);
};

const addDays = (value: string, count: number): string =>
  new Date(utcDay(value) + count * 86_400_000).toISOString().slice(0, 10);

/** 自然日差：当天 − 基准日，超期为正、未到为负。 */
const daysBetween = (baseline: string, today: string): number =>
  Math.round((utcDay(today) - utcDay(baseline)) / 86_400_000);

export class DatabaseOrderLedger implements OrderLedgerReader {
  public constructor(
    private readonly database: DatabaseManager,
    private readonly people: EmployeeService,
  ) {}

  private async knex(): Promise<Knex> {
    return await this.database.connection().client<Knex>();
  }

  private async project(
    query: LedgerQuery,
  ): Promise<{
    rows: readonly LedgerRow[];
    orders: readonly OrderRow[];
  }> {
    const knex = await this.knex();
    const base = knex<OrderRow>('sales_orders').select(
      'id', 'order_no', 'order_date', 'status', 'latest_delivery_date',
      'customer_id', 'project_code', 'handler_user_id',
    ).modify((builder) => {
      if (query.q !== undefined && query.q !== '') {
        void builder.whereILike('order_no', `%${query.q}%`);
      }
      if (query.customerId !== undefined) void builder.where('customer_id', query.customerId);
      if (query.projectCode !== undefined) void builder.where('project_code', query.projectCode);
      if (query.status !== undefined) void builder.where('status', query.status);
    });
    const orders = await base.orderBy('created_at', 'desc').orderBy('id', 'asc') as OrderRow[];
    if (orders.length === 0) return { rows: [], orders: [] };
    const ids = orders.map((order) => order.id);
    const customerIds = [...new Set(
      orders.map((order) => order.customer_id).filter((id): id is string => id !== null),
    )];
    const projectCodesWanted = [...new Set(
      orders.map((order) => order.project_code).filter((code): code is string => code !== null),
    )];

    const [lines, reviews, partners, projectCodes] = await Promise.all([
      knex('sales_order_lines')
        .select('order_id', 'qty', 'shipped_qty').whereIn('order_id', ids) as Promise<LineRow[]>,
      knex('order_reviews')
        .select('id', 'sales_order_id', 'status', 'reviewer_user_id',
          'confirmed_delivery_date', 'confirmed_at', 'created_at')
        .whereIn('sales_order_id', ids) as Promise<ReviewRow[]>,
      knex('partners').select('id', 'code', 'name')
        .whereIn('id', customerIds) as Promise<PartnerRow[]>,
      knex('biz_dict_entries').select('code', 'name')
        .where({ dict_type: 'project' })
        .whereIn('code', projectCodesWanted) as Promise<DictRow[]>,
    ]);

    const linesByOrder = new Map<string, LineRow[]>();
    for (const line of lines) {
      const list = linesByOrder.get(line.order_id) ?? [];
      list.push(line);
      linesByOrder.set(line.order_id, list);
    }
    const reviewsByOrder = new Map<string, ReviewRow[]>();
    for (const review of reviews) {
      const list = reviewsByOrder.get(review.sales_order_id) ?? [];
      list.push(review);
      reviewsByOrder.set(review.sales_order_id, list);
    }
    const partnersById = new Map(partners.map((partner) => [partner.id, partner] as const));
    const projectNames = new Map(projectCodes.map((entry) => [entry.code, entry.name] as const));

    const personIds = [
      ...new Set(reviews.map((review) => review.reviewer_user_id).concat(
        orders.map((order) => order.handler_user_id).filter((id): id is string => id !== null),
      )),
    ];
    const displays = await this.people.displayByIds(personIds);
    const nameOf = (userId: string): string => displays[userId]?.name ?? '';
    const today = shanghaiDay(new Date());
    const soon = addDays(today, query.days);

    const rows = orders.map((order): LedgerRow => {
      const orderLines = linesByOrder.get(order.id) ?? [];
      const shipped = orderLines.reduce((sum, line) => sum + num(line.shipped_qty), 0);
      const totalQty = orderLines.reduce((sum, line) => sum + num(line.qty), 0);
      const unshipped = totalQty - shipped;
      const orderReviews = [...(reviewsByOrder.get(order.id) ?? [])].sort((left, right) => {
        const a = `${stamp(left.created_at)}|${left.id}`;
        const b = `${stamp(right.created_at)}|${right.id}`;
        return a < b ? 1 : a > b ? -1 : 0;
      });
      const completed = orderReviews.find((review) =>
        review.status === 'submitted' || review.status === 'confirmed');
      const confirmed = orderReviews
        .filter((review) => review.status === 'confirmed')
        .sort((left, right) => {
          const a = `${stamp(left.confirmed_at ?? left.created_at)}|${left.id}`;
          const b = `${stamp(right.confirmed_at ?? right.created_at)}|${right.id}`;
          return a < b ? 1 : a > b ? -1 : 0;
        })[0];
      const reviewerRow = confirmed ?? completed ?? orderReviews[0];
      const baselineDate =
        day(confirmed?.confirmed_delivery_date ?? null) ?? day(order.latest_delivery_date);
      const overdue = baselineDate !== null && baselineDate < today && unshipped > 0;
      const overdueDays = baselineDate === null ? null : daysBetween(baselineDate, today);
      const upcoming =
        baselineDate !== null &&
        !overdue &&
        baselineDate <= soon &&
        unshipped > 0;
      const shippingStatus =
        unshipped <= 0 && totalQty > 0
          ? 'shipped'
          : shipped > 0
            ? 'partial'
            : 'none';
      const partner = order.customer_id === null
        ? undefined
        : partnersById.get(order.customer_id);
      return {
        salesOrderId: order.id,
        orderNo: order.order_no,
        orderDate: day(order.order_date) ?? '',
        status: order.status,
        customer: partner === undefined ? null : {
          id: partner.id, code: partner.code, name: partner.name,
        },
        projectCode: order.project_code,
        projectLabel:
          order.project_code === null ? null : (projectNames.get(order.project_code) ?? order.project_code),
        handler: order.handler_user_id === null ? null : {
          userId: order.handler_user_id, name: nameOf(order.handler_user_id),
        },
        baselineDate,
        review: {
          status: completed === undefined && confirmed === undefined ? 'pending' : 'done',
          qty: null,
          total: null,
          confirmedDeliveryDate: day(confirmed?.confirmed_delivery_date ?? null),
          reviewer: reviewerRow === undefined ? null : {
            userId: reviewerRow.reviewer_user_id,
            name: nameOf(reviewerRow.reviewer_user_id),
          },
        },
        purchase: EMPTY_SEGMENT,
        production: EMPTY_SEGMENT,
        receipt: EMPTY_SEGMENT,
        shipping: { status: shippingStatus, qty: shipped, total: totalQty },
        payment: EMPTY_SEGMENT,
        overdue,
        overdueDays,
        upcoming,
      };
    });
    return { rows, orders };
  }

  public async list(query: LedgerQuery): Promise<{
    readonly items: readonly LedgerRow[];
    readonly total: number;
  }> {
    const { rows } = await this.project(query);
    const filtered = rows.filter((row) => {
      if (query.reviewStatus !== undefined && row.review.status !== query.reviewStatus) return false;
      if (query.overdue !== undefined && row.overdue !== query.overdue) return false;
      return true;
    });
    const start = (query.page - 1) * query.pageSize;
    return { items: filtered.slice(start, start + query.pageSize), total: filtered.length };
  }

  public async reminders(query: ReminderQuery): Promise<{
    readonly items: readonly ReminderRow[];
    readonly total: number;
  }> {
    // 提醒只看有基准日的单：upcoming 用 days，overdue 只看未发齐的超期单。
    const { rows } = await this.project({
      days: query.days, page: 1, pageSize: 1_000_000,
    });
    const matching = rows
      .filter((row) => row.baselineDate !== null && (
        query.scope === 'overdue' ? row.overdue : row.upcoming
      ))
      .sort((left, right) => {
        const a = left.baselineDate ?? '';
        const b = right.baselineDate ?? '';
        return a < b ? -1 : a > b ? 1 : left.salesOrderId < right.salesOrderId ? -1 : 1;
      });
    return {
      items: matching.slice(0, query.limit).map((row) => ({
        salesOrderId: row.salesOrderId,
        orderNo: row.orderNo,
        customer: row.customer,
        baselineDate: row.baselineDate!,
        overdueDays: row.overdueDays ?? 0,
        scope: query.scope,
      })),
      total: matching.length,
    };
  }
}

export const orderLedgerToken: ServiceToken<DatabaseOrderLedger> =
  createServiceToken<DatabaseOrderLedger>('app/order-ledger');

export default class OrderLedgerProvider extends ServiceProvider<Application> {
  public readonly name: string = 'app.order-ledger';

  public override register(): void {
    this.app.container.singleton(orderLedgerToken, () => {
      const database = this.app.container.resolve(databaseManagerToken);
      const people = this.app.container.resolve(employeeServiceToken);
      return new DatabaseOrderLedger(database, people);
    });
  }
}
