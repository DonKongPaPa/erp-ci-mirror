import type { ReactElement } from 'react';

import { EXPENSE } from '../../finance/kinds.js';
import { FinanceDetailPage } from '../../finance/detail.js';

/** R-065 一张Expense的子页：表头、明细、登记与作废。 */
export default function ExpenseDetailPage(): ReactElement {
  return <FinanceDetailPage kind={EXPENSE} />;
}
