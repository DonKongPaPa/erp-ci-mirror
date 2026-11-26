/**
 * 员工管理页的页面授权 id。路由的 `authz.resource.id`、守门测试与交付文档共用这一个值。
 * 它只管「能不能打开这一页」；打开之后能读、能写由 `employees` 业务资源的两个动作决定。
 * 改名属于存量授权的数据迁移，不是重构。
 */
export const EMPLOYEES_PAGE_ID = 'employees' as const;

/** 业务资源：读要 view，写要 manage（R-011 的接口契约）。 */
export const EMPLOYEES_RESOURCE = {
  type: 'composite',
  id: 'employees',
} as const;
