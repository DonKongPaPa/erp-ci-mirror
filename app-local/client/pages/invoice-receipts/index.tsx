import type { ReactElement } from 'react';

import { INVOICE } from '../finance/kinds.js';
import { FinanceListPage } from '../finance/index.js';

/** R-065 Invoice receipt 列表页。 */
export default function InvoicereceiptsPage(): ReactElement {
  return <FinanceListPage kind={INVOICE} />;
}
