import type { ReactElement } from 'react';

import { SALES } from '../orders/kinds.js';
import { OrderListPage } from '../orders/order-list.js';

/** 销售订单（R-022） 列表页（`/sales-orders`）。与另一类订单共用一份代码，差别只在 `orders/kinds.ts` 的配置里。 */
export default function SalesOrdersPage(): ReactElement {
  return <OrderListPage def={SALES} />;
}
