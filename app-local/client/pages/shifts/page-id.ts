/**
 * 班次定义页的页面授权 id（《基座ERP前端设计》1.3）。路由的 `authz.resource.id`、守门测试共用这一个值；
 * 它只管「能不能打开这一页」，打开之后能读、能写由 `shifts` 业务资源的 view / manage 决定。
 * 默认只给 root，不写进任何业务角色的 seed（R-025）。改名属于存量授权的数据迁移，不是重构。
 */
export const SHIFTS_PAGE_ID = 'shifts' as const;

/** 业务资源：读要 view，写要 manage（R-025 的接口契约）。 */
export const SHIFTS_RESOURCE = { type: 'composite', id: 'shifts' } as const;
