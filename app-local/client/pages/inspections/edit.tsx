import type { ReactElement } from 'react';

import InspectionFormPage from './form.js';

/** 编辑检验单：只有 pending 能改。 */
export default function InspectionEditPage(): ReactElement {
  return <InspectionFormPage editing />;
}
