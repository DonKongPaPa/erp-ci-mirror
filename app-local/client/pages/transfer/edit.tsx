import type { ReactElement } from 'react';

import TransferFormPage from './form.js';

/** 编辑草稿态的调拨单：盖在详情上的子页。 */
export default function TransferEditPage(): ReactElement {
  return <TransferFormPage editing />;
}
