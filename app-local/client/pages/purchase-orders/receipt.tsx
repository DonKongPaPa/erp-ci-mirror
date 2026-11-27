import type { ReactElement } from 'react';

import { PURCHASE } from '../orders/kinds.js';
import { OrderReceiptPage } from '../orders/order-receipt.js';

/** 「生成入库单」：订单页上的对话框。 */
export default function PurchaseOrderReceiptPage(): ReactElement {
  return <OrderReceiptPage def={PURCHASE} />;
}
