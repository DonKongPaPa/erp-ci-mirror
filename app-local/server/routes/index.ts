import type { Application } from '@nocobase/app-server/application';
import type { AppRouteContribution } from '@nocobase/app-server/router';

import { apiRoutes as approvalRoutes } from './approvals.js';
import { apiRoutes as applicationApiKeyRoutes } from './application-api-keys.js';
import { apiRoutes as bizDictRoutes } from './biz-dict.js';
import { apiRoutes as docFileRoutes } from './doc-files.js';
import { apiRoutes as docPrintRoutes } from './doc-print.js';
import { apiRoutes as financeRoutes } from './finance.js';
import { apiRoutes as reconciliationRoutes } from './reconciliation.js';
import { apiRoutes as reportRoutes } from './reports.js';
import { apiRoutes as qualityRoutes } from './quality.js';
import { apiRoutes as departmentRoutes } from './departments.js';
import { apiRoutes as employeeRoutes } from './employees.js';
import { apiRoutes as partnerRoutes } from './partners.js';
import { apiRoutes as shiftRoutes } from './shifts.js';
import { apiRoutes as inventoryRoutes } from './inventory.js';
import { apiRoutes as purchaseOrderRoutes } from './purchase-orders.js';
import { apiRoutes as purchaseRequestRoutes } from './purchase-requests.js';
import { apiRoutes as financeRequestRoutes } from './finance-requests.js';
import { apiRoutes as orderReviewRoutes } from './order-reviews.js';
import { apiRoutes as salesOrderRoutes } from './sales-orders.js';
import { apiRoutes as quotationRoutes } from './quotations.js';
import { apiRoutes as itemRoutes } from './items.js';
import { apiRoutes as bomRoutes } from './boms.js';
import { apiRoutes as iqcRoutes } from './iqc.js';
import { apiRoutes as mesSettingsRoutes } from './mes-settings.js';
import { apiRoutes as stocktakingRoutes } from './stocktaking.js';
import { apiRoutes as transferRoutes } from './transfer.js';
import { apiRoutes as returnsRoutes } from './returns.js';
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
  // R-065 复刻波 2：同样先于订单路由，避免 /sales-orders/receivable 被 /:id 抢先匹配。
  reconciliationRoutes,
  // R-078：报表端点；/reports/favorites 与 /reports/export-traces 是静态段，先登记。
  reportRoutes,
  qualityRoutes,
  departmentRoutes,
  employeeRoutes,
  partnerRoutes,
  shiftRoutes,
  inventoryRoutes,
  stocktakingRoutes,
  transferRoutes,
  // R-020 波 2：退货单的静态段（source-options / finance-options）由 Hono 区分。
  returnsRoutes,
  docPrintRoutes,
  purchaseOrderRoutes,
  // R-021 波 1 加片：请购单自己的路由，静态段在 /purchase-requests/:id 之前由 Hono 区分。
  purchaseRequestRoutes,
  // R-066：请款单与报销单自己的路由，静态段在 /finance-requests/:id 之前由 Hono 区分。
  financeRequestRoutes,
  // R-064：/sales-orders/ledger 必须先于 /sales-orders/:id 注册，否则会被当成订单 id。
  orderReviewRoutes,
  salesOrderRoutes,
  // R-022 复刻波 1：报价单七条端点；路径不与订单冲突。
  quotationRoutes,
  itemRoutes,
  bomRoutes,
  // R-070：/inspections/receivable-options 是静态段，Hono 会先于 /inspections/:id 匹配。
  iqcRoutes,
  // R-023 W3-1：五组设置端点 + 工价，路径不与现有模块冲突。
  mesSettingsRoutes,
  unitRoutes,
  itemCategoryRoutes,
  // R-068：/imports/:kind/* 是工程工具，放在业务路由之后；没有删除端点。
  importRoutes,
  applicationApiKeyRoutes,
];

export default routes;
