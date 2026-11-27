import type { ReactElement } from 'react';

import { StockDocDetailPage } from '../stock-docs/detail.js';
import { STOCK_KINDS } from '../stock-docs/kind.js';

/** 一张出库单（`/outbound-orders/:docId`）：草稿的每一行旁边带现存量。 */
export default function OutboundOrderDetailPage(): ReactElement {
  return <StockDocDetailPage def={STOCK_KINDS.out} />;
}
