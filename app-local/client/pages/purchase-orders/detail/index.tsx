import type { ReactElement } from 'react';

import { PURCHASE } from '../../orders/kinds.js';
import { OrderDetailPage } from '../../orders/order-detail.js';

/** 一张采购订单（R-021） 的子页：表头、明细、合计、状态与这一刻能做的操作。 */
export default function PurchaseOrderDetailPage(): ReactElement {
  return <OrderDetailPage def={PURCHASE} />;
}
