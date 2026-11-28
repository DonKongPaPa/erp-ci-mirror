import type { ReactElement } from 'react';

import { DocFormPage } from '../reconciliation/doc-form.js';
import { SALE_INVOICE } from '../reconciliation/kinds.js';

export default function EditPage(): ReactElement {
  return <DocFormPage kind={ SALE_INVOICE } editing />;
}
