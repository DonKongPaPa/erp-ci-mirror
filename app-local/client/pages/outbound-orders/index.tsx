import type { ReactElement } from 'react';

import { StockDocsPage } from '../stock-docs/index.js';
import { STOCK_KINDS } from '../stock-docs/kind.js';

/** 出库单列表（`/outbound-orders`）：与入库单同一个骨架，方向是出库。 */
export default function OutboundOrdersPage(): ReactElement {
  return <StockDocsPage def={STOCK_KINDS.out} />;
}
