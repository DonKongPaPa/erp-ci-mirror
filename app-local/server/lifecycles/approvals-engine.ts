import {
  type FireExpectation,
  type ReviewerResolverContext,
  type ReviewerSelector,
  normalizeReviewerSelections,
  resolveReviewerSelections,
  type ReviewerSelection,
} from '@nocobase/lifecycle';

/**
 * R-017 S3：审批引擎的纯函数层。
 *
 * lifecycle 只回答「这张单在什么状态、谁可以做哪个动作」。节点顺序、票数聚合、
 * 任务级到期与并发谓词都是审批语义，库里没有，所以写在这里：全部无 I/O，
 * 依赖以参数注入，测试可以直接调用。需要仓储原子性的只有最后一步
 * （`updateRecordIf` / `fire` 的版本条件），判定产物由本文件给出。
 */

// ---- 数票 ---------------------------------------------------------------

export type NegotiationMode = 'any' | 'all' | 'vote';
export type TaskStatus =
  | 'assigned'
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'returned'
  | 'unprocessed'
  | 'delegated'
  | 'withdrawn';
export type NodeDecision = 'approved' | 'rejected' | 'pending';

export interface ApprovalRecordLike {
  readonly id: string;
  readonly nodeKey: string;
  readonly status: TaskStatus;
  readonly seq: number;
  readonly origin?: 'normal' | 'delegated' | 'added';
  readonly assigneeId?: string;
  readonly dueAt?: string | Date | null;
  readonly lastRemindedAt?: string | Date | null;
}

export interface VoteRule {
  /** 协商规则：或签 / 会签 / 投票；省略按会签。 */
  readonly negotiation?: NegotiationMode;
  /** order=true 时只开放序号最小的未决任务；结论仍按协商规则算。 */
  readonly order?: boolean;
  /** 投票的通过率阈值；省略默认 0.5，必须严格大于才算通过。 */
  readonly threshold?: number;
}

export interface NodeDecisionResult {
  readonly decision: NodeDecision;
  /** 结论落定时，其余未投的票要置为 unprocessed 的记录 id。 */
  readonly settleIds: readonly string[];
  /** order=true 时当前开放的记录 id；其余模式为空。 */
  readonly openIds: readonly string[];
}

/**
 * 计票集 = {pending, assigned, approved, rejected}：delegated / withdrawn 已退场，
 * unprocessed / returned 已收场，都不进分母（调研 §1.3、§6.3，R-017.md:400）。
 */
const isCounted = (record: ApprovalRecordLike) =>
  record.status === 'pending' ||
  record.status === 'assigned' ||
  record.status === 'approved' ||
  record.status === 'rejected';

/** 未决 = pending + assigned：assigned 已指派但还没开放，仍是一张没投的票。 */
const isOpen = (record: ApprovalRecordLike) =>
  record.status === 'pending' || record.status === 'assigned';

/**
 * 一个节点的数票结论。顺序（order）与协商规则（negotiation）是两个独立字段：
 * order 只决定开放哪一张未决任务，结论由协商规则决定（R-017.md:256-258）。
 *
 * - 或签：任一通过即过，其余未决票（含 assigned）收场；没有未决且无人通过才拒。
 * - 会签：任一拒绝即拒；没有未决、没有拒绝、至少一条通过才过。
 * - 投票：通过率严格大于阈值（默认 0.5）才过；转交退场的记录不进分母。
 * - 顺序：只开放序号最小的未决任务，结论仍按上面的协商规则算。
 */
export function decideNode(
  records: readonly ApprovalRecordLike[],
  rule: VoteRule,
): NodeDecisionResult {
  const negotiation = rule.negotiation ?? 'all';
  const counted = records.filter(isCounted);
  const approved = counted.filter((record) => record.status === 'approved');
  const rejected = counted.filter((record) => record.status === 'rejected');
  const open = counted.filter(isOpen);

  let decision: NodeDecision = 'pending';
  if (negotiation === 'any') {
    if (approved.length > 0) decision = 'approved';
    else if (open.length === 0) decision = 'rejected';
  } else if (negotiation === 'all') {
    if (rejected.length > 0) decision = 'rejected';
    else if (open.length === 0 && approved.length > 0) decision = 'approved';
  } else {
    const threshold = rule.threshold ?? 0.5;
    if (counted.length > 0 && approved.length / counted.length > threshold) {
      decision = 'approved';
    } else if (open.length === 0 && counted.length > 0) {
      decision = 'rejected';
    }
  }

  if (decision !== 'pending') {
    return {
      decision,
      settleIds: open.map((record) => record.id),
      openIds: [],
    };
  }
  if (!rule.order) return { decision, settleIds: [], openIds: [] };
  const next = [...open].sort((a, b) => a.seq - b.seq)[0];
  return { decision, settleIds: [], openIds: next ? [next.id] : [] };
}

// ---- 节点计划：条件分支 -------------------------------------------------

export interface ApprovalNode {
  readonly key: string;
  /** 省略按会签。 */
  readonly negotiation?: NegotiationMode;
  readonly order?: boolean;
  readonly threshold?: number;
  readonly reviewers: readonly ReviewerSelection[];
  readonly canDelegate?: boolean;
  readonly canAddSign?: boolean;
}

export interface NodePlanParameters {
  /** 金额严格大于这个值才走加签的那条链；阈值是参数，不写死在流程里。 */
  readonly extraApprovalThreshold?: number;
  readonly extraNode?: ApprovalNode;
}

export interface NodePlanContext {
  readonly amount: number;
  readonly parameters: NodePlanParameters;
}

/**
 * 审批链上「多一级」由节点计划算出来：目标状态不变，中间多一个节点。
 * lifecycle 的 `route` 只用于在多个目标状态之间选，两者不是一回事
 * （R-017.md 2026-11-24 的第二次更正）。
 */
export function planApprovalNodes(
  nodes: readonly ApprovalNode[],
  context: NodePlanContext,
): readonly ApprovalNode[] {
  const { extraApprovalThreshold, extraNode } = context.parameters;
  if (
    extraNode === undefined ||
    extraApprovalThreshold === undefined ||
    !Number.isFinite(context.amount) ||
    context.amount <= extraApprovalThreshold
  ) {
    return nodes;
  }
  if (nodes.some((node) => node.key === extraNode.key)) return nodes;
  return [...nodes, extraNode];
}

// ---- 审批人选择器 -------------------------------------------------------

export interface DepartmentReference {
  readonly id: string;
  readonly managerId?: string | null;
}

export interface ReviewerServices {
  /** 静态用户组：referenceId 是配置里的稳定标识，不是逗号串。 */
  readonly usersOf?: (
    referenceId: string,
  ) => Promise<readonly string[]> | readonly string[];
  /** 部门一律按编码查，不按内部 id。 */
  readonly departmentByCode: (
    code: string,
  ) => Promise<DepartmentReference | null>;
  readonly contextValue?: (
    key: string,
    context: ReviewerResolverContext,
  ) =>
    | Promise<readonly string[] | string | undefined>
    | readonly string[]
    | string
    | undefined;
  readonly eligible: (
    userId: string,
    context: ReviewerResolverContext,
  ) => Promise<boolean> | boolean;
}

const REVIEWER_TYPES = ['users', 'department', 'context'] as const;

function asIds(
  value: readonly string[] | string | undefined,
): readonly string[] {
  if (typeof value === 'string') return value ? [value] : [];
  return value ?? [];
}

/**
 * 三种选择器：静态用户、部门负责人（按编码解析）、上下文变量。
 * 组内取交集、组间取并集、最后过资格，这三层语义是框架钉死的，直接复用。
 */
export function createApprovalReviewerResolver(services: ReviewerServices) {
  const selectors: Record<string, ReviewerSelector> = {
    users: async (referenceId) => asIds(await services.usersOf?.(referenceId)),
    department: async (code) => {
      const department = await services.departmentByCode(code);
      return department?.managerId ? [department.managerId] : [];
    },
    context: async (referenceId, context) =>
      asIds(await services.contextValue?.(referenceId, context)),
  };

  return async (
    selections: readonly ReviewerSelection[],
    context: ReviewerResolverContext,
  ): Promise<readonly string[]> => {
    // normalize 已经逐项核过 shape，只是返回类型是宽 JsonValue。
    const checked = normalizeReviewerSelections(
      selections,
      REVIEWER_TYPES,
    ) as unknown as ReviewerSelection[];
    return resolveReviewerSelections(checked, context, {
      selectors,
      eligible: async (userId, eligibleContext) =>
        services.eligible(userId, eligibleContext),
    });
  };
}

// ---- 任务级超时与并发谓词 -----------------------------------------------

const timeOf = (value: string | Date): number =>
  value instanceof Date ? value.getTime() : new Date(value).getTime();

/** 「到期没有处理」：仍是待处理，且已到它自己的 dueAt。 */
export function isTaskOverdue(
  task: Pick<ApprovalRecordLike, 'status' | 'dueAt'>,
  now: Date,
): boolean {
  if (
    task.status !== 'pending' ||
    task.dueAt === null ||
    task.dueAt === undefined
  ) {
    return false;
  }
  const due = timeOf(task.dueAt);
  return Number.isFinite(due) && due <= now.getTime();
}

/** 提醒只发一次的第一道门：到期、待处理，且还没提醒过。第二道是通知的幂等键。 */
export function isReminderDue(
  task: Pick<ApprovalRecordLike, 'status' | 'dueAt' | 'lastRemindedAt'>,
  now: Date,
): boolean {
  return (
    isTaskOverdue(task, now) &&
    (task.lastRemindedAt === null || task.lastRemindedAt === undefined)
  );
}

/**
 * 页面显示的版本号放进 `expect`，让服务端决策在同一版本上条件更新；
 * 输的一方的 409 由客户端重试。没有版本号的旧记录按 null 匹配。
 */
export function approvalExpectation(
  record: Pick<
    { readonly lifecycleVersion?: number | null },
    'lifecycleVersion'
  >,
): FireExpectation {
  return { version: record.lifecycleVersion ?? null };
}

/**
 * 任务行的抢占谓词：只有 status 仍是 pending 的条件更新才写得到。
 * 返回的是判定产物，真正的原子写由调用方的 updateMany / updateRecordIf 做。
 */
export function pendingTaskClaim(
  task: Pick<ApprovalRecordLike, 'id' | 'status'>,
) {
  return {
    id: task.id,
    where: { status: 'pending' as const },
  };
}
