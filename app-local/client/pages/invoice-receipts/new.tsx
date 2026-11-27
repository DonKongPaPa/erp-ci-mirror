import type { ReactElement } from 'react';

import { INVOICE } from '../finance/kinds.js';
import { FinanceFormPage } from '../finance/form.js';

/** R-065 新建Invoice receipt：盖在列表上的子页，保存后是草稿。 */
export default function InvoicereceiptNewPage(): ReactElement {
  return <FinanceFormPage kind={INVOICE} editing={false} />;
}
