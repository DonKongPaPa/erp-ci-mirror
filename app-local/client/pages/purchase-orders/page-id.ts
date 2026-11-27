/**
 * 采购订单页的页面授权 id（《基座ERP前端设计》1.3）。路由的 `authz.resource.id`、seed、升级命令共用这一个值；
 * 它只管「能不能打开这一页」，打开之后能读、能写由 `purchaseOrders` 业务资源的各动作决定。
 * 存量授权记的是这个 id，改名属于数据迁移，不是重构。
 */
export const PURCHASE_ORDERS_PAGE_ID = 'purchaseOrders' as const;

/** 业务资源（R-021）：view / create / update / submit / cancel / createReceipt，没有删除。 */
export const PURCHASE_ORDERS_RESOURCE = {
  type: 'composite',
  id: 'purchaseOrders',
} as const;
