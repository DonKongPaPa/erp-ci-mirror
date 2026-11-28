import type { ReactElement } from 'react';

import StocktakingFormPage from './form.js';

/** 新建盘点单：盖在列表上的子页，保存后是暂存态。 */
export default function StocktakingNewPage(): ReactElement {
  return <StocktakingFormPage editing={false} />;
}
