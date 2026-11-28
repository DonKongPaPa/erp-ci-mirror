import type { ReactElement } from 'react';

import ReturnFormPage from './form.js';
import { PURCHASE_RETURNS, SALES_RETURNS } from './page-id.js';

/** 新建采购退货：盖在列表上的子页，保存后是草稿，等仓管过账。 */
export function PurchaseReturnsNewPage(): ReactElement {
  return <ReturnFormPage def={PURCHASE_RETURNS} editing={false} />;
}

/** 新建销售退货：同形，只是来源与生成的单据方向相反。 */
export function SalesReturnsNewPage(): ReactElement {
  return <ReturnFormPage def={SALES_RETURNS} editing={false} />;
}
