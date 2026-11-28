import type { ApiClient } from '@nocobase/app-client';

import type { DocFile } from '#components/erp/doc-files';
import type { EntityPage } from '#components/erp/list-state';

import type { LineInput } from '../orders/client.js';

/**
 * 报价单端点客户端（R-022 波 1 的七条端点）。形状照 `quotation-schemas.ts`：
 * 列表行不带明细，详情带；客户只回编码与名称，经办人只回标识与姓名。
 * 六个合计由服务端算，表单只录原始输入，页面不另算一套、也不把合计塞进请求体。
 */
export type QuotationStatus = 'draft' | 'confirmed' | 'converted' | 'void';

export interface QuotationItem {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly spec: string | null;
  readonly unitCode: string;
}

export interface QuotationLine {
  readonly id: string;
  readonly quotationId: string;
  readonly itemId: string;
  readonly qty: number;
  readonly price: number | null;
  readonly deliveryDate: string | null;
  readonly taxRate: number | null;
  readonly taxExcludedPrice: number | null;
  readonly taxExcludedAmount: number | null;
  readonly taxAmount: number | null;
  readonly taxIncludedAmount: number | null;
  readonly note: string | null;
  readonly item: QuotationItem;
}

export interface Quotation {
  readonly id: string;
  readonly docNo: string;
  readonly quoteDate: string;
  readonly validUntil: string | null;
  readonly status: QuotationStatus;
  readonly expired: boolean;
  readonly warehouse: { readonly id: string; readonly name: string } | null;
  readonly customer: {
    readonly id: string;
    readonly code: string;
    readonly name: string;
  } | null;
  readonly contactName: string | null;
  readonly contactPhone: string | null;
  readonly deliveryAddress: string | null;
  readonly projectCode: string | null;
  readonly projectLabel: string | null;
  readonly settlementCode: string | null;
  readonly settlementLabel: string | null;
  readonly customerOrderNo: string | null;
  readonly handler: { readonly userId: string; readonly name: string } | null;
  readonly discountAmount: number;
  readonly totalQty: number | null;
  readonly taxIncludedTotal: number | null;
  readonly taxExcludedTotal: number | null;
  readonly taxTotal: number | null;
  readonly payableTotal: number | null;
  readonly convertedOrderId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** 列表里不带，详情才是数组。 */
  readonly lines: readonly QuotationLine[];
  readonly files: readonly DocFile[];
}

export interface QuotationListQuery {
  readonly customerId?: string;
  readonly projectCode?: string;
  readonly status?: string;
  /** `YYYY-MM-DD`，按有效期至过滤。 */
  readonly validFrom?: string;
  readonly validTo?: string;
  readonly q?: string;
  readonly page?: number;
  readonly pageSize?: number;
}

export interface QuotationWriteFields {
  readonly quoteDate?: string;
  readonly validUntil?: string | null;
  readonly warehouseId?: string | null;
  readonly customerId?: string | null;
  readonly contactName?: string | null;
  readonly contactPhone?: string | null;
  readonly deliveryAddress?: string | null;
  readonly settlementCode?: string | null;
  readonly projectCode?: string | null;
  readonly customerOrderNo?: string | null;
  readonly handlerUserId?: string | null;
  readonly discountAmount?: number;
  readonly fileIds?: readonly string[];
}

export interface CreateQuotationInput extends QuotationWriteFields {
  readonly lines: readonly LineInput[];
}

/** 至少一项；改草稿时把可改的字段全带上。 */
export interface UpdateQuotationInput extends QuotationWriteFields {
  readonly lines?: readonly LineInput[];
}

export interface ConvertResult {
  readonly quotation: Quotation;
  readonly salesOrderId: string;
}

const enc = encodeURIComponent;

function writeFields(input: QuotationWriteFields): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries({
      quoteDate: input.quoteDate,
      validUntil: input.validUntil,
      warehouseId: input.warehouseId,
      customerId: input.customerId,
      contactName: input.contactName,
      contactPhone: input.contactPhone,
      deliveryAddress: input.deliveryAddress,
      settlementCode: input.settlementCode,
      projectCode: input.projectCode,
      customerOrderNo: input.customerOrderNo,
      handlerUserId: input.handlerUserId,
      discountAmount: input.discountAmount,
      fileIds: input.fileIds === undefined ? undefined : [...input.fileIds],
    }).filter(([, value]) => value !== undefined),
  );
}

function lineFields(line: LineInput): Record<string, unknown> {
  return {
    itemId: line.itemId,
    qty: line.qty,
    ...Object.fromEntries(
      Object.entries({
        price: line.price,
        deliveryDate: line.deliveryDate,
        taxRate: line.taxRate,
        taxExcludedPrice: line.taxExcludedPrice,
        note: line.note,
      }).filter(([, value]) => value !== undefined),
    ),
  };
}

export class QuotationsClient {
  constructor(private readonly api: ApiClient) {}

  list(query: QuotationListQuery = {}): Promise<EntityPage<Quotation>> {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(query))
      if (value !== undefined && value !== '') search.set(key, String(value));
    return this.api.request<EntityPage<Quotation>>({
      path: `quotations?${search.toString()}`,
    });
  }

  get(id: string): Promise<Quotation> {
    return this.api.request<Quotation>({ path: `quotations/${enc(id)}` });
  }

  create(input: CreateQuotationInput): Promise<Quotation> {
    return this.api.request<Quotation>({
      path: 'quotations',
      method: 'POST',
      json: { ...writeFields(input), lines: input.lines.map(lineFields) },
    });
  }

  /** 只有草稿能改；带了状态、单号、合计这些服务端列会被剥掉。 */
  update(id: string, input: UpdateQuotationInput): Promise<Quotation> {
    return this.api.request<Quotation>({
      path: `quotations/${enc(id)}`,
      method: 'PATCH',
      json: {
        ...writeFields(input),
        ...(input.lines === undefined ? {} : { lines: input.lines.map(lineFields) }),
      },
    });
  }

  confirm(id: string): Promise<Quotation> {
    return this.api.request<Quotation>({
      path: `quotations/${enc(id)}/confirm`,
      method: 'POST',
    });
  }

  /** 确定后手动全量转一次；返回生成的草稿销售订单 id。 */
  createSalesOrder(id: string): Promise<ConvertResult> {
    return this.api.request<ConvertResult>({
      path: `quotations/${enc(id)}/create-sales-order`,
      method: 'POST',
    });
  }

  void(id: string): Promise<Quotation> {
    return this.api.request<Quotation>({
      path: `quotations/${enc(id)}/void`,
      method: 'POST',
    });
  }
}
