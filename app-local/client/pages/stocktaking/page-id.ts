import { TABLE_URL_KEYS } from '#hooks/use-table-url-state';

/**
 * 盘点单页面的授权键。路由的 `authz.resource.id`、页面授权种子与菜单共用这一个值；
 * 存量授权记的是这个 id，改名是数据迁移，不是重构。
 */
export const STOCKTAKINGS_PAGE_ID = 'stocktakings' as const;

/** 业务资源（R-020 波 1）：view / create / update / finish / void，没有删除。 */
export const STOCKTAKINGS_RESOURCE = {
  type: 'composite',
  id: 'stocktakings',
} as const;

/** 列表的筛选参数：端点只认这些，不发明关键字以外的参数。 */
export const STOCKTAKINGS_LIST_KEYS = [
  'status',
  'warehouseId',
  'from',
  'to',
  ...TABLE_URL_KEYS,
] as const;
