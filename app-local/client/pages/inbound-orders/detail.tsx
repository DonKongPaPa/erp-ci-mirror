import type { ReactElement } from 'react';

import { StockDocDetailPage } from '../stock-docs/detail.js';
import { STOCK_KINDS } from '../stock-docs/kind.js';

/** 一张入库单（`/inbound-orders/:docId`）。 */
export default function InboundOrderDetailPage(): ReactElement {
  return <StockDocDetailPage def={STOCK_KINDS.in} />;
}
