/** R-068 的五种模板；顺序与服务端端点、样例文件、页面页签一致。 */
export const IMPORT_KINDS = [
  'items',
  'partners',
  'warehouses',
  'bizDict',
  'openingStock',
] as const;
export type ImportKind = (typeof IMPORT_KINDS)[number];
