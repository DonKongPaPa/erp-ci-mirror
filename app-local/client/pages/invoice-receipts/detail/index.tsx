import type { ReactElement } from 'react';

import { INVOICE } from '../../finance/kinds.js';
import { FinanceDetailPage } from '../../finance/detail.js';

/** R-065 一张Invoice receipt的子页：表头、明细、登记与作废。 */
export default function InvoicereceiptDetailPage(): ReactElement {
  return <FinanceDetailPage kind={INVOICE} />;
}
