import type { ApiClient } from '@nocobase/app-client';

import type { EntityPage } from '#components/erp/list-state';

/**
 * R-064 订单评审端点的窄客户端：只读它回的列，不拼服务端已经算好的状态与日期。
 * 响应没有 `{ data }` 外层；列表不带 lines，详情才带。
 */
export type ReviewFactor =
  | 'man'
  | 'machine'
  | 'material'
  | 'method'
  | 'environment';
export type ReviewStatus = 'draft' | 'submitted' | 'confirmed' | 'void';

export const REVIEW_FACTORS: readonly ReviewFactor[] = [
  'man',
  'machine',
  'material',
  'method',
  'environment',
];

export interface ReviewLine {
  readonly id: string;
  readonly factor: ReviewFactor;
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
  readonly lines?: readonly ReviewLine[];
  readonly salesOrder?: {
    readonly id: string;
    readonly orderNo: string;
    readonly orderDate: string;
    readonly status: string;
  } | null;
}

export interface CreateReviewInput {
  readonly salesOrderId: string;
  readonly reviewerUserId: string;
  readonly lines: readonly {
    readonly factor: ReviewFactor;
    readonly conclusion: string;
    readonly note?: string;
  }[];
}

const enc = (id: string): string => encodeURIComponent(id);

export class OrderReviewsClient {
  public constructor(private readonly api: ApiClient) {}

  public list(salesOrderId: string): Promise<EntityPage<OrderReview>> {
    const query = new URLSearchParams({
      salesOrderId,
      pageSize: '100',
    });
    return this.api.request<EntityPage<OrderReview>>({
      path: `order-reviews?${query.toString()}`,
    });
  }

  public detail(id: string): Promise<OrderReview> {
    return this.api.request<OrderReview>({ path: `order-reviews/${enc(id)}` });
  }

  public create(input: CreateReviewInput): Promise<OrderReview> {
    return this.api.request<OrderReview>({
      path: 'order-reviews',
      method: 'POST',
      json: {
        salesOrderId: input.salesOrderId,
        reviewerUserId: input.reviewerUserId,
        lines: input.lines.map((line) => ({ ...line })),
      },
    });
  }

  public submit(id: string): Promise<OrderReview> {
    return this.api.request<OrderReview>({
      path: `order-reviews/${enc(id)}/submit`,
      method: 'POST',
    });
  }

  public confirm(id: string, confirmedDeliveryDate: string): Promise<OrderReview> {
    return this.api.request<OrderReview>({
      path: `order-reviews/${enc(id)}/confirm`,
      method: 'POST',
      json: { confirmedDeliveryDate },
    });
  }
}
