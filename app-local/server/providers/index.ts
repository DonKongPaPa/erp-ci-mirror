import ApiKeysPolicyProvider from './api-keys-policy.js';
import AuthorizationResourcesProvider from './authorization-resources.js';
import DepartmentMutationsProvider from './department-mutations.js';
import DepartmentProvider from './departments.js';
import DevAccountSwitcherProvider from './dev-account-switcher.js';
import NotificationManagementProvider from './notification-management.js';
import QualityScreeningProvider from './quality-screening.js';
import SubmissionProvider from './submission.js';
import type { ApplicationServiceProviderConstructor } from '@nocobase/app-server/application';

const serviceProviders: readonly ApplicationServiceProviderConstructor[] = [
  SubmissionProvider,
  DepartmentProvider,
  DepartmentMutationsProvider,
  AuthorizationResourcesProvider,
  NotificationManagementProvider,
  QualityScreeningProvider,
  DevAccountSwitcherProvider,
  ApiKeysPolicyProvider,
];

export default serviceProviders;
