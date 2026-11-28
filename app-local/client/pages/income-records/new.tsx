import type { ReactElement } from 'react';

import { DocFormPage } from '../reconciliation/doc-form.js';
import { INCOME } from '../reconciliation/kinds.js';

export default function NewPage(): ReactElement {
  return <DocFormPage kind={ INCOME } editing={ false } />;
}
