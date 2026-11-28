import type { ApiClient } from '@nocobase/app-client';

import type { DocFile } from '#components/erp/doc-files';
import type { EntityPage } from '#components/erp/list-state';

import type { OrderKindDef, OrderStatus } from './kinds.js';

/**
 * 采购订单与销售订单的端点客户端（R-021、R-022 的接口契约，含波 0 加片）。两边同形，字段名不同：
 * 这里把端点的形状换成页面共用的形状（`partnerId`、`doneQty`、`status` 的五个值），
 * 页面代码就不用分采购与销售。端点直接回对象或一页，没有 `{ data }` 外层。
 *
 * 金额与合计都由服务端算；没有 `viewPrice` 的会话响应里根本没有这些键，
 * 页面按「键不在就不画」处理，不能拿空值当 0。
 */

/** 详情里的往来单位摘要，刻意只有这四列。 */
export interface OrderPartner {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly status: 'active' | 'inactive';
}

/** 人员只回标识与姓名，没有电话、邮箱、工号。 */
export interface PersonSummary {
  readonly userId: string;
  readonly name: string;
}

export interface OrderLine {
  readonly id: string;
  readonly itemId: string;
  readonly qty: number;
  readonly price?: number | null;
  /** 已到货（销售是已发货）数量，由库存过账回写。 */
  readonly doneQty: number;
  /** 未到货（未发货）数量：订单数量减去未作废出入库单已生成的数量。 */
  readonly remainingQty: number;
  readonly deliveryDate?: string | null;
  readonly taxRate?: number | null;
  readonly taxExcludedPrice?: number | null;
  readonly taxExcludedAmount?: number | null;
  readonly taxAmount?: number | null;
  readonly taxIncludedAmount?: number | null;
  readonly note?: string | null;
}

/** 波 0 加片的表头列；老单据没有这些键时它们都是 `undefined`。 */
export interface OrderHeaderFields {
  readonly warehouseId?: string | null;
  readonly contactName?: string | null;
  readonly contactPhone?: string | null;
  readonly deliveryAddress?: string | null;
  readonly settlementCode?: string | null;
  readonly settlementLabel?: string | null;
  readonly projectCode?: string | null;
  readonly projectLabel?: string | null;
  readonly customerOrderNo?: string | null;
  readonly handlerUserId?: string | null;
  readonly handler?: PersonSummary | null;
  readonly discountAmount?: number | null;
  readonly totalQty?: number | null;
  readonly taxIncludedTotal?: number | null;
  readonly taxExcludedTotal?: number | null;
  readonly taxTotal?: number | null;
  readonly payableTotal?: number | null;
  readonly latestDeliveryDate?: string | null;
  readonly paidAmount?: number | null;
  /** R-065 第二片：销售订单详情的已收金额，服务端按已确认收入记录重算。 */
  readonly receivedAmount?: number | null;
  readonly invoicedAmount?: number | null;
  readonly files?: readonly DocFile[];
}

export interface Order extends OrderHeaderFields {
  readonly id: string;
  readonly orderNo: string;
  readonly partnerId: string;
  readonly partner: OrderPartner | null;
  readonly orderDate: string;
  /** 请购单转出的采购订单才带；详情把它画成回链。 */
  readonly purchaseRequestId?: string | null;
  /** D-077：回链上显示的单据号；没有来源时是 undefined。 */
  readonly purchaseRequestDocNo?: string | null;
  readonly status: OrderStatus;
  /** 端点上的状态值，照原样留着（遇到没登记的状态时显示它）。 */
  readonly apiStatus: string;
  readonly remark: string;
  readonly submittedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** 列表的行不带明细，是空数组。 */
  readonly lines: readonly OrderLine[];
}

/** 生成出来的那张库存单据（R-020），页面只用到单号与状态。 */
export interface StockDocument {
  readonly id: string;
  readonly docNo: string;
  readonly status: 'draft' | 'posted' | 'void';
}

export interface LineInput {
  readonly itemId: string;
  readonly qty: number;
  readonly price?: number;
  readonly deliveryDate?: string | null;
  readonly taxRate?: number | null;
  readonly taxExcludedPrice?: number | null;
  readonly note?: string | null;
}

/** 可选键只在有值时带上：老客户端不带新键的请求与加片前完全一致。 */
export interface OrderWriteFields {
  readonly warehouseId?: string | null;
  readonly contactName?: string | null;
  readonly contactPhone?: string | null;
  readonly deliveryAddress?: string | null;
  readonly settlementCode?: string | null;
  readonly projectCode?: string | null;
  readonly customerOrderNo?: string | null;
  readonly handlerUserId?: string | null;
  readonly discountAmount?: number | null;
  readonly fileIds?: readonly string[];
}

export interface CreateOrderInput extends OrderWriteFields {
  readonly partnerId: string;
  readonly orderDate: string;
  readonly remark?: string;
  readonly lines: readonly LineInput[];
}

/** 至少一项；改草稿时页面把可改的字段全带上。 */
export interface UpdateOrderInput extends OrderWriteFields {
  readonly partnerId?: string;
  readonly orderDate?: string;
  readonly remark?: string;
  readonly lines?: readonly LineInput[];
}

export interface MakeLineInput {
  readonly lineId: string;
  readonly qty: number;
}

export interface MakeDocumentInput {
  readonly warehouseId: string;
  readonly lines?: readonly MakeLineInput[];
}

export interface OrderListQuery {
  readonly status?: string;
  readonly q?: string;
  readonly partnerId?: string;
  readonly from?: string;
  readonly to?: string;
  readonly dateField?: string;
  readonly projectCode?: string;
  readonly handlerUserId?: string;
  readonly deliveryFrom?: string;
  readonly deliveryTo?: string;
  readonly customerOrderNo?: string;
  readonly page?: number;
  readonly pageSize?: number;
}

/** 端点回的明细行；采购、销售的「已到货 / 已发货」字段名不同。 */
export interface OrderLineResponse {
  readonly id: string;
  readonly itemId: string;
  readonly qty: number;
  readonly price?: number | null;
  readonly receivedQty?: number;
  readonly shippedQty?: number;
  readonly remainingQty: number;
  readonly deliveryDate?: string | null;
  readonly taxRate?: number | null;
  readonly taxExcludedPrice?: number | null;
  readonly taxExcludedAmount?: number | null;
  readonly taxAmount?: number | null;
  readonly taxIncludedAmount?: number | null;
  readonly note?: string | null;
}

/** 端点回的一张订单（R-021、R-022 的 `PurchaseOrder` / `SalesOrder`）。 */
export interface OrderResponse extends OrderHeaderFields {
  readonly id: string;
  readonly orderNo: string;
  /** 请购单转单时带上；详情用它回链到请购单（R-021 加片）。 */
  readonly purchaseRequestId?: string | null;
  /** D-077：回链上显示的单据号；没有来源时端点不带这个键。 */
  readonly purchaseRequestDocNo?: string | null;
  readonly status: string;
  readonly orderDate: string;
  readonly remark: string;
  readonly submittedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly supplierId?: string;
  readonly customerId?: string;
  readonly supplier?: OrderPartner | null;
  readonly customer?: OrderPartner | null;
  readonly lines?: readonly OrderLineResponse[];
}

/** 仓管「从订单选择」用的窄形状：没有价格、金额、备注、经办人、项目。 */
export interface NarrowOrderLine {
  readonly id: string;
  readonly itemId: string;
  readonly qty: number;
  readonly receivedQty?: number;
  readonly shippedQty?: number;
  readonly remainingQty: number;
  readonly deliveryDate?: string | null;
  readonly item: {
    readonly id: string;
    readonly code: string;
    readonly name: string;
    readonly spec: string | null;
    readonly unitCode: string;
  };
}

export interface NarrowOrder {
  readonly id: string;
  readonly orderNo: string;
  readonly orderDate: string;
  readonly status: string;
  readonly warehouseId: string | null;
  readonly latestDeliveryDate: string | null;
  readonly contactName: string | null;
  readonly contactPhone: string | null;
  readonly supplier?: {
    readonly id: string;
    readonly code: string;
    readonly name: string;
    readonly contactName?: string | null;
    readonly phone?: string | null;
  } | null;
  readonly customer?: {
    readonly id: string;
    readonly code: string;
    readonly name: string;
    readonly contactName?: string | null;
    readonly phone?: string | null;
  } | null;
  readonly lines: readonly NarrowOrderLine[];
}

/** 端点回的那张库存单据（R-020 的 `StockDoc`），页面只认这三列。 */
export interface StockDocumentResponse {
  readonly id: string;
  readonly docNo: string;
  readonly status: string;
}

/** 只把加片中有值的键带过去；键不在的（无 viewPrice、老单据）不要把空值画成 0。 */
function optional(values: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(values).filter(([, value]) => value !== undefined && value !== ''),
  );
}

/** 端点的形状 → 页面共用的形状。列表的行不带明细，这里是空数组。 */
export function toOrder(def: OrderKindDef, raw: OrderResponse): Order {
  const purchase = def.id === 'purchase';
  return {
    ...optional({
      warehouseId: raw.warehouseId,
      contactName: raw.contactName,
      contactPhone: raw.contactPhone,
      deliveryAddress: raw.deliveryAddress,
      settlementCode: raw.settlementCode,
      settlementLabel: raw.settlementLabel,
      projectCode: raw.projectCode,
      projectLabel: raw.projectLabel,
      customerOrderNo: raw.customerOrderNo,
      handlerUserId: raw.handlerUserId,
      handler: raw.handler,
      discountAmount: raw.discountAmount,
      totalQty: raw.totalQty,
      taxIncludedTotal: raw.taxIncludedTotal,
      taxExcludedTotal: raw.taxExcludedTotal,
      taxTotal: raw.taxTotal,
      payableTotal: raw.payableTotal,
      latestDeliveryDate: raw.latestDeliveryDate,
      paidAmount: raw.paidAmount,
      receivedAmount: raw.receivedAmount,
      invoicedAmount: raw.invoicedAmount,
      files: raw.files,
    }),
    id: raw.id,
    orderNo: raw.orderNo,
    partnerId: purchase ? (raw.supplierId ?? '') : (raw.customerId ?? ''),
    partner: purchase ? (raw.supplier ?? null) : (raw.customer ?? null),
    orderDate: raw.orderDate,
    ...optional({
      purchaseRequestId: raw.purchaseRequestId,
      purchaseRequestDocNo: raw.purchaseRequestDocNo,
    }),
    status:
      def.statuses.find((entry) => entry.api === raw.status)?.value ??
      'unknown',
    apiStatus: raw.status,
    remark: raw.remark,
    submittedAt: raw.submittedAt,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    lines: (raw.lines ?? []).map((line) => ({
      ...optional({
        deliveryDate: line.deliveryDate,
        taxRate: line.taxRate,
        taxExcludedPrice: line.taxExcludedPrice,
        taxExcludedAmount: line.taxExcludedAmount,
        taxAmount: line.taxAmount,
        taxIncludedAmount: line.taxIncludedAmount,
        note: line.note,
      }),
      id: line.id,
      itemId: line.itemId,
      qty: line.qty,
      ...(line.price === undefined ? {} : { price: line.price }),
      doneQty: purchase ? (line.receivedQty ?? 0) : (line.shippedQty ?? 0),
      remainingQty: line.remainingQty,
    })),
  };
}

/** 那张生成的库存单据：页面只用到 id、单号与状态。 */
export function toStockDocument(doc: StockDocumentResponse): StockDocument {
  return {
    id: doc.id,
    docNo: doc.docNo,
    status: doc.status as StockDocument['status'],
  };
}

const enc = encodeURIComponent;

function writeFields(input: OrderWriteFields): Record<string, unknown> {
  return optional({
    warehouseId: input.warehouseId,
    contactName: input.contactName,
    contactPhone: input.contactPhone,
    deliveryAddress: input.deliveryAddress,
    settlementCode: input.settlementCode,
    projectCode: input.projectCode,
    customerOrderNo: input.customerOrderNo,
    handlerUserId: input.handlerUserId,
    discountAmount: input.discountAmount,
    fileIds: input.fileIds,
  });
}

function lineFields(line: LineInput): Record<string, unknown> {
  return {
    itemId: line.itemId,
    qty: line.qty,
    ...optional({
      price: line.price,
      deliveryDate: line.deliveryDate,
      taxRate: line.taxRate,
      taxExcludedPrice: line.taxExcludedPrice,
      note: line.note,
    }),
  };
}

export class OrdersClient {
  constructor(
    private readonly api: ApiClient,
    private readonly def: OrderKindDef,
  ) {}

  private order = (raw: OrderResponse): Order => toOrder(this.def, raw);

  /** 七个端点里的列表：行不带 `lines` 与往来单位。 */
  list(query: OrderListQuery): Promise<EntityPage<Order>> {
    const { partnerId, ...rest } = query;
    const partnerKey = this.def.id === 'purchase' ? 'supplierId' : 'customerId';
    const search = new URLSearchParams();
    const params = {
      ...rest,
      ...(partnerId ? { [partnerKey]: partnerId } : {}),
    };
    for (const [key, value] of Object.entries(params))
      if (value !== undefined && value !== '') search.set(key, String(value));
    return this.api
      .request<EntityPage<OrderResponse>>({
        path: `${this.def.api}?${search.toString()}`,
      })
      .then((page) => ({
        ...page,
        items: page.items.map((row) => this.order(row)),
      }));
  }

  /** 仓管从待收、待发的订单里选一张：窄形状，里面没有价格与备注。 */
  receivable(
    query: { q?: string; partnerId?: string; page?: number; pageSize?: number } = {},
  ): Promise<EntityPage<NarrowOrder>> {
    const search = new URLSearchParams();
    const segment = this.def.id === 'purchase' ? 'receivable' : 'shippable';
    const key = this.def.id === 'purchase' ? 'supplierId' : 'customerId';
    for (const [name, value] of Object.entries({
      q: query.q,
      [key]: query.partnerId,
      page: query.page,
      pageSize: query.pageSize,
    })) {
      if (value !== undefined && value !== '') search.set(name, String(value));
    }
    return this.api.request<EntityPage<NarrowOrder>>({
      path: `${this.def.api}/${segment}?${search.toString()}`,
    });
  }

  get(id: string): Promise<Order> {
    return this.api
      .request<OrderResponse>({ path: `${this.def.api}/${enc(id)}` })
      .then((row) => this.order(row));
  }

  create(input: CreateOrderInput): Promise<Order> {
    const body = {
      [this.def.id === 'purchase' ? 'supplierId' : 'customerId']:
        input.partnerId,
      orderDate: input.orderDate,
      remark: input.remark,
      ...writeFields(input),
      lines: input.lines.map(lineFields),
    };
    return this.api
      .request<OrderResponse>({
        path: this.def.api,
        method: 'POST',
        json: body,
      })
      .then((row) => this.order(row));
  }

  /** 只有草稿能改；带了单号、状态这些服务端列会被忽略。 */
  update(id: string, input: UpdateOrderInput): Promise<Order> {
    const purchase = this.def.id === 'purchase';
    const body = {
      ...(input.partnerId === undefined
        ? {}
        : { [purchase ? 'supplierId' : 'customerId']: input.partnerId }),
      ...(input.orderDate === undefined ? {} : { orderDate: input.orderDate }),
      ...(input.remark === undefined ? {} : { remark: input.remark }),
      ...writeFields(input),
      ...(input.lines === undefined
        ? {}
        : { lines: input.lines.map(lineFields) }),
    };
    return this.api
      .request<OrderResponse>({
        path: `${this.def.api}/${enc(id)}`,
        method: 'PATCH',
        json: body,
      })
      .then((row) => this.order(row));
  }

  /** 提交（采购叫下单，销售叫确认）：写提交时间，明细从此锁定。 */
  submit(id: string): Promise<Order> {
    return this.api
      .request<OrderResponse>({
        path: `${this.def.api}/${enc(id)}/submit`,
        method: 'POST',
      })
      .then((row) => this.order(row));
  }

  /** 草稿或已提交、且没有任何关联出入库单（含草稿与已作废）才能取消。 */
  cancel(id: string): Promise<Order> {
    return this.api
      .request<OrderResponse>({
        path: `${this.def.api}/${enc(id)}/cancel`,
        method: 'POST',
      })
      .then((row) => this.order(row));
  }

  /** 生成一张草稿入库单（出库单）。`lines` 省略时服务端按全部剩余数量生成。 */
  make(id: string, input: MakeDocumentInput): Promise<StockDocument> {
    const lines =
      input.lines?.map((line) => ({
        lineId: line.lineId,
        qty: line.qty,
      })) ?? [];
    return this.api
      .request<StockDocumentResponse>({
        path: `${this.def.api}/${enc(id)}/${this.def.makeSegment}`,
        method: 'POST',
        json: { warehouseId: input.warehouseId, lines },
      })
      .then(toStockDocument);
  }
}
