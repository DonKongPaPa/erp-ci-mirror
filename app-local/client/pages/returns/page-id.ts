import { TABLE_URL_KEYS } from '#hooks/use-table-url-state';

/** R-020 波 2 加片二：采购退货与销售退货同形，只有方向、api 与生成的出入库单不同。 */
export type ReturnKind = 'purchase' | 'sales';

export interface ReturnKindDef {
  readonly kind: ReturnKind;
  /** 页面授权 id 与业务资源 id 同名，和已有的 stocktakings / quotations 一致。 */
  readonly pageId: string;
  readonly api: string;
  readonly basePath: string;
  /** 过账生成的出入库单方向：采购退货出，销售退货入。 */
  readonly generatedDocType: 'in' | 'out';
}

export const PURCHASE_RETURNS: ReturnKindDef = {
  kind: 'purchase',
  pageId: 'purchaseReturns',
  api: 'purchase-returns',
  basePath: '/purchase-returns',
  generatedDocType: 'out',
} as const;

export const SALES_RETURNS: ReturnKindDef = {
  kind: 'sales',
  pageId: 'salesReturns',
  api: 'sales-returns',
  basePath: '/sales-returns',
  generatedDocType: 'in',
} as const;

/** 业务资源（采购退货 / 销售退货）：发起、过账、财务窄读各自独立授权。 */
export const returnResource = (def: ReturnKindDef) =>
  ({ type: 'composite', id: def.pageId }) as const;

/** 列表写进地址栏的筛选参数；端点只认这些。 */
export const RETURN_LIST_KEYS = [
  'status',
  'partnerId',
  'from',
  'to',
  ...TABLE_URL_KEYS,
] as const;

/** 生成的出入库单按 returnDocId 反查后跳到对应列表的详情。 */
export const DOC_BASE: Readonly<Record<'in' | 'out', string>> = {
  in: '/inbound-orders',
  out: '/outbound-orders',
} as const;
