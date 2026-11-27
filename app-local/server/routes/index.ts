import type { Application } from '@nocobase/app-server/application';
import type { AppRouteContribution } from '@nocobase/app-server/router';

import { apiRoutes as approvalRoutes } from './approvals.js';
import { apiRoutes as applicationApiKeyRoutes } from './application-api-keys.js';
import { apiRoutes as bizDictRoutes } from './biz-dict.js';
import { apiRoutes as docFileRoutes } from './doc-files.js';
import { apiRoutes as docPrintRoutes } from './doc-print.js';
import { apiRoutes as financeRoutes } from './finance.js';
import { apiRoutes as qualityRoutes } from './quality.js';
import { apiRoutes as departmentRoutes } from './departments.js';
import { apiRoutes as employeeRoutes } from './employees.js';
import { apiRoutes as partnerRoutes } from './partners.js';
import { apiRoutes as shiftRoutes } from './shifts.js';
import { apiRoutes as inventoryRoutes } from './inventory.js';
import { apiRoutes as purchaseOrderRoutes } from './purchase-orders.js';
import { apiRoutes as purchaseRequestRoutes } from './purchase-requests.js';
import { apiRoutes as orderReviewRoutes } from './order-reviews.js';
import { apiRoutes as salesOrderRoutes } from './sales-orders.js';
import { apiRoutes as quotationRoutes } from './quotations.js';
import { apiRoutes as itemRoutes } from './items.js';
import { apiRoutes as stocktakingRoutes } from './stocktaking.js';
import { apiRoutes as transferRoutes } from './transfer.js';
import { apiRoutes as unitRoutes } from './units.js';
import { apiRoutes as itemCategoryRoutes } from './item-categories.js';
import { apiRoutes as importRoutes } from './import-tool.js';

const routes: readonly AppRouteContribution<Application>[] = [
  // R-017 M3：静态段（mine / tasks / :id/candidates）要在 /approvals/:id 之前。
  approvalRoutes,
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
  stocktakingRoutes,
  transferRoutes,
  docPrintRoutes,
  purchaseOrderRoutes,
  // R-021 波 1 加片：请购单自己的路由，静态段在 /purchase-requests/:id 之前由 Hono 区分。
  purchaseRequestRoutes,
  // R-064：/sales-orders/ledger 必须先于 /sales-orders/:id 注册，否则会被当成订单 id。
  orderReviewRoutes,
  salesOrderRoutes,
  // R-022 复刻波 1：报价单七条端点；路径不与订单冲突。
  quotationRoutes,
  itemRoutes,
  unitRoutes,
  itemCategoryRoutes,
  // R-068：/imports/:kind/* 是工程工具，放在业务路由之后；没有删除端点。
  importRoutes,
  applicationApiKeyRoutes,
];

export default routes;
