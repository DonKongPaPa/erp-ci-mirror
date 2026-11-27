import type { ReactElement } from 'react';

import { EXPENSE } from '../finance/kinds.js';
import { FinanceFormPage } from '../finance/form.js';

/** R-065 新建Expense：盖在列表上的子页，保存后是草稿。 */
export default function ExpenseNewPage(): ReactElement {
  return <FinanceFormPage kind={EXPENSE} editing={false} />;
}
