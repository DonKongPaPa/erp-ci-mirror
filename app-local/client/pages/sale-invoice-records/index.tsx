import type { ReactElement } from 'react';

import { ReconciliationListPage } from '../reconciliation/list.js';
import { SALE_INVOICE } from '../reconciliation/kinds.js';

/** R-065 第二片：财务单列表页。 */
export default function SaleInvoiceRecordsPage(): ReactElement {
  return <ReconciliationListPage kind={ SALE_INVOICE } />;
}
