import type { ReactElement } from 'react';

import { PURCHASE } from '../orders/kinds.js';
import { OrderListPage } from '../orders/order-list.js';

/** 采购订单（R-021） 列表页（`/purchase-orders`）。与另一类订单共用一份代码，差别只在 `orders/kinds.ts` 的配置里。 */
export default function PurchaseOrdersPage(): ReactElement {
  return <OrderListPage def={PURCHASE} />;
}
