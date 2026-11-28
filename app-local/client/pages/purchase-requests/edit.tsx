import type { ReactElement } from 'react';

import RequestFormPage from './request-form-page.js';

/** 编辑请购单：只有草稿或已驳回能改。 */
export default function PurchaseRequestEditPage(): ReactElement {
  return <RequestFormPage editing />;
}
