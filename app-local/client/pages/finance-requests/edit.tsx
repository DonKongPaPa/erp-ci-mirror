import type { ReactElement } from 'react';

import RequestFormPage from './request-form-page.js';

/** 编辑请款单或报销单：只有草稿或已驳回能改。 */
export default function FinanceRequestEditPage(): ReactElement {
  return <RequestFormPage editing />;
}
