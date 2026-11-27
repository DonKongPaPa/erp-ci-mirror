import type { ApiClient } from '@nocobase/app-client';

import type { EntityPage } from '#components/erp/list-state';

import type { OrderKindDef, OrderStatus } from './kinds.js';

/**
 * 采购订单与销售订单的端点客户端（R-021、R-022 的接口契约）。两边同形，字段名不同：
 * 这里把端点的形状换成页面共用的形状（`partnerId`、`doneQty`、`status` 的五个值），
 * 页面代码就不用分采购与销售。端点直接回对象或一页，没有 `{ data }` 外层。
 */

/** 详情里的往来单位摘要，刻意只有这四列。 */
export interface OrderPartner {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly status: 'active' | 'inactive';
}

export interface OrderLine {
  readonly id: string;
  readonly itemId: string;
  readonly qty: number;
  readonly price: number | null;
  /** 已到货（销售是已发货）数量，由库存过账回写。 */
  readonly doneQty: number;
  /** 未到货（未发货）数量：订单数量减去未作废出入库单已生成的数量。 */
  readonly remainingQty: number;
}

export interface Order {
  readonly id: string;
  readonly orderNo: string;
  readonly partnerId: string;
  readonly partner: OrderPartner | null;
  readonly orderDate: string;
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
}

export interface CreateOrderInput {
  readonly partnerId: string;
  readonly orderDate: string;
  readonly remark?: string;
  readonly lines: readonly LineInput[];
}

/** 至少一项；改草稿时页面把可改的字段全带上。 */
export interface UpdateOrderInput {
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
  readonly page?: number;
  readonly pageSize?: number;
}

/** 端点回的明细行；采购、销售的「已到货 / 已发货」字段名不同。 */
export interface OrderLineResponse {
  readonly id: string;
  readonly itemId: string;
  readonly qty: number;
  readonly price: number | null;
  readonly receivedQty?: number;
  readonly shippedQty?: number;
  readonly remainingQty: number;
}

/** 端点回的一张订单（R-021、R-022 的 `PurchaseOrder` / `SalesOrder`）。 */
export interface OrderResponse {
  readonly id: string;
  readonly orderNo: string;
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

/** 端点回的那张库存单据（R-020 的 `StockDoc`），页面只认这三列。 */
export interface StockDocumentResponse {
  readonly id: string;
  readonly docNo: string;
  readonly status: string;
}

/** 端点的形状 → 页面共用的形状。列表的行不带明细，这里是空数组。 */
export function toOrder(def: OrderKindDef, raw: OrderResponse): Order {
  const purchase = def.id === 'purchase';
  return {
    id: raw.id,
    orderNo: raw.orderNo,
    partnerId: purchase ? (raw.supplierId ?? '') : (raw.customerId ?? ''),
    partner: purchase ? (raw.supplier ?? null) : (raw.customer ?? null),
    orderDate: raw.orderDate,
    status:
      def.statuses.find((entry) => entry.api === raw.status)?.value ??
      'unknown',
    apiStatus: raw.status,
    remark: raw.remark,
    submittedAt: raw.submittedAt,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    lines: (raw.lines ?? []).map((line) => ({
      id: line.id,
      itemId: line.itemId,
      qty: line.qty,
      price: line.price,
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
      lines: input.lines,
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
      ...(input.lines === undefined ? {} : { lines: input.lines }),
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
