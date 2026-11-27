import { TABLE_URL_KEYS } from '#hooks/use-table-url-state';

import {
  PURCHASE_ORDERS_PAGE_ID,
  PURCHASE_ORDERS_RESOURCE,
} from '../purchase-orders/page-id.js';
import {
  SALES_ORDERS_PAGE_ID,
  SALES_ORDERS_RESOURCE,
} from '../sales-orders/page-id.js';

/**
 * 采购订单（R-021）与销售订单（R-022）是同一个骨架（《基座ERP前端设计》2.4、3.4、3.5）：
 * 两套端点、两套资源，字段名与状态值不同。页面代码只写一份，差别全在这里的配置里。
 */

/** 徽标的颜色只是辅助，每个徽标都有字（设计 2.8）。 */
export type OrderTone = 'neutral' | 'info' | 'success';

/**
 * 页面里的状态。`partial` 是部分到货 / 部分发货，`done` 是已到货 / 已发货；
 * `unknown` 是端点回了这里没登记的状态，页面只显示、不给任何操作。
 */
export type OrderStatus =
  'draft' | 'ordered' | 'partial' | 'done' | 'cancelled' | 'unknown';

export interface OrderStatusDef {
  /** 端点上的状态值，也是列表筛选的参数值。 */
  readonly api: string;
  readonly value: Exclude<OrderStatus, 'unknown'>;
  readonly tone: OrderTone;
}

export interface OrderKindDef {
  readonly id: 'purchase' | 'sales';
  /** 语言包里的组名（`purchaseOrders.*`、`salesOrders.*`）。 */
  readonly l: 'purchaseOrders' | 'salesOrders';
  readonly pageId: string;
  readonly resource: { readonly type: 'composite'; readonly id: string };
  /** 列表页的地址。 */
  readonly path: string;
  /** 端点路径（不含 `/api`）。 */
  readonly api: string;
  /** 详情路由上的参数名。 */
  readonly param: string;
  readonly partnerKind: 'supplier' | 'customer';
  readonly partnerResource: { readonly type: 'composite'; readonly id: string };
  /** 生成入库单 / 出库单的动作名与端点段。 */
  readonly makeAction: 'createReceipt' | 'createIssue';
  readonly makeSegment: 'create-receipt' | 'create-issue';
  /** 徽标与状态条用的状态表，顺序就是筛选里的顺序。 */
  readonly statuses: readonly OrderStatusDef[];
}

export const PURCHASE: OrderKindDef = {
  id: 'purchase',
  l: 'purchaseOrders',
  pageId: PURCHASE_ORDERS_PAGE_ID,
  resource: PURCHASE_ORDERS_RESOURCE,
  path: '/purchase-orders',
  api: 'purchase-orders',
  param: 'purchaseOrderId',
  partnerKind: 'supplier',
  partnerResource: { type: 'composite', id: 'suppliers' },
  makeAction: 'createReceipt',
  makeSegment: 'create-receipt',
  statuses: [
    { api: 'draft', value: 'draft', tone: 'neutral' },
    { api: 'ordered', value: 'ordered', tone: 'info' },
    { api: 'partially_received', value: 'partial', tone: 'info' },
    { api: 'received', value: 'done', tone: 'success' },
    { api: 'cancelled', value: 'cancelled', tone: 'neutral' },
  ],
};

export const SALES: OrderKindDef = {
  id: 'sales',
  l: 'salesOrders',
  pageId: SALES_ORDERS_PAGE_ID,
  resource: SALES_ORDERS_RESOURCE,
  path: '/sales-orders',
  api: 'sales-orders',
  param: 'salesOrderId',
  partnerKind: 'customer',
  partnerResource: { type: 'composite', id: 'customers' },
  makeAction: 'createIssue',
  makeSegment: 'create-issue',
  statuses: [
    { api: 'draft', value: 'draft', tone: 'neutral' },
    { api: 'ordered', value: 'ordered', tone: 'info' },
    { api: 'partially_shipped', value: 'partial', tone: 'info' },
    { api: 'shipped', value: 'done', tone: 'success' },
    { api: 'cancelled', value: 'cancelled', tone: 'neutral' },
  ],
};

/** 订单的地址栏里属于列表的键：从详情、编辑、生成对话框回到列表时原样带回（navigation.md）。 */
export const ORDER_LIST_KEYS = [
  'q',
  'status',
  'supplierId',
  'customerId',
  'from',
  'to',
  ...TABLE_URL_KEYS,
] as const;
