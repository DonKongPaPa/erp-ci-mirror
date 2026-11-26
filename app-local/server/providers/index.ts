import ApiKeysPolicyProvider from './api-keys-policy.js';
import AuthorizationResourcesProvider from './authorization-resources.js';
import DepartmentMutationsProvider from './department-mutations.js';
import DepartmentProvider from './departments.js';
import DevAccountSwitcherProvider from './dev-account-switcher.js';
import EmployeesProvider from './employee-service.js';
import EmployeeMutationsProvider from './employees.js';
import FeedbackReminderProvider from './feedback-reminder.js';
import KnowledgeAccessProvider from './knowledge-access.js';
import LifecycleProvider from './lifecycles.js';
import NotificationManagementProvider from './notification-management.js';
import QualityDraftingProvider from './quality-drafting.js';
import QualityModelGatewayProvider from './quality-model-gateway.js';
import QualityScreeningProvider from './quality-screening.js';
import StaffBaselineProvider from './staff-baseline.js';
import SubmissionProvider from './submission.js';
import type { ApplicationServiceProviderConstructor } from '@nocobase/app-server/application';

const serviceProviders: readonly ApplicationServiceProviderConstructor[] = [
  SubmissionProvider,
  // R-026：七天提醒，进程内每天一次的扫单任务。
  FeedbackReminderProvider,
  DepartmentProvider,
  DepartmentMutationsProvider,
  // R-011：读服务、内部服务与写服务。放在用户管理服务之后由容器按需解析，顺序无关。
  EmployeesProvider,
  EmployeeMutationsProvider,
  AuthorizationResourcesProvider,
  NotificationManagementProvider,
  QualityScreeningProvider,
  // R-002：代填服务与它的模型网关。开关默认关着；关着的时候代填不碰网关。
  QualityModelGatewayProvider,
  QualityDraftingProvider,
  // R-002：知识库的空间与访问解析器。知识库插件问它「这个读者在这个空间里能做什么」。
  KnowledgeAccessProvider,
  // R-003 S5：唯一的 lifecycle 运行时（R-017 未落地，由本片带上）。
  LifecycleProvider,
  // R-026：建「人」的账号时指派基线角色 staff。放在建演示账户之前：它们也是建人。
  StaffBaselineProvider,
  DevAccountSwitcherProvider,
  ApiKeysPolicyProvider,
];

export default serviceProviders;
