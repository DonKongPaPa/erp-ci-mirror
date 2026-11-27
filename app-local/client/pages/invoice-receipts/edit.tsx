import type { ReactElement } from 'react';

import { INVOICE } from '../finance/kinds.js';
import { FinanceFormPage } from '../finance/form.js';

/** R-065 编辑Invoice receipt：只有草稿能改。 */
export default function InvoicereceiptEditPage(): ReactElement {
  return <FinanceFormPage kind={INVOICE} editing />;
}
