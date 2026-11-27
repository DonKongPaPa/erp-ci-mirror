import type { ReactElement } from 'react';

import { EXPENSE } from '../finance/kinds.js';
import { FinanceFormPage } from '../finance/form.js';

/** R-065 编辑Expense：只有草稿能改。 */
export default function ExpenseEditPage(): ReactElement {
  return <FinanceFormPage kind={EXPENSE} editing />;
}
