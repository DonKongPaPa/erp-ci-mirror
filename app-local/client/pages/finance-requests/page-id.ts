import { TABLE_URL_KEYS } from '#hooks/use-table-url-state';

/**
 * R-066 请款单与报销单页面的授权键。路由的 `authz.resource.id`、页面授权种子与菜单共用这一个值；
 * 存量授权记的是 id，改名属于数据迁移，不是重构。业务资源与页面 id 都叫 financeRequests。
 */
export const FINANCE_REQUESTS_PAGE_ID = 'financeRequests' as const;

/** 业务资源（R-066）：view / create / update / submit / void / convert，没有删除。 */
export const FINANCE_REQUESTS_RESOURCE = {
  type: 'composite',
  id: 'financeRequests',
} as const;

/** 列表只认端点支持的筛选参数，没有关键字参数，页面不发明一个。 */
export const FINANCE_REQUESTS_LIST_KEYS = [
  'docType',
  'status',
  'expenseTypeCode',
  'projectCode',
  'from',
  'to',
  ...TABLE_URL_KEYS,
] as const;
