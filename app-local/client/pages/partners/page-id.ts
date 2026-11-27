/**
 * 客户与供应商页的页面授权 id（《基座ERP前端设计》1.3、第八节）：一条路由、一个页面授权 id，
 * 「客户」「供应商」两个标签各自靠 customers.view、suppliers.view 显隐。销售、采购、root 有页面授权；
 * 存量授权记的是这个 id，改名属于数据迁移，不是重构。
 */
export const PARTNERS_PAGE_ID = 'partners' as const;

/** 业务资源（R-014）：客户与供应商各一个，动作都是 view / create / update。 */
export const CUSTOMERS_RESOURCE = {
  type: 'composite',
  id: 'customers',
} as const;
export const SUPPLIERS_RESOURCE = {
  type: 'composite',
  id: 'suppliers',
} as const;
