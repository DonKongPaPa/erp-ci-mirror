import type { ReactElement } from 'react';

import { ReconciliationListPage } from '../reconciliation/list.js';
import { PAYABLE } from '../reconciliation/kinds.js';

/** R-065 第二片：财务单列表页。 */
export default function PayableReconsPage(): ReactElement {
  return <ReconciliationListPage kind={ PAYABLE } />;
}
