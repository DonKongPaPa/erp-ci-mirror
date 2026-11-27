/**
 * 仓库页的页面授权 id（《基座ERP前端设计》1.3）。路由的 `authz.resource.id`、守门测试共用这一个值；
 * 它只管「能不能打开这一页」，打开之后能读、能写由 `inventory` 业务资源的 warehouseView / warehouseManage 决定。
 * 仓管、采购、销售、root 有页面授权；建改只给 root。改名属于存量授权的数据迁移，不是重构。
 */
export const WAREHOUSES_PAGE_ID = 'warehouses' as const;

/**
 * R-020 的业务资源：仓库、库存单据、现存量、流水共用一个资源，六个动作
 * （warehouseView / warehouseManage / stockView / stockWrite / stockPost / stockVoid）。
 * 库存查询、入库单、出库单三页也从这里取。
 */
export const INVENTORY_RESOURCE = {
  type: 'composite',
  id: 'inventory',
} as const;
