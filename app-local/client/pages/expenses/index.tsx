import type { ReactElement } from 'react';

import { EXPENSE } from '../finance/kinds.js';
import { FinanceListPage } from '../finance/index.js';

/** R-065 Expense 列表页。 */
export default function ExpensesPage(): ReactElement {
  return <FinanceListPage kind={EXPENSE} />;
}
