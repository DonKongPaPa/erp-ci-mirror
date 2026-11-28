import type { ReactElement } from 'react';

import { ReconDetailPage } from '../../reconciliation/recon-detail.js';
import { RECEIVABLE } from '../../reconciliation/kinds.js';

export default function DetailPage(): ReactElement {
  return <ReconDetailPage kind={ RECEIVABLE } />;
}
