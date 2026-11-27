/**
 * 销售订单页的页面授权 id（《基座ERP前端设计》1.3）。路由的 `authz.resource.id`、seed、升级命令共用这一个值；
 * 它只管「能不能打开这一页」，打开之后能读、能写由 `salesOrders` 业务资源的各动作决定。
 * 存量授权记的是这个 id，改名属于数据迁移，不是重构。
 */
export const SALES_ORDERS_PAGE_ID = 'salesOrders' as const;

/** 业务资源（R-022）：view / create / update / submit / cancel / createIssue，没有删除。 */
export const SALES_ORDERS_RESOURCE = {
  type: 'composite',
  id: 'salesOrders',
} as const;
