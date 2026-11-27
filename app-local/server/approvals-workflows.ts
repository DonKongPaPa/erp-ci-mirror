import type { ReviewerSelection } from '@nocobase/lifecycle';

import type { ApprovalNode } from './lifecycles/approvals-engine.js';

/**
 * R-017 M3：流程定义（写代码，不做设计器）。
 *
 * 审批链上多一级由节点计划算，阈值是参数；lifecycle 的 route 只选目标状态。
 * 第一版用上下文选择器：审批人与候选人标识都放在提交快照里，由服务端解析，
 * 不开放「按用户表条件查询」的通用选择器（R-028）。
 *
 * 每个允许转交或加签的节点都配了独立的候选人范围；没配就是空范围，端点返回空、
 * 转交与加签被拒（设计「转交与加签」一节）。
 */
export interface ApprovalWorkflowNode extends ApprovalNode {
  readonly delegateCandidates?: readonly ReviewerSelection[];
  readonly addCandidates?: readonly ReviewerSelection[];
  /** 只有这一个节点配了超时；dueAt 由服务端写进任务行。 */
  readonly dueAfterMs?: number;
}

export interface ApprovalWorkflow {
  readonly key: string;
  readonly nodes: readonly ApprovalWorkflowNode[];
  /** 金额字段：严格大于 lifecycle 参数里的阈值才追加 extraNode 那条链。 */
  readonly amountField: string;
  readonly extraNode?: ApprovalWorkflowNode;
}

const CONTEXT = (referenceId: string): ReviewerSelection => ({
  group: 1,
  type: 'context',
  referenceId,
});

const managerNode: ApprovalWorkflowNode = {
  key: 'manager',
  negotiation: 'all',
  reviewers: [CONTEXT('approvers')],
  canDelegate: true,
  canAddSign: true,
  delegateCandidates: [CONTEXT('candidates')],
  addCandidates: [CONTEXT('candidates')],
  dueAfterMs: 24 * 60 * 60 * 1000,
};

const extraNode: ApprovalWorkflowNode = {
  key: 'finance',
  negotiation: 'all',
  reviewers: [CONTEXT('financeApprovers')],
  // 金额链上的财务复核不允许转交与加签；没配范围就是空范围。
};

export const APPROVAL_WORKFLOWS: Readonly<Record<string, ApprovalWorkflow>> = {
  leave: {
    key: 'leave',
    nodes: [managerNode],
    amountField: 'amount',
    extraNode,
  },
  simple: {
    key: 'simple',
    nodes: [{ ...managerNode, dueAfterMs: undefined }],
    amountField: 'amount',
  },
  /**
   * R-021 波 1 加片：单节点、无阈值；审批人由业务片按部门编码解析后放进提交快照的
   * `approvers`（R-017 的 context 选择器），金额字段只供节点计划读取，不额外加级。
   */
  purchase_request: {
    key: 'purchase_request',
    nodes: [{
      key: 'manager',
      negotiation: 'all',
      reviewers: [CONTEXT('approvers')],
    }],
    amountField: 'estimatedTotal',
  },
};

export function workflowOf(key: string): ApprovalWorkflow | undefined {
  return APPROVAL_WORKFLOWS[key];
}

/** 取快照里的用户标识数组；不是非空字符串数组就当作没配（空范围）。 */
export function snapshotIds(
  snapshot: unknown,
  key: string,
): readonly string[] {
  if (snapshot === null || typeof snapshot !== 'object') return [];
  const value = (snapshot as Record<string, unknown>)[key];
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is string => typeof entry === 'string' && entry.length > 0,
  );
}
