import type { ReactElement } from 'react';

import { SALES } from '../orders/kinds.js';
import { OrderFormPage } from '../orders/order-form-page.js';

/** 新建销售订单（R-022）：盖在列表上的子页，保存后是草稿。 */
export default function SalesOrderNewPage(): ReactElement {
  return <OrderFormPage def={SALES} editing={false} />;
}
