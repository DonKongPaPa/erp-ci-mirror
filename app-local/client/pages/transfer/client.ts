import type { ApiClient } from '@nocobase/app-client';

import type { EntityPage } from '#components/erp/list-state';

/**
 * R-020 波 2：调拨单端点的客户端。端点直接回对象或一页，没有 `{ data }` 外层。
 * 仓库、经办人只回标识与姓名，物料摘要不回价格；页面不补这些列。
 */

export type TransferStatus = 'draft' | 'posted' | 'void';

export interface PersonSummary {
  readonly userId: string;
  readonly name: string;
}

export interface Ref {
  readonly id: string;
  readonly name: string;
}

export interface ItemSummary {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly spec: string | null;
  readonly unitCode: string;
}

export interface DocFile {
  readonly id: string;
  readonly name: string;
  readonly contentType: string;
  readonly size: number;
}

export interface TransferLine {
  readonly id: string;
  readonly itemId: string;
  /** 申请数量。 */
  readonly qty: number;
  /** 实调数量：过账用这一列。 */
  readonly transferQty: number | null;
  readonly note: string | null;
  readonly item: ItemSummary;
}

export interface Transfer {
  readonly id: string;
  readonly docNo: string;
  readonly docDate: string | null;
  readonly status: TransferStatus;
  readonly warehouseIn: Ref;
  readonly warehouseOut: Ref | null;
  readonly handler: PersonSummary | null;
  readonly remark: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lines?: readonly TransferLine[];
  readonly files?: readonly DocFile[];
}

/** 列表行不带明细与附件。 */
export type TransferSummary = Omit<Transfer, 'lines' | 'files'>;

export interface TransferListQuery {
  readonly transferInWarehouseId?: string;
  readonly transferOutWarehouseId?: string;
  readonly status?: TransferStatus;
  readonly from?: string;
  readonly to?: string;
  readonly q?: string;
  readonly page: number;
  readonly pageSize: number;
}

export interface LineInput {
  readonly itemId: string;
  readonly qty: number;
  readonly transferQty?: number;
  readonly note?: string | null;
}

export interface CreateTransferInput {
  readonly transferInWarehouseId: string;
  readonly transferOutWarehouseId?: string | null;
  readonly docDate?: string | null;
  readonly handlerUserId?: string | null;
  readonly remark?: string;
  readonly fileIds?: readonly string[];
  readonly lines: readonly LineInput[];
}

export interface UpdateTransferInput {
  readonly transferInWarehouseId?: string;
  readonly transferOutWarehouseId?: string | null;
  readonly docDate?: string | null;
  readonly handlerUserId?: string | null;
  readonly remark?: string;
  readonly fileIds?: readonly string[];
  readonly lines?: readonly LineInput[];
}

export interface PostResult {
  readonly transfer: Transfer;
  readonly outDocId: string | null;
  readonly inDocId: string;
}

/** 出入库列表端点按 transferDocId 反查出来的生成单摘要。 */
export interface GeneratedDocSummary {
  readonly id: string;
  readonly docNo: string;
  readonly docType: 'in' | 'out';
  readonly reason: string;
  readonly status: string;
  readonly docDate?: string | null;
}

function searchOf(query: object): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== '') search.set(key, String(value));
  }
  return search.toString();
}

/** 生成单在两张出入库列表里的父路径。 */
export const DOC_BASE: Readonly<Record<'in' | 'out', string>> = {
  in: '/inbound-orders',
  out: '/outbound-orders',
};

export class TransferClient {
  constructor(private readonly api: ApiClient) {}

  list(query: TransferListQuery): Promise<EntityPage<TransferSummary>> {
    return this.api.request<EntityPage<TransferSummary>>({
      path: `transfers?${searchOf(query)}`,
    });
  }

  detail(id: string): Promise<Transfer> {
    return this.api.request<Transfer>({
      path: `transfers/${encodeURIComponent(id)}`,
    });
  }

  create(input: CreateTransferInput): Promise<Transfer> {
    return this.api.request<Transfer>({
      path: 'transfers',
      method: 'POST',
      json: input,
    });
  }

  update(id: string, input: UpdateTransferInput): Promise<Transfer> {
    return this.api.request<Transfer>({
      path: `transfers/${encodeURIComponent(id)}`,
      method: 'PATCH',
      json: input,
    });
  }

  post(id: string): Promise<PostResult> {
    return this.api.request<PostResult>({
      path: `transfers/${encodeURIComponent(id)}/post`,
      method: 'POST',
    });
  }

  void(id: string): Promise<Transfer> {
    return this.api.request<Transfer>({
      path: `transfers/${encodeURIComponent(id)}/void`,
      method: 'POST',
    });
  }

  /** 反查本单生成的调出出库单与调入入库单。 */
  generatedDocs(id: string): Promise<EntityPage<GeneratedDocSummary>> {
    const query = searchOf({ transferDocId: id, pageSize: 100 });
    return this.api.request<EntityPage<GeneratedDocSummary>>({
      path: `stock-docs?${query}`,
    });
  }
}
