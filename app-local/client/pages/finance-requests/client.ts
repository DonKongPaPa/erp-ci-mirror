import type { ApiClient } from '@nocobase/app-client';

import type { EntityPage } from '#components/erp/list-state';

/**
 * R-066 请款 / 报销端点的客户端。端点直接回对象或一页，没有 `{ data }` 外层。
 * 人员只回标识与姓名、类型与项目回码和名称、附件只回摘要；页面不补电话、邮箱或存储键。
 * 行级范围由服务端按授权算，这里不做本地过滤。
 */

export type RequestDocType = 'payment_request' | 'expense_claim';
export type RequestStatus =
  | 'draft'
  | 'approving'
  | 'approved'
  | 'rejected'
  | 'void'
  | 'converted';

export interface RequestFile {
  readonly id: string;
  readonly name: string;
  readonly contentType: string;
  readonly size: number;
}

export interface RequestPerson {
  readonly userId: string;
  readonly name: string;
}

export interface FinanceRequest {
  readonly id: string;
  readonly docType: RequestDocType;
  readonly docNo: string;
  readonly requestDate: string;
  readonly status: RequestStatus;
  readonly expenseTypeCode: string | null;
  readonly expenseTypeLabel: string | null;
  readonly amount: number;
  readonly reason: string;
  readonly handler: RequestPerson;
  readonly projectCode: string | null;
  readonly projectLabel: string | null;
  readonly approvalId: string | null;
  readonly expenseRecordId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly files: readonly RequestFile[];
}

/** 列表行不带附件。 */
export type RequestSummary = Omit<FinanceRequest, 'files'>;

export interface RequestListQuery {
  readonly docType?: RequestDocType;
  readonly status?: RequestStatus;
  readonly expenseTypeCode?: string;
  readonly projectCode?: string;
  readonly from?: string;
  readonly to?: string;
  readonly page: number;
  readonly pageSize: number;
}

export interface CreateFinanceRequestInput {
  readonly docType: RequestDocType;
  readonly requestDate?: string;
  readonly expenseTypeCode?: string;
  readonly amount: number;
  readonly reason?: string;
  readonly handlerUserId?: string;
  readonly projectCode?: string;
  readonly fileIds?: readonly string[];
}

export interface UpdateFinanceRequestInput {
  readonly requestDate?: string;
  readonly expenseTypeCode?: string | null;
  readonly amount?: number;
  readonly reason?: string;
  readonly handlerUserId?: string;
  readonly projectCode?: string | null;
  readonly fileIds?: readonly string[];
}

export interface ConvertedRequest {
  readonly request: FinanceRequest;
  readonly expenseRecordId: string;
}

function searchOf(query: object): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== '') search.set(key, String(value));
  }
  return search.toString();
}

export class FinanceRequestsClient {
  constructor(private readonly api: ApiClient) {}

  list(query: RequestListQuery): Promise<EntityPage<RequestSummary>> {
    return this.api.request<EntityPage<RequestSummary>>({
      path: `finance-requests?${searchOf(query)}`,
    });
  }

  detail(id: string): Promise<FinanceRequest> {
    return this.api.request<FinanceRequest>({
      path: `finance-requests/${encodeURIComponent(id)}`,
    });
  }

  create(input: CreateFinanceRequestInput): Promise<FinanceRequest> {
    return this.api.request<FinanceRequest>({
      path: 'finance-requests',
      method: 'POST',
      json: input,
    });
  }

  update(id: string, input: UpdateFinanceRequestInput): Promise<FinanceRequest> {
    return this.api.request<FinanceRequest>({
      path: `finance-requests/${encodeURIComponent(id)}`,
      method: 'PATCH',
      json: input,
    });
  }

  submit(id: string): Promise<FinanceRequest> {
    return this.api.request<FinanceRequest>({
      path: `finance-requests/${encodeURIComponent(id)}/submit`,
      method: 'POST',
    });
  }

  void(id: string): Promise<FinanceRequest> {
    return this.api.request<FinanceRequest>({
      path: `finance-requests/${encodeURIComponent(id)}/void`,
      method: 'POST',
    });
  }

  createExpense(id: string): Promise<ConvertedRequest> {
    return this.api.request<ConvertedRequest>({
      path: `finance-requests/${encodeURIComponent(id)}/create-expense`,
      method: 'POST',
    });
  }
}
