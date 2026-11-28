import type { ReactElement } from 'react';

import RequestFormPage from './request-form-page.js';

/** 新建请款单或报销单：盖在列表上的子页，保存后是草稿。 */
export default function FinanceRequestNewPage(): ReactElement {
  return <RequestFormPage editing={false} />;
}
