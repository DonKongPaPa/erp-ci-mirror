import type { ApiClient } from '@nocobase/app-client';

import type { EntityPage } from '#components/erp/list-state';

/**
 * R-020 波 2：盘点单端点的客户端。端点直接回对象或一页，没有 `{ data }` 外层。
 * 仓库、经办人、监盘人只回标识与姓名，物料摘要不回价格；页面不补这些列。
 * 盈亏合计由服务端在结束时算，页面只回显逐行的 deltaQty 与 result。
 */

export type StocktakingStatus = 'staging' | 'finished' | 'void';
export type LineResult = 'balanced' | 'profit' | 'loss';

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
  readonly barcode: string | null;
}

export interface DocFile {
  readonly id: string;
  readonly name: string;
  readonly contentType: string;
  readonly size: number;
}

export interface StocktakingLine {
  readonly id: string;
  readonly itemId: string;
  /** 加行时服务端按 (itemId, warehouseId) 从现存量求和写的快照。 */
  readonly systemQty: number;
  readonly actualQty: number | null;
  readonly deltaQty: number | null;
  readonly result: LineResult | null;
  readonly note: string | null;
  readonly item: ItemSummary;
}

export interface Stocktaking {
  readonly id: string;
  readonly docNo: string;
  readonly docDate: string;
  readonly status: StocktakingStatus;
  readonly warehouse: Ref;
  readonly handler: PersonSummary | null;
  readonly supervisor: PersonSummary | null;
  readonly remark: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lines?: readonly StocktakingLine[];
  readonly files?: readonly DocFile[];
}

/** 列表行不带明细与附件。 */
export type StocktakingSummary = Omit<Stocktaking, 'lines' | 'files'>;

export interface StocktakingListQuery {
  readonly warehouseId?: string;
  readonly status?: StocktakingStatus;
  readonly from?: string;
  readonly to?: string;
  readonly q?: string;
  readonly page: number;
  readonly pageSize: number;
}

export interface LineInput {
  readonly itemId: string;
  readonly actualQty?: number | null;
  readonly note?: string | null;
}

export interface CreateStocktakingInput {
  readonly warehouseId: string;
  readonly handlerUserId?: string | null;
  readonly remark?: string;
  readonly fileIds?: readonly string[];
  readonly lines?: readonly LineInput[];
}

export interface UpdateStocktakingInput {
  readonly handlerUserId?: string | null;
  readonly remark?: string;
  readonly fileIds?: readonly string[];
  readonly lines?: readonly LineInput[];
}

export interface FinishInput {
  readonly supervisorUserId: string;
}

export interface FinishResult {
  readonly stocktaking: Stocktaking;
  readonly profitDocId: string | null;
  readonly lossDocId: string | null;
}

/** 出入库列表端点按 stocktakingId 反查出来的生成单摘要。 */
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

export class StocktakingClient {
  constructor(private readonly api: ApiClient) {}

  list(query: StocktakingListQuery): Promise<EntityPage<StocktakingSummary>> {
    return this.api.request<EntityPage<StocktakingSummary>>({
      path: `stocktakings?${searchOf(query)}`,
    });
  }

  detail(id: string): Promise<Stocktaking> {
    return this.api.request<Stocktaking>({
      path: `stocktakings/${encodeURIComponent(id)}`,
    });
  }

  create(input: CreateStocktakingInput): Promise<Stocktaking> {
    return this.api.request<Stocktaking>({
      path: 'stocktakings',
      method: 'POST',
      json: input,
    });
  }

  update(id: string, input: UpdateStocktakingInput): Promise<Stocktaking> {
    return this.api.request<Stocktaking>({
      path: `stocktakings/${encodeURIComponent(id)}`,
      method: 'PATCH',
      json: input,
    });
  }

  finish(id: string, input: FinishInput): Promise<FinishResult> {
    return this.api.request<FinishResult>({
      path: `stocktakings/${encodeURIComponent(id)}/finish`,
      method: 'POST',
      json: input,
    });
  }

  void(id: string): Promise<Stocktaking> {
    return this.api.request<Stocktaking>({
      path: `stocktakings/${encodeURIComponent(id)}/void`,
      method: 'POST',
    });
  }

  /** 反查本单生成的盘盈入库单与盘亏出库单；列表已按 docType 分开。 */
  generatedDocs(id: string, docType: 'in' | 'out'): Promise<EntityPage<GeneratedDocSummary>> {
    const query = searchOf({ stocktakingId: id, docType, pageSize: 100 });
    return this.api.request<EntityPage<GeneratedDocSummary>>({
      path: `stock-docs?${query}`,
    });
  }
}
