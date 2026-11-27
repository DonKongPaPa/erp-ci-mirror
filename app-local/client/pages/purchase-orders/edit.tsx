import type { ReactElement } from 'react';

import { PURCHASE } from '../orders/kinds.js';
import { OrderFormPage } from '../orders/order-form-page.js';

/** 编辑采购订单（R-021）：盖在这一张单上的子页，只有草稿能改。 */
export default function PurchaseOrderEditPage(): ReactElement {
  return <OrderFormPage def={PURCHASE} editing />;
}
