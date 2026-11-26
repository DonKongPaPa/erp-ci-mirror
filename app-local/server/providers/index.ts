import ApiKeysPolicyProvider from './api-keys-policy.js';
import AuthorizationResourcesProvider from './authorization-resources.js';
import DepartmentMutationsProvider from './department-mutations.js';
import DepartmentProvider from './departments.js';
import DevAccountSwitcherProvider from './dev-account-switcher.js';
import KnowledgeAccessProvider from './knowledge-access.js';
import NotificationManagementProvider from './notification-management.js';
import QualityDraftingProvider from './quality-drafting.js';
import QualityModelGatewayProvider from './quality-model-gateway.js';
import QualityScreeningProvider from './quality-screening.js';
import StaffBaselineProvider from './staff-baseline.js';
import SubmissionProvider from './submission.js';
import type { ApplicationServiceProviderConstructor } from '@nocobase/app-server/application';

const serviceProviders: readonly ApplicationServiceProviderConstructor[] = [
  SubmissionProvider,
  DepartmentProvider,
  DepartmentMutationsProvider,
  AuthorizationResourcesProvider,
  NotificationManagementProvider,
  QualityScreeningProvider,
  // R-002：代填服务与它的模型网关。开关默认关着；关着的时候代填不碰网关。
  QualityModelGatewayProvider,
  QualityDraftingProvider,
  // R-002：知识库的空间与访问解析器。知识库插件问它「这个读者在这个空间里能做什么」。
  KnowledgeAccessProvider,
  // R-026：建「人」的账号时指派基线角色 staff。放在建演示账户之前：它们也是建人。
  StaffBaselineProvider,
  DevAccountSwitcherProvider,
  ApiKeysPolicyProvider,
];

export default serviceProviders;
