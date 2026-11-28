import { TABLE_URL_KEYS } from '#hooks/use-table-url-state';

/**
 * BOM 页的页面授权 id（R-019 波 2）。路由的 `authz.resource.id`、页面授权种子与菜单共用这一个值；
 * 它只管「能不能打开这一页」，打开之后能读、能展开、能维护由 `boms` 业务资源的动作决定。
 * 存量授权记的是这个 id，改名属于数据迁移，不是重构。
 */
export const BOMS_PAGE_ID = 'boms' as const;

/** 业务资源（R-019 波 2 服务端登记的形状）：view / explode / create / update / void，没有删除。 */
export const BOMS_RESOURCE = { type: 'composite', id: 'boms' } as const;

/** 列表端点支持的筛选项：成品与状态；服务端不认关键字，页面不发明一个。 */
export const BOMS_LIST_KEYS = ['productId', 'status', ...TABLE_URL_KEYS] as const;
