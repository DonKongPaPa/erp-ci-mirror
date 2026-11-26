import {
  defineLifecycle,
  type Lifecycle,
  type LifecycleRecord,
} from '@nocobase/lifecycle';

/**
 * R-017 S3：审批单的 lifecycle 定义。全应用只有这一个通用定义，
 * 具体「走哪条链、谁审」由 `workflowKey` 指向的代码定义与节点计划决定。
 *
 * 状态住在 approvals 自己的 `status` 列；`lifecycleDefinition` 存定义的 name，
 * 不存状态（R-017.md 2026-11-24 修订①）。三列都用框架默认名：
 * `statusChangedAt` / `lifecycleVersion`（definition.d.ts 的默认值正好一致）。
 *
 * 结论转移（approve/reject/sendBack）与过程转移（process/delegate/addSign）
 * 都是服务端在数票后触发的，所以 manual:false：标准路由不给按钮，页面只从
 * 详情端点拿到可用动作。转交与加签是版本号前进的自转移，起点含 processing
 * 时终点仍是 processing（R-017.md「转交与加签」一节）。
 *
 * `route` 只用于多目标状态：不指定节点的退回进终态 returned，申请人改完重提
 * 开新轮次；指定节点时同一轮回到 processing 重开那个节点的任务。审批链多一级
 * 不是 route 的事，由 approvals-engine 的节点计划算（设计 2026-11-24 第二次更正）。
 */
export const APPROVAL_STATUSES = [
  'draft',
  'submitted',
  'processing',
  'approved',
  'rejected',
  'returned',
  'aborted',
] as const;

export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

export interface Approval extends LifecycleRecord {
  readonly status: ApprovalStatus;
  readonly workflowKey: string;
  readonly applicantId: string;
  readonly currentRound: number;
}

export interface ApprovalParameters {
  /** 金额严格大于它才走多一级的那条链；由宿主在注册时覆盖。 */
  readonly extraApprovalThreshold: number;
}

export interface ApprovalTypes {
  record: Approval;
  state: ApprovalStatus;
  parameters: ApprovalParameters;
  services: Record<string, never>;
}

const hasNodeKey = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

export const approvalsLifecycle: Lifecycle<ApprovalTypes> =
  defineLifecycle<ApprovalTypes>({
    name: 'approvals',
    key: 'approvals',
    version: 1,
    definitionField: 'lifecycleDefinition',
    stateField: 'status',
    changedAtField: 'statusChangedAt',
    versionField: 'lifecycleVersion',
    initial: 'draft',
    parameters: { extraApprovalThreshold: 100 },
    states: [
      'draft',
      'submitted',
      'processing',
      'returned',
      { name: 'approved', final: true },
      { name: 'rejected', final: true },
      { name: 'aborted', final: true },
    ],
    transitions: {
      submit: {
        from: ['draft', 'returned'],
        to: 'submitted',
        // 退回重提是新一轮；第一次提交把 0 推进到 1。
        set: ({ record }) => ({
          currentRound: (Number(record.currentRound) || 0) + 1,
        }),
      },
      process: { from: 'submitted', to: 'processing', manual: false },
      delegate: {
        from: ['submitted', 'processing'],
        to: 'processing',
        manual: false,
      },
      addSign: {
        from: ['submitted', 'processing'],
        to: 'processing',
        manual: false,
      },
      approve: {
        from: ['submitted', 'processing'],
        to: 'approved',
        manual: false,
      },
      reject: {
        from: ['submitted', 'processing'],
        to: 'rejected',
        manual: false,
      },
      sendBack: {
        from: ['submitted', 'processing'],
        to: ['returned', 'processing'],
        route: ({ input }) =>
          hasNodeKey(input.returnToNodeKey) ? 'processing' : 'returned',
        manual: false,
      },
      withdraw: { from: 'submitted', to: 'draft' },
      abort: { from: ['draft', 'submitted', 'processing'], to: 'aborted' },
    },
  });
