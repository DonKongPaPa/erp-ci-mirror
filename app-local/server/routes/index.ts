import type { Application } from '@nocobase/app-server/application';
import type { AppRouteContribution } from '@nocobase/app-server/router';

import { apiRoutes as applicationApiKeyRoutes } from './application-api-keys.js';
import { apiRoutes as qualityRoutes } from './quality.js';
import { apiRoutes as departmentRoutes } from './departments.js';
import { apiRoutes as employeeRoutes } from './employees.js';
import { apiRoutes as devAccountSwitcherRoutes } from './dev-account-switcher.js';

const routes: readonly AppRouteContribution<Application>[] = [
  qualityRoutes,
  departmentRoutes,
  employeeRoutes,
  devAccountSwitcherRoutes,
  applicationApiKeyRoutes,
];

export default routes;
