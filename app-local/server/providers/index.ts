import ApiKeysPolicyProvider from './api-keys-policy.js';
import ApprovalNotificationsProvider from './approval-notifications.js';
import ApprovalTimeoutProvider from './approval-timeout.js';
import ApprovalsProvider from '../approvals-service.js';
import AuthorizationResourcesProvider from './authorization-resources.js';
import BizDictProvider from './biz-dict.js';
import CodesProvider from './codes.js';
import DocFilesProvider from './doc-files.js';
import DocPrintProvider from './doc-print.js';
import DepartmentMutationsProvider from './department-mutations.js';
import DepartmentProvider from './departments.js';
import DevToolsGuardProvider from './dev-tools-guard.js';
import EmployeesProvider from './employee-service.js';
import FinanceProvider from './finance.js';
import EmployeeMutationsProvider from './employees.js';
import FeedbackReminderProvider from './feedback-reminder.js';
import ImportToolProvider from './import-tool.js';
import InventoryProvider from './inventory.js';
import ItemsProvider from './items.js';
import IqcProvider from './iqc.js';
import KnowledgeAccessProvider from './knowledge-access.js';
import LifecycleProvider from './lifecycles.js';
import NotificationManagementProvider from './notification-management.js';
import OrdersProvider from './orders.js';
import PurchaseRequestsProvider from './purchase-requests.js';
import QuotationsProvider from './quotations.js';
import FinanceRequestsProvider from './finance-requests.js';
import OrderLedgerProvider from './order-ledger.js';
import OrderReviewsProvider from './order-reviews.js';
import PartnersProvider from './partners.js';
import QualityDraftingProvider from './quality-drafting.js';
import QualityModelGatewayProvider from './quality-model-gateway.js';
import QualityScreeningProvider from './quality-screening.js';
import ShiftsProvider from './shifts.js';
import StaffBaselineProvider from './staff-baseline.js';
import StocktakingProvider from './stocktaking.js';
import TransferProvider from './transfer.js';
import SubmissionProvider from './submission.js';
import TicketNotificationsProvider from './ticket-notifications.js';
import type { ApplicationServiceProviderConstructor } from '@nocobase/app-server/application';

const serviceProviders: readonly ApplicationServiceProviderConstructor[] = [
  // R-037 / R-073：生产常驻的启动守卫，排在最前面 —— 开发工具的开关在非开发环境写了开启，
  // 别的提供者还没启动就先失败。
  DevToolsGuardProvider,
  SubmissionProvider,
  // R-016：统一发号器，内部服务；没有页面与端点，顺序无关。
  CodesProvider,
  // R-021 加片：单据附件的盘存储与绑定服务；无调用方时也能被容器解析。
  DocFilesProvider,
  // R-076：打印数据与痕迹的只读/追加服务；无调用方时也能被容器解析。
  DocPrintProvider,
  // R-026：七天提醒，进程内每天一次的扫单任务。
  FeedbackReminderProvider,
  DepartmentProvider,
  DepartmentMutationsProvider,
  // R-011：读服务、内部服务与写服务。放在用户管理服务之后由容器按需解析，顺序无关。
  EmployeesProvider,
  // R-065：支出与到票的读写服务；登记顺序无关。
  FinanceProvider,
  EmployeeMutationsProvider,
  // R-025：内部只读服务、HTTP 读服务与写服务。无调用方时也能被容器解析。
  ShiftsProvider,
  // R-014：往来单位的读服务与写服务；发号器由 CodesProvider 提供，顺序无关。
  PartnersProvider,
  // R-019：物料、单位、分类的读服务与写服务；发号器由 CodesProvider 提供。
  ItemsProvider,
  // R-020：仓库、单据、现存量与流水的读服务与写服务；过账在写服务里取行锁。
  InventoryProvider,
  // R-070：采购检验单的读写服务；入库挂点在库存写服务里按需调用，顺序无关。
  IqcProvider,
  // R-020 波 1：盘点与调拨复用库存过账，登记顺序无关。
  StocktakingProvider,
  TransferProvider,
  // R-068：导入工具，进程内令牌 + 三步端点共用的写服务；无页面资源、无种子。
  ImportToolProvider,
  // R-021/R-022：订单读写服务；生成单据复用库存写服务，回写由 order-progress 挂在过账事务里。
  OrdersProvider,
  // R-021 波 1 加片：请购单读写服务；submit 建审批单，终态回写挂在 lifecycle 回调上。
  PurchaseRequestsProvider,
  // R-022 复刻波 1：报价单读写服务；转单复用 OrdersProvider 的建单服务。顺序无关。
  QuotationsProvider,
  // R-066：请款单读写服务；submit 建审批单，终态回写挂在 lifecycle 回调上。
  FinanceRequestsProvider,
  // R-072：业务字典的读服务与写服务；assertActiveCodes 供各单据片共用。无调用方时也可解析。
  BizDictProvider,
  // R-064：订单评审的读写服务与总台账的只读投影；无调用方时也能被容器解析。
  OrderReviewsProvider,
  OrderLedgerProvider,
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
  // R-017 M3：审批端点共用的业务服务；单一 lifecycle 运行时已在上面登记。
  ApprovalsProvider,
  // R-003 S8：五张站内通知模板，效果在流转/派单提交之后才发。
  TicketNotificationsProvider,
  ApprovalNotificationsProvider,
  // R-017 M4：进程内每小时扫一次任务级超时、流程级触发器与效果记录清理。
  ApprovalTimeoutProvider,
  // R-026：建「人」的账号时指派基线角色 staff。开发工具的演示账户也是建人：它们在主组合之后才登记
  // （见 `server/embedded.ts` 的开发环境入口），所以自然排在这一项后面。
  StaffBaselineProvider,
  ApiKeysPolicyProvider,
];

export default serviceProviders;
