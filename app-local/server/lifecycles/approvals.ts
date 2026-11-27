import {
  defineLifecycle,
  type EffectContext,
  type JsonObject,
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
  /** 流程级超时：在同一状态停留超过这个毫秒数就催办。 */
  readonly processTimeoutMs: number;
}

/** 效果在转移提交之后才拿到服务；测试工具没有注入服务时效果直接跳过。 */
export interface ApprovalServices {
  notifyApproval(event: {
    readonly kind: 'submit' | 'approve' | 'reject' | 'sendBack' | 'reminder';
    readonly approvalId: string;
    readonly workflowKey: string;
    readonly applicantId: string;
    readonly version: number;
  }): Promise<boolean>;
}

export interface ApprovalTypes {
  record: Approval;
  state: ApprovalStatus;
  parameters: ApprovalParameters;
  services: ApprovalServices;
}

const hasNodeKey = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

/** 提交之后才跑的通知效果；幂等键由通知服务按事件与版本算。 */
const notifyEffect = (
  kind: 'submit' | 'approve' | 'reject' | 'sendBack' | 'reminder',
) => ({
  name: `approval-notify-${kind}`,
  run: ({ record, services }: EffectContext<ApprovalTypes>) => {
    const notify = (services as Partial<ApprovalServices> | undefined)?.notifyApproval;
    if (!notify) return false;
    const input = record as unknown as JsonObject & {
      id: string;
      workflowKey: string;
      applicantId: string;
      lifecycleVersion?: number;
    };
    return notify({
      kind,
      approvalId: String(input.id),
      workflowKey: String(input.workflowKey),
      applicantId: String(input.applicantId),
      version: Number(input.lifecycleVersion ?? 0),
    });
  },
});

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
    parameters: {
      extraApprovalThreshold: 100,
      processTimeoutMs: 24 * 60 * 60 * 1000,
    },
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
        effects: [notifyEffect('submit')],
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
        effects: [notifyEffect('approve')],
      },
      reject: {
        from: ['submitted', 'processing'],
        to: 'rejected',
        manual: false,
        effects: [notifyEffect('reject')],
      },
      sendBack: {
        from: ['submitted', 'processing'],
        to: ['returned', 'processing'],
        route: ({ input }) =>
          hasNodeKey(input.returnToNodeKey) ? 'processing' : 'returned',
        manual: false,
        effects: [notifyEffect('sendBack')],
      },
      // 流程级超时催办：原地自转移，版本前进、状态不变，可以反复催。
      remind: {
        from: ['submitted', 'processing'],
        to: ['submitted', 'processing'],
        route: ({ record }) => record.status,
        manual: false,
        effects: [notifyEffect('reminder')],
      },
      withdraw: { from: 'submitted', to: 'draft' },
      abort: { from: ['draft', 'submitted', 'processing'], to: 'aborted' },
    },
    // 触发器由定时 sweep 执行；只找在 submitted/processing 停留够久的单。
    triggers: {
      remindIdle: {
        transition: 'remind',
        when: ['submitted', 'processing'],
        after: ({ processTimeoutMs }) => processTimeoutMs,
        batchSize: 50,
      },
    },
  });
