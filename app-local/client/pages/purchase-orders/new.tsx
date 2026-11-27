import type { ReactElement } from 'react';

import { PURCHASE } from '../orders/kinds.js';
import { OrderFormPage } from '../orders/order-form-page.js';

/** 新建采购订单（R-021）：盖在列表上的子页，保存后是草稿。 */
export default function PurchaseOrderNewPage(): ReactElement {
  return <OrderFormPage def={PURCHASE} editing={false} />;
}
