import type { ReactElement } from 'react';

import { ReconFormPage } from '../reconciliation/recon-form.js';
import { PAYABLE } from '../reconciliation/kinds.js';

export default function EditPage(): ReactElement {
  return <ReconFormPage kind={ PAYABLE } editing />;
}
