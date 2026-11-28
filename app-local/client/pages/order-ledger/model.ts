/**
 * R-064 台账与提醒的只读列。服务端已经算好超期与基准日，页面只显示，不自己比日期。
 * 没有数据源的段三个键都是 null；只有 status 也算 null 段，不拿 0 冒充。
 */
export interface CustomerSummary {
  readonly id: string;
  readonly code: string;
  readonly name: string;
}

export interface PersonSummary {
  readonly userId: string;
  readonly name: string;
}

export interface LedgerSegment {
  readonly status: string | null;
  readonly qty: number | null;
  readonly total: number | null;
}

export interface ReviewSegment extends LedgerSegment {
  readonly confirmedDeliveryDate: string | null;
  readonly reviewer: PersonSummary | null;
}

export interface LedgerRow {
  readonly salesOrderId: string;
  readonly orderNo: string;
  readonly orderDate: string;
  readonly status: string;
  readonly customer: CustomerSummary | null;
  readonly projectCode: string | null;
  readonly projectLabel: string | null;
  readonly handler: PersonSummary | null;
  readonly baselineDate: string | null;
  readonly review: ReviewSegment;
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

export const isEmptySegment = (segment: LedgerSegment): boolean =>
  segment.status === null && segment.qty === null && segment.total === null;
