import ApiKeysPolicyProvider from './api-keys-policy.js';
import AuthorizationResourcesProvider from './authorization-resources.js';
import DepartmentMutationsProvider from './department-mutations.js';
import DepartmentProvider from './departments.js';
import DevAccountSwitcherProvider from './dev-account-switcher.js';
import KnowledgeAccessProvider from './knowledge-access.js';
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
  // R-002：知识库的空间与访问解析器。知识库插件问它「这个读者在这个空间里能做什么」。
  KnowledgeAccessProvider,
  DevAccountSwitcherProvider,
  ApiKeysPolicyProvider,
];

export default serviceProviders;
