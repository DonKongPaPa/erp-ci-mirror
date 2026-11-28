import type { ReactElement } from 'react';

import StocktakingFormPage from './form.js';

/** 编辑暂存态的盘点单：盖在详情上的子页。 */
export default function StocktakingEditPage(): ReactElement {
  return <StocktakingFormPage editing />;
}
