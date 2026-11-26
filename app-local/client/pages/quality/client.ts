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
 * 人工确认记录的一行（R-002）。列表已确认的行随行带最近一次记录，确认端点回刚写的那行；
 * `actorId` 留着排障，页面只显示服务端解析好的 `actorName`。
 */
export interface QualityScreeningReview {
  id: string;
  screeningId: string;
  kind: string;
  category: string;
  severity: string;
  departmentId: string | null;
  actorId: string;
  /** 姓名（解析不到时是中性占位）；服务端不回邮箱、手机号。 */
  actorName: string;
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
  /** 列表已确认的行随行带最近一次确认（或 null）；确认端点回刚写下的那行。 */
  review?: QualityScreeningReview | null;
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

  /** 投递一条客户消息，服务端同步完成初筛；不建工单（人工确认之后才建）。幂等键由 useSubmission 生成。 */
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
