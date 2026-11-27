import type { ReactElement } from 'react';

import { SALES } from '../orders/kinds.js';
import { OrderFormPage } from '../orders/order-form-page.js';

/** 编辑销售订单（R-022）：盖在这一张单上的子页，只有草稿能改。 */
export default function SalesOrderEditPage(): ReactElement {
  return <OrderFormPage def={SALES} editing />;
}
