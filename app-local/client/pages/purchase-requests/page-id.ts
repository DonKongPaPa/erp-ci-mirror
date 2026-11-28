import { TABLE_URL_KEYS } from '#hooks/use-table-url-state';

/**
 * 请购单页面的授权键。路由的 `authz.resource.id`、页面授权种子与菜单共用这一个值；
 * 存量授权记的是这个 id，改名是数据迁移，不是重构。
 */
export const PURCHASE_REQUESTS_PAGE_ID = 'purchaseRequests' as const;

/** 业务资源（R-021 波 1）：view / create / update / submit / void / convert，没有删除。 */
export const PURCHASE_REQUESTS_RESOURCE = {
  type: 'composite',
  id: 'purchaseRequests',
} as const;

/** 列表的筛选参数：端点只认这些，没有关键字参数，页面不发明一个。 */
export const PURCHASE_REQUESTS_LIST_KEYS = [
  'status',
  'departmentId',
  'from',
  'to',
  ...TABLE_URL_KEYS,
] as const;
