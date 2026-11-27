import type { ReactElement } from 'react';

import { StockDocFormPage } from '../stock-docs/form.js';
import { STOCK_KINDS } from '../stock-docs/kind.js';

/** 手工新建一张入库单（`/inbound-orders/new`）。由采购订单生成的在订单那一头。 */
export default function InboundOrderNewPage(): ReactElement {
  return <StockDocFormPage def={STOCK_KINDS.in} mode='new' />;
}
