import type { ReactElement } from 'react';

import TransferFormPage from './form.js';

/** 新建调拨单：盖在列表上的子页，默认三行，保存后是草稿。 */
export default function TransferNewPage(): ReactElement {
  return <TransferFormPage editing={false} />;
}
