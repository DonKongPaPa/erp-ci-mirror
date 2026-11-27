/**
 * 物料页的页面授权 id（《基座ERP前端设计》1.3）：物料清单、计量单位、物料分类三个标签共用一条路由、
 * 一个页面授权 id。它只管「能不能打开这一页」；打开之后能读、能写由 `items` 业务资源的 view / manage 决定。
 * 页面授权给销售、采购（它们为订单已经拿了 items.view），写只给 root，不写进任何业务角色的 seed。
 * 存量授权记的是这个 id，改名属于数据迁移，不是重构。
 */
export const ITEMS_PAGE_ID = 'items' as const;

/**
 * 业务资源（R-019 服务端登记的形状）：物料、计量单位、物料分类合成一个 `items` 资源 ——
 * 读三张表要 view，建改三张表要 manage。
 */
export const ITEMS_RESOURCE = { type: 'composite', id: 'items' } as const;

/** 三个标签各自要的权限：都靠 `items` 的 view / manage，不另设授权。 */
export interface ListAccess {
  readonly canView: boolean;
  readonly canManage: boolean;
  /** 权限还没落定：先不发请求。 */
  readonly pending: boolean;
}
