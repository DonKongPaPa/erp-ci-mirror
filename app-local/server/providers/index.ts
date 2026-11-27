import ApiKeysPolicyProvider from './api-keys-policy.js';
import AuthorizationResourcesProvider from './authorization-resources.js';
import CodesProvider from './codes.js';
import DepartmentMutationsProvider from './department-mutations.js';
import DepartmentProvider from './departments.js';
import DevAccountSwitcherProvider from './dev-account-switcher.js';
import EmployeesProvider from './employee-service.js';
import EmployeeMutationsProvider from './employees.js';
import FeedbackReminderProvider from './feedback-reminder.js';
import InventoryProvider from './inventory.js';
import ItemsProvider from './items.js';
import KnowledgeAccessProvider from './knowledge-access.js';
import LifecycleProvider from './lifecycles.js';
import NotificationManagementProvider from './notification-management.js';
import PartnersProvider from './partners.js';
import QualityDraftingProvider from './quality-drafting.js';
import QualityModelGatewayProvider from './quality-model-gateway.js';
import QualityScreeningProvider from './quality-screening.js';
import ShiftsProvider from './shifts.js';
import StaffBaselineProvider from './staff-baseline.js';
import SubmissionProvider from './submission.js';
import TicketNotificationsProvider from './ticket-notifications.js';
import type { ApplicationServiceProviderConstructor } from '@nocobase/app-server/application';

const serviceProviders: readonly ApplicationServiceProviderConstructor[] = [
  SubmissionProvider,
  // R-016：统一发号器，内部服务；没有页面与端点，顺序无关。
  CodesProvider,
  // R-026：七天提醒，进程内每天一次的扫单任务。
  FeedbackReminderProvider,
  DepartmentProvider,
  DepartmentMutationsProvider,
  // R-011：读服务、内部服务与写服务。放在用户管理服务之后由容器按需解析，顺序无关。
  EmployeesProvider,
  EmployeeMutationsProvider,
  // R-025：内部只读服务、HTTP 读服务与写服务。无调用方时也能被容器解析。
  ShiftsProvider,
  // R-014：往来单位的读服务与写服务；发号器由 CodesProvider 提供，顺序无关。
  PartnersProvider,
  // R-019：物料、单位、分类的读服务与写服务；发号器由 CodesProvider 提供。
  ItemsProvider,
  // R-020：仓库、单据、现存量与流水的读服务与写服务；过账在写服务里取行锁。
  InventoryProvider,
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
  // R-003 S8：五张站内通知模板，效果在流转/派单提交之后才发。
  TicketNotificationsProvider,
  // R-026：建「人」的账号时指派基线角色 staff。放在建演示账户之前：它们也是建人。
  StaffBaselineProvider,
  DevAccountSwitcherProvider,
  ApiKeysPolicyProvider,
];

export default serviceProviders;
