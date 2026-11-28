import type { ReactElement } from 'react';

import InspectionFormPage from './form.js';

/** 新建检验单：盖在列表上的子页，保存后是 pending。 */
export default function InspectionNewPage(): ReactElement {
  return <InspectionFormPage editing={false} />;
}
