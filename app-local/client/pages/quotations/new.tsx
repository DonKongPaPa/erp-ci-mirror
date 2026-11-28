import type { ReactElement } from 'react';

import QuotationFormPage from './quotation-form-page.js';

/** 新建报价单（R-022 波 2）：盖在列表上的子页，保存后是草稿。 */
export default function QuotationNewPage(): ReactElement {
  return <QuotationFormPage editing={false} />;
}
