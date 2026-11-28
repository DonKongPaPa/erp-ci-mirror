import type { ApiClient } from '@nocobase/app-client';

import type { DocFile } from '#components/erp/doc-files';
import type { EntityPage } from '#components/erp/list-state';

export type DocType = 'in' | 'out';
export type DocStatus = 'draft' | 'posted' | 'void';
/** R-020 加片：八种出入库原因。 */
export type DocReason =
  | 'purchase_receipt'
  | 'production_receipt'
  | 'sales_return'
  | 'other_in'
  | 'sales_issue'
  | 'internal_use'
  | 'purchase_return'
  | 'other_out';
export type SourceType = 'purchase_order' | 'sales_order';

/** 人员摘要只回标识与姓名；部门只回标识与名称。 */
export interface PersonSummary {
  readonly userId: string;
  readonly name: string;
}
export interface DepartmentSummary {
  readonly id: string;
  readonly name: string;
}
export interface PartnerSummary {
  readonly id: string;
  readonly code: string;
  readonly name: string;
}

/** 一行明细，与 R-020 加片的 `StockDocLine` 逐列对应。 */
export interface StockDocLine {
  readonly id: string;
  readonly docId: string;
  readonly itemId: string;
  readonly warehouseId: string;
  /** 空串表示没有批号。 */
  readonly batchNo: string;
  readonly qty: number;
  readonly taxIncludedPrice?: number | null;
  readonly taxExcludedPrice?: number | null;
  readonly taxRate?: number | null;
  readonly taxExcludedAmount?: number | null;
  readonly taxAmount?: number | null;
  readonly taxIncludedAmount?: number | null;
  readonly productionDate?: string | null;
  readonly expiryDate?: string | null;
  readonly note?: string | null;
}

/** 单据头：列表的行不带明细。 */
export type StockDocSummary = Omit<StockDoc, 'lines'>;

/** 一张单据，与 R-020 加片的 `StockDoc` 对应。建单人、过账人的标识不显示。 */
export interface StockDoc {
  readonly id: string;
  readonly docNo: string;
  readonly docType: DocType;
  readonly reason: DocReason;
  readonly status: DocStatus;
  readonly remark: string;
  readonly sourceType: SourceType | null;
  readonly sourceId: string | null;
  /** R-070：采购入库单来自哪张检验单；老单据没有这个键。 */
  readonly inspectionId?: string | null;
  readonly createdById: string;
  readonly postedAt: string | null;
  readonly postedById: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lines: readonly StockDocLine[];
  readonly docDate?: string | null;
  readonly partnerId?: string | null;
  readonly partner?: PartnerSummary | null;
  readonly contactName?: string | null;
  readonly contactPhone?: string | null;
  readonly deliveryAddress?: string | null;
  readonly customerOrderNo?: string | null;
  readonly projectCode?: string | null;
  readonly projectLabel?: string | null;
  readonly handlerUserId?: string | null;
  readonly handler?: PersonSummary | null;
  readonly takerDepartmentId?: string | null;
  readonly takerUserId?: string | null;
  readonly taker?: PersonSummary | null;
  readonly takerDepartment?: DepartmentSummary | null;
  readonly discountAmount?: number | null;
  readonly totalQty?: number | null;
  readonly taxIncludedTotal?: number | null;
  readonly taxExcludedTotal?: number | null;
  readonly taxTotal?: number | null;
  readonly payableTotal?: number | null;
  readonly files?: readonly DocFile[];
}

export interface StockLineInput {
  readonly itemId: string;
  readonly warehouseId: string;
  /** 省略即空串。 */
  readonly batchNo?: string;
  /** 大于 0，小数最多四位。 */
  readonly qty: number;
  /** R-070：带检验单建采购入库时指到检验明细行；普通入库不传。 */
  readonly inspectionLineId?: string;
  readonly taxIncludedPrice?: number | null;
  readonly taxExcludedPrice?: number | null;
  readonly taxRate?: number | null;
  readonly productionDate?: string | null;
  readonly expiryDate?: string | null;
  readonly note?: string | null;
}

/** 加片的可选键：空串不发送，null 用来清空老单据里已存的值。 */
export interface StockWriteFields {
  readonly docDate?: string | null;
  readonly partnerId?: string | null;
  readonly contactName?: string | null;
  readonly contactPhone?: string | null;
  readonly deliveryAddress?: string | null;
  readonly customerOrderNo?: string | null;
  readonly projectCode?: string | null;
  readonly handlerUserId?: string | null;
  readonly takerDepartmentId?: string | null;
  readonly takerUserId?: string | null;
  readonly discountAmount?: number | null;
  readonly fileIds?: readonly string[];
}

export interface CreateStockDocInput extends StockWriteFields {
  readonly docType: DocType;
  readonly reason: DocReason;
  readonly remark?: string;
  readonly sourceType?: SourceType | null;
  readonly sourceId?: string | null;
  /** R-070：只对 reason=purchase_receipt 生效；不带这个键的请求逐字节照旧。 */
  readonly inspectionId?: string;
  readonly lines: readonly StockLineInput[];
}

/** 改草稿：整单替换明细。 */
export interface UpdateStockDocInput extends StockWriteFields {
  readonly reason?: DocReason;
  readonly remark?: string;
  readonly sourceType?: SourceType | null;
  readonly sourceId?: string | null;
  readonly lines: readonly StockLineInput[];
}

export interface StockDocListQuery {
  readonly docType?: DocType;
  readonly status?: DocStatus;
  readonly q?: string;
  readonly reason?: DocReason;
  readonly partnerId?: string;
  readonly projectCode?: string;
  readonly handlerUserId?: string;
  readonly takerDepartmentId?: string;
  /** 带时区的 ISO 时间串，按创建时间过滤，含端点。 */
  readonly from?: string;
  readonly to?: string;
  readonly dateField?: string;
  readonly page?: number;
  readonly pageSize?: number;
}

/** 只把有值的键带过去，老客户端的请求体与加片前一致。 */
function optional<T>(values: Record<string, T | undefined>): Record<string, T> {
  return Object.fromEntries(
    Object.entries(values).filter(([, value]) => value !== undefined && value !== ''),
  ) as Record<string, T>;
}

function writeFields(input: StockWriteFields): Record<string, unknown> {
  return optional({
    docDate: input.docDate,
    partnerId: input.partnerId,
    contactName: input.contactName,
    contactPhone: input.contactPhone,
    deliveryAddress: input.deliveryAddress,
    customerOrderNo: input.customerOrderNo,
    projectCode: input.projectCode,
    handlerUserId: input.handlerUserId,
    takerDepartmentId: input.takerDepartmentId,
    takerUserId: input.takerUserId,
    discountAmount: input.discountAmount,
    fileIds: input.fileIds,
  });
}

function lineFields(line: StockLineInput): Record<string, unknown> {
  return {
    itemId: line.itemId,
    warehouseId: line.warehouseId,
    batchNo: line.batchNo,
    qty: line.qty,
    // 只有选了检验单的行才带；普通入库的请求体没有这个键。
    ...(line.inspectionLineId ? { inspectionLineId: line.inspectionLineId } : {}),
    ...optional({
      taxIncludedPrice: line.taxIncludedPrice,
      taxExcludedPrice: line.taxExcludedPrice,
      taxRate: line.taxRate,
      productionDate: line.productionDate,
      expiryDate: line.expiryDate,
      note: line.note,
    }),
  };
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
      json: {
        docType: input.docType,
        reason: input.reason,
        remark: input.remark,
        ...(input.sourceType && input.sourceId
          ? { sourceType: input.sourceType, sourceId: input.sourceId }
          : {}),
        // 不带检验单时不出现这个键，老请求逐字节不变。
        ...(input.inspectionId ? { inspectionId: input.inspectionId } : {}),
        ...writeFields(input),
        lines: input.lines.map(lineFields),
      },
    });
  }

  /** 只有草稿能改；带了明细就是整单替换。 */
  update(id: string, input: UpdateStockDocInput): Promise<StockDoc> {
    return this.api.request<StockDoc>({
      path: `stock-docs/${encodeURIComponent(id)}`,
      method: 'PATCH',
      json: {
        ...(input.reason === undefined ? {} : { reason: input.reason }),
        ...(input.remark === undefined ? {} : { remark: input.remark }),
        ...(input.sourceType && input.sourceId
          ? { sourceType: input.sourceType, sourceId: input.sourceId }
          : {}),
        ...writeFields(input),
        lines: input.lines.map(lineFields),
      },
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
