import { createOrderApiRoutes } from './orders-routes.js';

/** R-021：采购订单七个端点。契约与枚举见 orders-schemas.ts 与设计页。 */
export const apiRoutes = createOrderApiRoutes('purchase');
