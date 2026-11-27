import type { Application } from '@nocobase/app-server/application';
import type { AppRouteContribution } from '@nocobase/app-server/router';

import { apiRoutes as applicationApiKeyRoutes } from './application-api-keys.js';
import { apiRoutes as bizDictRoutes } from './biz-dict.js';
import { apiRoutes as docFileRoutes } from './doc-files.js';
import { apiRoutes as financeRoutes } from './finance.js';
import { apiRoutes as qualityRoutes } from './quality.js';
import { apiRoutes as departmentRoutes } from './departments.js';
import { apiRoutes as employeeRoutes } from './employees.js';
import { apiRoutes as partnerRoutes } from './partners.js';
import { apiRoutes as shiftRoutes } from './shifts.js';
import { apiRoutes as inventoryRoutes } from './inventory.js';
import { apiRoutes as purchaseOrderRoutes } from './purchase-orders.js';
import { apiRoutes as salesOrderRoutes } from './sales-orders.js';
import { apiRoutes as itemRoutes } from './items.js';
import { apiRoutes as unitRoutes } from './units.js';
import { apiRoutes as itemCategoryRoutes } from './item-categories.js';

const routes: readonly AppRouteContribution<Application>[] = [
  bizDictRoutes,
  docFileRoutes,
  // R-065：先于订单路由注册，避免 /purchase-orders/payable 被 /:id 抢先匹配。
  financeRoutes,
  qualityRoutes,
  departmentRoutes,
  employeeRoutes,
  partnerRoutes,
  shiftRoutes,
  inventoryRoutes,
  purchaseOrderRoutes,
  salesOrderRoutes,
  itemRoutes,
  unitRoutes,
  itemCategoryRoutes,
  applicationApiKeyRoutes,
];

export default routes;
