import type { ReactElement } from 'react';

import { StockDocsPage } from '../stock-docs/index.js';
import { STOCK_KINDS } from '../stock-docs/kind.js';

/** 入库单列表（`/inbound-orders`）：与出库单同一个骨架，方向是入库。 */
export default function InboundOrdersPage(): ReactElement {
  return <StockDocsPage def={STOCK_KINDS.in} />;
}
