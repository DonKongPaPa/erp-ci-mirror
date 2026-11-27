/**
 * 业务字典页（R-072）的页面授权 id 与业务资源。
 *
 * 存量授权记的是 id 而不是路由名，改名是数据迁移，不是重构。页面授权只给 root（不受限，
 * 不需要写进业务角色的 seed）；采购、销售、仓管持 bizDict.view 在单据里用下拉选值，默认不进这一页。
 */
export const BIZ_DICT_PAGE_ID = 'bizDict' as const;

/** 服务端登记的业务资源：读要 view，建改停用要 manage（只有 root）。 */
export const BIZ_DICT_RESOURCE = { type: 'composite', id: 'bizDict' } as const;

export interface ListAccess {
  readonly dictType: string;
  readonly canView: boolean;
  readonly canManage: boolean;
  readonly pending: boolean;
}
