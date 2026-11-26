import type { ApiClient } from '@nocobase/app-client';

export interface FeedbackAttachment {
  readonly id: string;
  readonly filename: string;
  readonly mimeType: string;
  readonly size: number;
  /** 取内容的端点地址；页面只把它作为链接，不自己拼地址。 */
  readonly url: string;
}

export interface FeedbackScreening {
  readonly category: string | null;
  readonly severity: string | null;
  readonly suggestedOwner: string | null;
  readonly summary: string | null;
  readonly confidence: string | null;
  readonly outcome: string;
}

export interface FeedbackTicket {
  readonly id: string;
  readonly code: string;
  readonly state: string;
}

/** 一行反馈。`note`、`discardedBy`、初筛与工单只在持「维护反馈单」的响应里有。 */
export interface FeedbackRow {
  readonly id: string;
  readonly channel: string;
  readonly content: string;
  readonly receivedAt: string;
  readonly status: 'open' | 'discarded';
  readonly customerName: string | null;
  readonly productName: string | null;
  readonly model: string | null;
  readonly batchNo: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly submitterName: string | null;
  readonly attachments: readonly FeedbackAttachment[];
  /** 端点算好的行级能力：本行能不能改、能不能丢弃。 */
  readonly canEdit: boolean;
  readonly canDiscard: boolean;
  readonly note?: string | null;
  readonly discardedBy?: string | null;
  readonly discardReason?: string | null;
  readonly screening?: FeedbackScreening;
  readonly ticket?: FeedbackTicket | null;
}

export interface FeedbackList {
  readonly items: readonly FeedbackRow[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
}

export interface FeedbackListQuery {
  readonly status?: 'open' | 'discarded';
  readonly pending?: boolean;
  readonly overdue?: boolean;
  readonly q?: string;
  readonly page?: number;
  readonly pageSize?: number;
}

export interface CreateFeedbackInput {
  readonly channel: 'web' | 'proxy';
  readonly customerName?: string;
  readonly senderName?: string;
  readonly senderContact?: string;
  readonly productName?: string;
  readonly model?: string;
  readonly batchNo?: string;
  readonly content: string;
  /** 上传成功后才填；上传没完成时表单不让提交。 */
  readonly attachmentIds?: readonly string[];
}

export interface UpdateFeedbackInput {
  readonly customerName?: string | null;
  readonly productName?: string | null;
  readonly model?: string | null;
  readonly batchNo?: string | null;
  readonly note?: string | null;
  readonly attachmentIds?: readonly string[];
}

export type DiscardReason = 'not-defect' | 'duplicate' | 'other';

/** S4 上传端点的响应：只有标识与文件元信息，没有内容地址。 */
export interface UploadedFeedbackFile {
  readonly id: string;
  readonly filename: string;
  readonly mimeType: string;
  readonly size: number;
}

function toList(payload: {
  data: FeedbackRow[];
  meta?: Record<string, unknown>;
}): FeedbackList {
  return {
    items: payload.data,
    total: (payload.meta?.total as number) ?? 0,
    page: (payload.meta?.page as number) ?? 1,
    pageSize: (payload.meta?.pageSize as number) ?? 20,
  };
}

/** 反馈单的读写客户端。新建走 `useSubmission` 拿幂等键，其余按端点契约不带键。 */
export class FeedbackClient {
  constructor(private readonly api: ApiClient) {}

  list(query: FeedbackListQuery = {}): Promise<FeedbackList> {
    return this.api
      .request<{ data: FeedbackRow[]; meta?: Record<string, unknown> }>({
        path: 'quality/feedbacks',
        query: Object.fromEntries(
          Object.entries(query).filter(([, value]) => value !== undefined && value !== ''),
        ),
      })
      .then(toList);
  }

  mine(query: FeedbackListQuery = {}): Promise<FeedbackList> {
    return this.api
      .request<{ data: FeedbackRow[]; meta?: Record<string, unknown> }>({
        path: 'quality/feedbacks/mine',
        query: Object.fromEntries(
          Object.entries(query).filter(([, value]) => value !== undefined && value !== ''),
        ),
      })
      .then(toList);
  }

  get(feedbackId: string): Promise<FeedbackRow> {
    return this.api
      .request<{ data: FeedbackRow }>({
        path: `quality/feedbacks/${encodeURIComponent(feedbackId)}`,
      })
      .then(({ data }) => data);
  }

  create(input: CreateFeedbackInput, idempotencyKey?: string): Promise<FeedbackRow> {
    return this.api
      .request<{ data: FeedbackRow }>({
        path: 'quality/feedbacks',
        method: 'POST',
        ...(idempotencyKey
          ? { headers: { 'Idempotency-Key': idempotencyKey } }
          : {}),
        json: input,
      })
      .then(({ data }) => data);
  }

  update(feedbackId: string, input: UpdateFeedbackInput): Promise<FeedbackRow> {
    return this.api
      .request<{ data: FeedbackRow }>({
        path: `quality/feedbacks/${encodeURIComponent(feedbackId)}`,
        method: 'PATCH',
        json: input,
      })
      .then(({ data }) => data);
  }

  discard(feedbackId: string, reason: DiscardReason): Promise<FeedbackRow> {
    return this.api
      .request<{ data: FeedbackRow }>({
        path: `quality/feedbacks/${encodeURIComponent(feedbackId)}/discard`,
        method: 'POST',
        json: { reason },
      })
      .then(({ data }) => data);
  }


  /** 表单提交之前上传一个附件：multipart，字段名 `file`。类型与大小由服务端判定。 */
  async upload(file: File): Promise<UploadedFeedbackFile> {
    const body = new FormData();
    body.append('file', file);
    const result = await this.api.request<{ data: UploadedFeedbackFile }>({
      path: 'quality/feedback-files',
      method: 'POST',
      body,
    });
    return result.data;
  }

}
