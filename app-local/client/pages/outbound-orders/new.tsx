import type { ReactElement } from 'react';

import { StockDocFormPage } from '../stock-docs/form.js';
import { STOCK_KINDS } from '../stock-docs/kind.js';

/** 手工新建一张出库单（`/outbound-orders/new`）。由销售订单生成的在订单那一头。 */
export default function OutboundOrderNewPage(): ReactElement {
  return <StockDocFormPage def={STOCK_KINDS.out} mode='new' />;
}
