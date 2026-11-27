import type { ApiClient } from '@nocobase/app-client';

/**
 * R-017 M5：审批页面的端点客户端。形状照 `server/routes/approvals.ts` 与
 * `server/routes/approval-schemas.ts` 的真实响应，不做本地行级过滤 —— 资格由端点算。
 */
export interface ApprovalPage<T> {
  readonly data: readonly T[];
  readonly meta: { readonly page: number; readonly pageSize: number; readonly total: number };
}

export interface MineRow {
  readonly id: string;
  readonly status: string;
  readonly currentRound: number;
  readonly workflowKey: string;
  readonly collectionName: string;
  readonly dataKey: string;
  readonly lifecycleVersion: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface TaskRow {
  readonly id: string;
  readonly approvalId: string;
  readonly nodeKey: string;
  readonly status: string;
  readonly seq: number;
  readonly dueAt: string | null;
}

export interface RoundRow {
  readonly id: string;
  readonly approvalId: string;
  readonly round: number;
  readonly status: string;
  /** 提交快照：页面只显示键值，不解析业务含义。 */
  readonly snapshot: Record<string, unknown>;
  readonly startedAt: string;
  readonly endedAt: string | null;
}

export interface RecordRow {
  readonly id: string;
  /** 记录所属的轮次 id，页面据此把时间线按轮分组。 */
  readonly roundId: string;
  readonly nodeKey: string;
  readonly status: string;
  readonly seq: number;
  readonly origin: string;
  readonly assigneeName: string | null;
  readonly comment: string | null;
  readonly actedAt: string | null;
  readonly prevRecordId: string | null;
}

export interface ApprovalDetail {
  readonly id: string;
  readonly status: string;
  readonly currentRound: number;
  readonly lifecycleVersion: number;
  readonly workflowKey: string;
  readonly collectionName: string;
  readonly dataKey: string;
  readonly rounds: readonly RoundRow[];
  readonly records: readonly RecordRow[];
  /** 详情内嵌的可用动作（lifecycle 的手动转移名）。 */
  readonly available: readonly string[];
}

export interface CandidateRow {
  readonly id: string;
  readonly name: string | null;
  readonly username: string | null;
}

export interface ApprovalListQuery {
  readonly scope: string;
  readonly q?: string;
  readonly page: number;
  readonly pageSize: number;
  readonly sortBy: string;
  readonly sortDir: string;
}

export type ReviewAction = 'approve' | 'reject' | 'return' | 'delegate' | 'add-sign';

export type ApplicantAction = 'withdraw' | 'abort';

function queryOf(values: Record<string, string | number | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values))
    if (value !== undefined && value !== '') query.set(key, String(value));
  return query.toString();
}

export class ApprovalsClient {
  constructor(private readonly api: ApiClient) {}

  mine(query: ApprovalListQuery): Promise<ApprovalPage<MineRow>> {
    return this.api.request<ApprovalPage<MineRow>>({
      path: `approvals/mine?${queryOf({ ...query })}`,
    });
  }

  tasks(query: ApprovalListQuery): Promise<ApprovalPage<TaskRow>> {
    return this.api.request<ApprovalPage<TaskRow>>({
      path: `approvals/tasks?${queryOf({ ...query })}`,
    });
  }

  detail(id: string): Promise<ApprovalDetail> {
    return this.api
      .request<{ data: ApprovalDetail }>({ path: `approvals/${encodeURIComponent(id)}` })
      .then((body) => body.data);
  }

  candidates(
    taskId: string,
    type: 'delegate' | 'add',
    q: string,
  ): Promise<ApprovalPage<CandidateRow>> {
    return this.api.request<ApprovalPage<CandidateRow>>({
      path: `approvals/tasks/${encodeURIComponent(taskId)}/candidates?${queryOf({
        type,
        q,
        page: 1,
        pageSize: 20,
      })}`,
    });
  }

  review(
    taskId: string,
    action: ReviewAction,
    body: Record<string, unknown>,
  ): Promise<unknown> {
    return this.api.request({
      path: `approvals/tasks/${encodeURIComponent(taskId)}/${action}`,
      method: 'POST',
      json: body,
    });
  }

  applicant(id: string, action: ApplicantAction): Promise<unknown> {
    return this.api.request({
      path: `approvals/${encodeURIComponent(id)}/${action}`,
      method: 'POST',
    });
  }

  /** 退回后重新提交：PATCH 带 submit=true 由服务端开新轮次。 */
  resubmit(id: string, data: Record<string, unknown>): Promise<unknown> {
    return this.api.request({
      path: `approvals/${encodeURIComponent(id)}`,
      method: 'PATCH',
      json: { data, submit: true },
    });
  }
}
