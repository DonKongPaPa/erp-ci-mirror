import { TABLE_URL_KEYS } from '#hooks/use-table-url-state';

/** 调拨单页面的授权键；存量授权记的是这个 id，改名是数据迁移，不是重构。 */
export const TRANSFERS_PAGE_ID = 'transfers' as const;

/** 业务资源（R-020 波 1）：view / create / update / post / void，没有删除。 */
export const TRANSFERS_RESOURCE = {
  type: 'composite',
  id: 'transfers',
} as const;

/** 列表的筛选参数：端点只认这些，不发明参数。 */
export const TRANSFERS_LIST_KEYS = [
  'status',
  'transferInWarehouseId',
  'transferOutWarehouseId',
  'from',
  'to',
  ...TABLE_URL_KEYS,
] as const;
