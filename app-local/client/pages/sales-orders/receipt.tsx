import type { ReactElement } from 'react';

import { SALES } from '../orders/kinds.js';
import { OrderReceiptPage } from '../orders/order-receipt.js';

/** 「生成出库单」：订单页上的对话框。 */
export default function SalesOrderReceiptPage(): ReactElement {
  return <OrderReceiptPage def={SALES} />;
}
