import type { ReactElement } from 'react';

import { SALES } from '../../orders/kinds.js';
import { OrderDetailPage } from '../../orders/order-detail.js';

/** 一张销售订单（R-022） 的子页：表头、明细、合计、状态与这一刻能做的操作。 */
export default function SalesOrderDetailPage(): ReactElement {
  return <OrderDetailPage def={SALES} />;
}
