import { TABLE_URL_KEYS } from '#hooks/use-table-url-state';

/**
 * R-070 来料检验页面的授权键。路由的 `authz.resource.id`、页面授权种子与菜单共用这个值；
 * 存量授权记的是这个 id，改名是数据迁移，不是重构。
 */
export const INSPECTIONS_PAGE_ID = 'inspectionOrders' as const;

/** 业务资源：view / create / update / complete / void / receiveView，没有删除。 */
export const INSPECTIONS_RESOURCE = {
  type: 'composite',
  id: 'inspectionOrders',
} as const;

/** 列表筛选只取端点支持的键，不发明参数。 */
export const INSPECTIONS_LIST_KEYS = [
  'status',
  'purchaseOrderId',
  'supplierId',
  'from',
  'to',
  'q',
  ...TABLE_URL_KEYS,
] as const;
