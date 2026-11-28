import type { ReactElement } from 'react';

import { ReconFormPage } from '../reconciliation/recon-form.js';
import { RECEIVABLE } from '../reconciliation/kinds.js';

export default function EditPage(): ReactElement {
  return <ReconFormPage kind={ RECEIVABLE } editing />;
}
