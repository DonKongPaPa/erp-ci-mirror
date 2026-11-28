import type { ReactElement } from 'react';

import { DocDetailPage } from '../../reconciliation/doc-detail.js';
import { INCOME } from '../../reconciliation/kinds.js';

export default function DetailPage(): ReactElement {
  return <DocDetailPage kind={ INCOME } />;
}
