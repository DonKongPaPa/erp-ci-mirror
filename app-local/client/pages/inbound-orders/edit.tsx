import type { ReactElement } from 'react';

import { StockDocFormPage } from '../stock-docs/form.js';
import { STOCK_KINDS } from '../stock-docs/kind.js';

/** 编辑一张入库单草稿（`/inbound-orders/:docId/edit`）。 */
export default function InboundOrderEditPage(): ReactElement {
  return <StockDocFormPage def={STOCK_KINDS.in} mode='edit' />;
}
