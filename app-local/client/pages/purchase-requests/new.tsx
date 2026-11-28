import type { ReactElement } from 'react';

import RequestFormPage from './request-form-page.js';

/** 新建请购单：盖在列表上的子页，保存后是草稿。 */
export default function PurchaseRequestNewPage(): ReactElement {
  return <RequestFormPage editing={false} />;
}
