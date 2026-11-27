/**
 * 库存查询、入库单、出库单三页的页面授权 id（《基座ERP前端设计》1.3）。路由的 `authz.resource.id`、
 * 守门测试共用这一个值；它只管「能不能打开这一页」，打开之后能读、能写由 `inventory` 业务资源的
 * stockView / stockWrite / stockPost / stockVoid 决定。默认只给仓管，root 不受限。
 * 改名属于存量授权的数据迁移，不是重构。
 */
export const STOCK_PAGE_ID = 'stock' as const;
export const INBOUND_ORDERS_PAGE_ID = 'inboundOrders' as const;
export const OUTBOUND_ORDERS_PAGE_ID = 'outboundOrders' as const;
