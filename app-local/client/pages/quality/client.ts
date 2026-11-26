import type { ApiClient } from '@nocobase/app-client';

export interface QualityMessage {
  id: string;
  channel: string;
  externalId: string | null;
  senderName: string | null;
  senderContact: string | null;
  content: string;
  rawContentType: string;
  receivedAt: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * 人工确认记录的一行（R-002）。只随确认端点的响应返回；列表不随行读确认记录，
 * 所以列表响应里没有它，页面上的「谁在何时确认成什么」用确认时拿到的那一行。
 */
export interface QualityScreeningReview {
  id: string;
  screeningId: string;
  kind: string;
  category: string;
  severity: string;
  departmentId: string | null;
  actorId: string;
  createdAt: string;
}

export interface QualityScreening {
  id: string;
  messageId: string;
  category: string | null;
  severity: string | null;
  suggestedOwner: string | null;
  summary: string | null;
  confidence: string | null;
  evidence: unknown;
  modelName: string | null;
  // R-002 的六个出处列：这份草稿是谁出的、为什么没跑或回落、引了哪些知识、
  // 发出去之前脱没脱敏。`knowledgeRefs` 里 `kb:` 是知识库引用、`case:` 是相似案例。
  engine: string;
  promptVersion: string | null;
  degraded: boolean;
  degradeReason: string | null;
  knowledgeRefs: string[] | null;
  redacted: boolean;
  reviewId: string | null;
  outcome: string;
  /** 列表端点为每行算好的「这一行处于可以确认的状态」；列表之外不返回。 */
  canReview?: boolean;
  /** 只在确认端点的响应里出现：刚写下的那行确认记录。 */
  review?: QualityScreeningReview;
  createdAt: string;
  updatedAt: string;
}

/** 代填效果（R-002）：草稿与人工确认的对照，只有汇总数字。 */
export interface QualityDraftingStats {
  from: string;
  to: string;
  total: number;
  engines: { rules: number; model: number };
  degradeReasons: {
    'model-disabled': number;
    'model-not-configured': number;
    'model-error': number;
    timeout: number;
    'invalid-output': number;
  };
  redacted: number;
  confirmed: number;
  agreement: {
    category: { matched: number; mismatched: number };
    severity: { matched: number; mismatched: number };
  };
}

export interface QualityTicket {
  id: string;
  code: string;
  title: string;
  description: string | null;
  sourceMessageId: string | null;
  screeningId: string | null;
  category: string | null;
  severity: string;
  ownerDepartment: string | null;
  assigneeId: string | null;
  state: string;
  dueAt: string | null;
  closedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TicketQuery {
  state?: string;
  ownerDepartment?: string;
  page?: number;
  pageSize?: number;
}

export interface ListResult<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

/** 质量工单与消息的读取客户端。写操作走 useSubmission 以获取幂等键。 */
export class QualityClient {
  constructor(private readonly api: ApiClient) {}

  listTickets(query: TicketQuery = {}): Promise<ListResult<QualityTicket>> {
    return this.api
      .request<{ data: QualityTicket[]; meta?: Record<string, unknown> }>({
        path: 'quality/tickets',
        query: Object.fromEntries(
          Object.entries(query).filter(([, value]) => value !== undefined),
        ),
      })
      .then(({ data, meta }) => ({
        items: data,
        total: (meta?.total as number) ?? 0,
        page: (meta?.page as number) ?? 1,
        pageSize: (meta?.pageSize as number) ?? 20,
      }));
  }

  listMessages(): Promise<ListResult<QualityMessage>> {
    return this.api
      .request<{ data: QualityMessage[]; meta?: Record<string, unknown> }>({
        path: 'quality/messages',
      })
      .then(({ data, meta }) => ({
        items: data,
        total: (meta?.total as number) ?? 0,
        page: 1,
        pageSize: 50,
      }));
  }

  listScreenings(): Promise<ListResult<QualityScreening>> {
    return this.api
      .request<{ data: QualityScreening[]; meta?: Record<string, unknown> }>({
        path: 'quality/screenings',
      })
      .then(({ data, meta }) => ({
        items: data,
        total: (meta?.total as number) ?? 0,
        page: 1,
        pageSize: 50,
      }));
  }

  /** 代填效果（R-002）：区间落在初筛的 createdAt 上，两端必填、跨度不超过一年。 */
  draftingStats(range: { from: string; to: string }): Promise<QualityDraftingStats> {
    return this.api
      .request<{ data: QualityDraftingStats }>({
        path: 'quality/drafting/stats',
        query: { from: range.from, to: range.to },
      })
      .then(({ data }) => data);
  }

  /** 投递一条客户消息，服务端会同步完成初筛并生成工单。幂等键由 useSubmission 生成。 */
  intake(
    input: {
      channel: string;
      senderName?: string;
      senderContact?: string;
      content: string;
    },
    idempotencyKey?: string,
  ): Promise<{
    message: QualityMessage;
    screening: QualityScreening;
    ticket: QualityTicket;
  }> {
    return this.api
      .request<{
        data: {
          message: QualityMessage;
          screening: QualityScreening;
          ticket: QualityTicket;
        };
      }>({
        path: 'quality/intake',
        method: 'POST',
        ...(idempotencyKey
          ? { headers: { 'Idempotency-Key': idempotencyKey } }
          : {}),
        json: { contentType: 'text', ...input },
      })
      .then(({ data }) => data);
  }

  /** 确认一条初筛。请求体是 `{}`；改判的表单不在这一版。 */
  review(
    screeningId: string,
    input: {
      category?: string;
      severity?: string;
      ownerDepartment?: string;
    } = {},
  ): Promise<QualityScreening> {
    return this.api
      .request<{ data: QualityScreening }>({
        path: `quality/screenings/${encodeURIComponent(screeningId)}/review`,
        method: 'POST',
        json: input,
      })
      .then(({ data }) => data);
  }
}
