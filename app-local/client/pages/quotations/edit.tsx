import type { ReactElement } from 'react';

import QuotationFormPage from './quotation-form-page.js';

/** 编辑报价单（R-022 波 2）：盖在这一张单上的子页，只有草稿能改。 */
export default function QuotationEditPage(): ReactElement {
  return <QuotationFormPage editing />;
}
