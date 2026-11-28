import type { ReactElement } from 'react';

import BomFormPage from './form.js';

/** 编辑 BOM：先读最新数据再填，成品不可改，配件行整单替换。 */
export default function BomEditPage(): ReactElement {
  return <BomFormPage editing />;
}
