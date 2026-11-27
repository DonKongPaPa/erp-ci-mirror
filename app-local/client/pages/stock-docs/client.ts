import type { ApiClient } from '@nocobase/app-client';
import type { EntityPage } from '#components/erp/list-state';

export type DocType = 'in' | 'out';
export type DocStatus = 'draft' | 'posted' | 'void';
export type DocReason =
  | 'purchase_receipt'
  | 'sales_issue'
  | 'other_in'
  | 'other_out';
export type SourceType = 'purchase_order' | 'sales_order';

/** 一行明细，与 R-020 的 `StockDocLine` 逐列对应。 */
export interface StockDocLine {
  readonly id: string;
  readonly docId: string;
  readonly itemId: string;
  readonly warehouseId: string;
  /** 空串表示没有批号。 */
  readonly batchNo: string;
  readonly qty: number;
}

/** 单据头：列表的行不带明细。 */
export type StockDocSummary = Omit<StockDoc, 'lines'>;

/** 一张单据，与 R-020 的 `StockDoc` 逐列对应。建单人、过账人的标识不显示。 */
export interface StockDoc {
  readonly id: string;
  readonly docNo: string;
  readonly docType: DocType;
  readonly reason: DocReason;
  readonly status: DocStatus;
  readonly remark: string;
  readonly sourceType: SourceType | null;
  readonly sourceId: string | null;
  readonly createdById: string;
  readonly postedAt: string | null;
  readonly postedById: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lines: readonly StockDocLine[];
}

export interface StockLineInput {
  readonly itemId: string;
  readonly warehouseId: string;
  /** 省略即空串。 */
  readonly batchNo?: string;
  /** 大于 0，小数最多四位。 */
  readonly qty: number;
}

export interface CreateStockDocInput {
  readonly docType: DocType;
  readonly reason: DocReason;
  readonly remark?: string;
  readonly sourceType?: SourceType;
  readonly sourceId?: string;
  readonly lines: readonly StockLineInput[];
}

/** 改草稿：整单替换明细。来源单据的两项要么一起带、要么都不带，这里都不带（保持原样）。 */
export interface UpdateStockDocInput {
  readonly reason?: DocReason;
  readonly remark?: string;
  readonly sourceType?: SourceType;
  readonly sourceId?: string;
  readonly lines: readonly StockLineInput[];
}

export interface StockDocListQuery {
  readonly docType?: DocType;
  readonly status?: DocStatus;
  readonly q?: string;
  /** 带时区的 ISO 时间串，按创建时间过滤，含端点。 */
  readonly from?: string;
  readonly to?: string;
  readonly page?: number;
  readonly pageSize?: number;
}

/**
 * R-020 的单据六个端点。端点直接回一张单据或一页，没有 `{ data }` 外层。
 * 单据没有删除：草稿可以过账或作废，过了账或作废了的不能再改。
 */
export class StockDocsClient {
  constructor(private readonly api: ApiClient) {}

  list(query: StockDocListQuery = {}): Promise<EntityPage<StockDocSummary>> {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== '') search.set(key, String(value));
    }
    return this.api.request<EntityPage<StockDocSummary>>({
      path: `stock-docs?${search.toString()}`,
    });
  }

  /** 详情才带明细。 */
  get(id: string): Promise<StockDoc> {
    return this.api.request<StockDoc>({
      path: `stock-docs/${encodeURIComponent(id)}`,
    });
  }

  create(input: CreateStockDocInput): Promise<StockDoc> {
    return this.api.request<StockDoc>({
      path: 'stock-docs',
      method: 'POST',
      json: input,
    });
  }

  /** 只有草稿能改；带了明细就是整单替换。 */
  update(id: string, input: UpdateStockDocInput): Promise<StockDoc> {
    return this.api.request<StockDoc>({
      path: `stock-docs/${encodeURIComponent(id)}`,
      method: 'PATCH',
      json: input,
    });
  }

  /** 过账：库存立即增减，写流水。出库不够时整单回滚（`STOCK_INSUFFICIENT`）。 */
  post(id: string): Promise<StockDoc> {
    return this.api.request<StockDoc>({
      path: `stock-docs/${encodeURIComponent(id)}/post`,
      method: 'POST',
    });
  }

  /** 作废：只对草稿有效，不写流水。 */
  voidDoc(id: string): Promise<StockDoc> {
    return this.api.request<StockDoc>({
      path: `stock-docs/${encodeURIComponent(id)}/void`,
      method: 'POST',
    });
  }
}
