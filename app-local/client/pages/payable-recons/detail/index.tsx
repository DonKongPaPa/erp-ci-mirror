import type { ReactElement } from 'react';

import { ReconDetailPage } from '../../reconciliation/recon-detail.js';
import { PAYABLE } from '../../reconciliation/kinds.js';

export default function DetailPage(): ReactElement {
  return <ReconDetailPage kind={ PAYABLE } />;
}
