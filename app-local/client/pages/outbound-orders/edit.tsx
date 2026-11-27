import type { ReactElement } from 'react';

import { StockDocFormPage } from '../stock-docs/form.js';
import { STOCK_KINDS } from '../stock-docs/kind.js';

/** 编辑一张出库单草稿（`/outbound-orders/:docId/edit`）。 */
export default function OutboundOrderEditPage(): ReactElement {
  return <StockDocFormPage def={STOCK_KINDS.out} mode='edit' />;
}
