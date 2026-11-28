import { TABLE_URL_KEYS } from '#hooks/use-table-url-state';

/**
 * 报价单页的页面授权 id（R-022 波 2）。路由的 `authz.resource.id`、页面授权种子共用这一个值；
 * 它只管「能不能打开这一页」，打开之后能读、能写由 `quotations` 业务资源的六个动作决定。
 * 存量授权记的是这个 id，改名属于数据迁移，不是重构。
 */
export const QUOTATIONS_PAGE_ID = 'quotations' as const;

/** 业务资源（R-022 波 1）：view / create / update / confirm / convert / void，没有删除。 */
export const QUOTATIONS_RESOURCE = {
  type: 'composite',
  id: 'quotations',
} as const;

/** 列表端点支持的筛选；端点没有创建时间参数，不写 from/to。 */
export const QUOTATIONS_LIST_KEYS = [
  'customerId',
  'projectCode',
  'status',
  'validFrom',
  'validTo',
  ...TABLE_URL_KEYS,
] as const;
