import type { ReactElement } from 'react';

import { ReconciliationListPage } from '../reconciliation/list.js';
import { RECEIVABLE } from '../reconciliation/kinds.js';

/** R-065 第二片：财务单列表页。 */
export default function ReceivableReconsPage(): ReactElement {
  return <ReconciliationListPage kind={ RECEIVABLE } />;
}
