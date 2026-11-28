import type { ReactElement } from 'react';

import BomFormPage from './form.js';

/** 新建 BOM：盖在列表上的子页，成品可由「创建子 BOM」带过来。 */
export default function BomNewPage(): ReactElement {
  return <BomFormPage editing={false} />;
}
