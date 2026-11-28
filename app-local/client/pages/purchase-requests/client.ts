import type { ApiClient } from '@nocobase/app-client';

import type { EntityPage } from '#components/erp/list-state';

/**
 * R-021 波 1 请购单端点的客户端。端点直接回对象或一页，没有 `{ data }` 外层。
 * 人员只回标识与姓名，部门只回标识与名称，物料摘要不回基准价；页面不补这些列。
 * 表尾合计由服务端算，这里只把 `totalQty` / `estimatedTotal` 原样带回来。
 */

export type RequestStatus =
  | 'draft'
  | 'approving'
  | 'approved'
  | 'rejected'
  | 'void'
  | 'converted';

export interface ItemSummary {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly spec: string | null;
  readonly unitCode: string;
}

export interface RequestLine {
  readonly id: string;
  readonly itemId: string;
  readonly qty: number;
  readonly expectedPrice: number | null;
  readonly expectedAmount: number | null;
  readonly item: ItemSummary;
}

export interface RequestFile {
  readonly id: string;
  readonly name: string;
  readonly contentType: string;
  readonly size: number;
}

export interface RequestDepartment {
  readonly id: string;
  readonly name: string;
}

export interface RequestPerson {
  readonly userId: string;
  readonly name: string;
}

export interface PurchaseRequest {
  readonly id: string;
  readonly docNo: string;
  readonly requestDate: string;
  readonly status: RequestStatus;
  readonly department: RequestDepartment;
  readonly requester: RequestPerson;
  readonly projectCode: string | null;
  readonly projectLabel: string | null;
  readonly customText1: string | null;
  readonly customText2: string | null;
  readonly description: string;
  readonly approvalId: string | null;
  readonly convertedOrderId: string | null;
  readonly totalQty: number | null;
  readonly estimatedTotal: number | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lines: readonly RequestLine[];
  readonly files: readonly RequestFile[];
}

/** 列表行不带明细与附件。 */
export type RequestSummary = Omit<PurchaseRequest, 'lines' | 'files'>;

export interface RequestListQuery {
  readonly departmentId?: string;
  readonly projectCode?: string;
  readonly status?: RequestStatus;
  readonly from?: string;
  readonly to?: string;
  readonly page: number;
  readonly pageSize: number;
}

export interface LineInput {
  readonly itemId: string;
  readonly qty: number;
  readonly expectedPrice?: number | null;
}

export interface CreateRequestInput {
  readonly requestDate?: string;
  readonly departmentId: string;
  readonly requesterUserId?: string;
  readonly projectCode?: string;
  readonly customText1?: string;
  readonly customText2?: string;
  readonly description?: string;
  readonly fileIds?: readonly string[];
}

export interface UpdateRequestInput {
  readonly requestDate?: string;
  readonly departmentId?: string;
  readonly requesterUserId?: string;
  readonly projectCode?: string | null;
  readonly customText1?: string | null;
  readonly customText2?: string | null;
  readonly description?: string;
  readonly fileIds?: readonly string[];
}

export interface SetLinesInput {
  readonly lines: readonly LineInput[];
  readonly replace?: boolean;
}

export interface ConvertedOrder {
  readonly request: PurchaseRequest;
  readonly purchaseOrderId: string;
}

function searchOf(query: object): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== '') search.set(key, String(value));
  }
  return search.toString();
}

export class PurchaseRequestsClient {
  constructor(private readonly api: ApiClient) {}

  list(query: RequestListQuery): Promise<EntityPage<RequestSummary>> {
    return this.api.request<EntityPage<RequestSummary>>({
      path: `purchase-requests?${searchOf(query)}`,
    });
  }

  detail(id: string): Promise<PurchaseRequest> {
    return this.api.request<PurchaseRequest>({
      path: `purchase-requests/${encodeURIComponent(id)}`,
    });
  }

  create(input: CreateRequestInput): Promise<PurchaseRequest> {
    return this.api.request<PurchaseRequest>({
      path: 'purchase-requests',
      method: 'POST',
      json: input,
    });
  }

  update(id: string, input: UpdateRequestInput): Promise<PurchaseRequest> {
    return this.api.request<PurchaseRequest>({
      path: `purchase-requests/${encodeURIComponent(id)}`,
      method: 'PATCH',
      json: input,
    });
  }

  setLines(id: string, input: SetLinesInput): Promise<PurchaseRequest> {
    return this.api.request<PurchaseRequest>({
      path: `purchase-requests/${encodeURIComponent(id)}/lines`,
      method: 'POST',
      json: input,
    });
  }

  submit(id: string): Promise<PurchaseRequest> {
    return this.api.request<PurchaseRequest>({
      path: `purchase-requests/${encodeURIComponent(id)}/submit`,
      method: 'POST',
    });
  }

  void(id: string): Promise<PurchaseRequest> {
    return this.api.request<PurchaseRequest>({
      path: `purchase-requests/${encodeURIComponent(id)}/void`,
      method: 'POST',
    });
  }

  createOrder(id: string): Promise<ConvertedOrder> {
    return this.api.request<ConvertedOrder>({
      path: `purchase-requests/${encodeURIComponent(id)}/create-order`,
      method: 'POST',
    });
  }
}
