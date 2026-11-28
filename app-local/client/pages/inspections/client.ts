import type { ApiClient } from '@nocobase/app-client';

import type { EntityPage } from '#components/erp/list-state';

/**
 * R-070 检验单端点的客户端。端点直接回对象或一页，没有 `{ data }` 外层。
 * 四个算列（不合格、可入库、退货）由服务端算，请求体只送原始输入；
 * 人员只回标识与姓名，供应商与采购单都只是摘要，物料摘要不回单价。
 */

export type InspectionStatus =
  | 'pending' | 'passed' | 'partial' | 'failed' | 'void';
export type InspectionTypeCode = 'full' | 'sampling' | 'exempt';

export interface ItemSummary {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly spec: string | null;
  readonly unitCode: string;
}
export interface PersonSummary { readonly userId: string; readonly name: string; }
export interface SupplierSummary {
  readonly id: string; readonly code: string; readonly name: string;
}
export interface OrderSummary {
  readonly id: string; readonly orderNo: string; readonly orderDate: string;
}
export interface InspectionFile {
  readonly id: string; readonly name: string; readonly contentType: string;
  readonly size: number;
}

export interface InspectionLine {
  readonly id: string;
  readonly itemId: string;
  readonly item: ItemSummary;
  readonly purchaseQty: number;
  readonly inspectionTypeCode: InspectionTypeCode;
  readonly receivedQty: number;
  readonly inspectionQty: number;
  readonly qualifiedQty: number;
  readonly unqualifiedQty: number;
  readonly releasableQty: number;
  readonly returnQty: number;
  readonly samplingQty: number;
  readonly samplingQualifiedQty: number;
  readonly lossQty: number;
  readonly retainedQty: number;
  readonly note: string | null;
}

export interface InspectionOrder {
  readonly id: string;
  readonly docNo: string;
  readonly inspectionDate: string;
  readonly status: InspectionStatus;
  readonly purchaseOrder: OrderSummary;
  readonly supplier: SupplierSummary | null;
  readonly inspector: PersonSummary | null;
  readonly remark: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lines: readonly InspectionLine[];
  readonly files: readonly InspectionFile[];
}

/** 列表行不带明细与附件。 */
export type InspectionSummary = Omit<InspectionOrder, 'lines' | 'files'>;

export interface InspectionListQuery {
  readonly status?: InspectionStatus;
  readonly purchaseOrderId?: string;
  readonly supplierId?: string;
  readonly inspectorUserId?: string;
  readonly from?: string;
  readonly to?: string;
  readonly q?: string;
  readonly page: number;
  readonly pageSize: number;
}

/** 新建选单数据源：只回可检订单与行，授权走 inspectionOrders.view。 */
export interface OrderOptionLine {
  readonly itemId: string;
  readonly item: ItemSummary;
  readonly purchaseQty: number;
  readonly receivedRemainQty: number;
}
export interface OrderOption {
  readonly id: string;
  readonly orderNo: string;
  readonly orderDate: string;
  readonly supplier: SupplierSummary | null;
  readonly lines: readonly OrderOptionLine[];
}
export interface OrderOptionsQuery {
  readonly q?: string;
  readonly page: number;
  readonly pageSize: number;
}

export interface InspectionLineInput {
  readonly itemId: string;
  readonly inspectionTypeCode: InspectionTypeCode;
  readonly receivedQty: number;
  readonly inspectionQty: number;
  readonly qualifiedQty: number;
  readonly samplingQty: number;
  readonly samplingQualifiedQty: number;
  readonly lossQty?: number;
  readonly retainedQty?: number;
  readonly note?: string;
}

export interface CreateInspectionInput {
  readonly inspectionDate?: string;
  readonly purchaseOrderId: string;
  readonly inspectorUserId?: string;
  readonly remark?: string;
  readonly fileIds?: readonly string[];
  readonly lines: readonly InspectionLineInput[];
}
export interface UpdateInspectionInput {
  readonly inspectionDate?: string;
  readonly inspectorUserId?: string;
  readonly remark?: string;
  readonly fileIds?: readonly string[];
  readonly lines?: readonly InspectionLineInput[];
}

/** 仓管建采购入库单时选检验单用的窄形状（receiveView）。 */
export interface ReceivableLine {
  readonly inspectionLineId: string;
  readonly itemId: string;
  readonly warehouseId: string;
  readonly batchNo: string;
  readonly releasableQty: number;
  readonly remainQty: number;
}
export interface ReceivableInspection {
  readonly id: string;
  readonly docNo: string;
  readonly inspectionDate: string;
  readonly status: 'passed' | 'partial';
  readonly purchaseOrderId: string;
  readonly lines: readonly ReceivableLine[];
}
export interface ReceivableQuery {
  readonly purchaseOrderId?: string;
  readonly q?: string;
  readonly page: number;
  readonly pageSize: number;
}

function searchOf(query: object): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== '') search.set(key, String(value));
  }
  return search.toString();
}

export class InspectionsClient {
  constructor(private readonly api: ApiClient) {}

  list(query: InspectionListQuery): Promise<EntityPage<InspectionSummary>> {
    return this.api.request<EntityPage<InspectionSummary>>({
      path: `inspections?${searchOf(query)}`,
    });
  }

  detail(id: string): Promise<InspectionOrder> {
    return this.api.request<InspectionOrder>({
      path: `inspections/${encodeURIComponent(id)}`,
    });
  }

  create(input: CreateInspectionInput): Promise<InspectionOrder> {
    return this.api.request<InspectionOrder>({
      path: 'inspections',
      method: 'POST',
      json: input,
    });
  }

  update(id: string, input: UpdateInspectionInput): Promise<InspectionOrder> {
    return this.api.request<InspectionOrder>({
      path: `inspections/${encodeURIComponent(id)}`,
      method: 'PATCH',
      json: input,
    });
  }

  complete(id: string): Promise<InspectionOrder> {
    return this.api.request<InspectionOrder>({
      path: `inspections/${encodeURIComponent(id)}/complete`,
      method: 'POST',
    });
  }

  void(id: string): Promise<InspectionOrder> {
    return this.api.request<InspectionOrder>({
      path: `inspections/${encodeURIComponent(id)}/void`,
      method: 'POST',
    });
  }

  orderOptions(query: OrderOptionsQuery): Promise<EntityPage<OrderOption>> {
    return this.api.request<EntityPage<OrderOption>>({
      path: `inspections/order-options?${searchOf(query)}`,
    });
  }

  /** 仓管从检验单选可入库行，窄读；响应里没有备注、检验人、单价。 */
  receivable(query: ReceivableQuery): Promise<EntityPage<ReceivableInspection>> {
    return this.api.request<EntityPage<ReceivableInspection>>({
      path: `inspections/receivable-options?${searchOf(query)}`,
    });
  }
}
