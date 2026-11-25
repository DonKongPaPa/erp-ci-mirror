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

export interface QualityScreening {
  id: string;
  messageId: string;
  category: string | null;
  severity: string | null;
  suggestedOwner: string | null;
  summary: string | null;
  confidence: string | null;
  modelName: string | null;
  outcome: string;
  /** 列表端点为每行算好的「这一行处于可以确认的状态」；列表之外不返回。 */
  canReview?: boolean;
  createdAt: string;
  updatedAt: string;
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
