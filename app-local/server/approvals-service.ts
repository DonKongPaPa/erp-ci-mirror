import { randomUUID } from 'node:crypto';

import type { Application } from '@nocobase/app-server/application';
import { ApiError } from '@nocobase/app-server/router';
import {
  databaseManagerToken,
  type DatabaseConnection,
  type DatabaseManager,
  type RepositoryPolicy,
} from '@nocobase/db';
import { LifecycleError, type ReviewerSelection } from '@nocobase/lifecycle';
import { createServiceToken, ServiceProvider, type ServiceToken } from '@nocobase/service-provider';

import {
  snapshotIds,
  workflowOf,
  type ApprovalWorkflowNode,
} from './approvals-workflows.js';
import {
  APPROVAL_STATUSES,
  type ApprovalStatus,
} from './lifecycles/approvals.js';
import {
  approvalExpectation,
  createApprovalReviewerResolver,
  decideNode,
  pendingTaskClaim,
  planApprovalNodes,
  type ApprovalRecordLike,
} from './lifecycles/approvals-engine.js';
import { lifecycleRuntimeToken } from './providers/lifecycles.js';
import { peopleQueryServiceToken, type PeopleQueryService } from './providers/departments.js';

/**
 * R-017 M3：审批端点的服务端业务层。
 *
 * 行级资格在端点先用带范围的仓储判过（拿不到就 404），这里只接已经过资格的行。
 * 三张表的业务写入与 lifecycle 转移在同一个真事务里：先写轮次/任务行，再 fire，
 * 转移被拒就整体回滚。所有状态列都由 lifecycle 写，服务层不直接改它们。
 */
export type ApprovalActor = { readonly id: string };

export interface ApprovalRow {
  readonly id: string;
  readonly collectionName: string;
  readonly dataKey: string;
  readonly workflowKey: string;
  readonly status: ApprovalStatus;
  readonly applicantId: string;
  readonly currentRound: number;
  readonly lifecycleDefinition: string | null;
  readonly statusChangedAt: string | Date | null;
  readonly lifecycleVersion: number;
  readonly createdAt: string | Date;
  readonly updatedAt: string | Date;
}

export interface RoundRow {
  readonly id: string;
  readonly approvalId: string;
  readonly round: number;
  readonly status: string;
  readonly snapshot: unknown;
  readonly startedAt: string | Date;
  readonly endedAt: string | Date | null;
}

export interface RecordRow extends ApprovalRecordLike {
  readonly roundId: string;
  readonly comment?: string | null;
  readonly actedAt?: string | Date | null;
  readonly prevRecordId?: string | null;
}

export interface CreateApprovalInput {
  readonly collectionName: string;
  readonly dataKey: string;
  readonly workflowKey: string;
  readonly data: Record<string, unknown>;
  readonly submit: boolean;
}

export interface ActionInput {
  readonly comment?: string;
  readonly data?: Record<string, unknown>;
  readonly returnToNodeKey?: string;
  readonly toUserId?: string;
  readonly userIds?: readonly string[];
  readonly position?: 'before' | 'after';
}

const asText = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 ? value : null;

function approvalError(
  status: 'NOT_FOUND' | 'ABORTED' | 'FAILED_PRECONDITION' | 'INVALID_ARGUMENT',
  reason: string,
  message: string,
  httpStatus?: 422,
): ApiError {
  return new ApiError({
    status,
    reason,
    domain: 'approvals',
    message,
    ...(httpStatus === undefined ? {} : { httpStatus }),
  });
}

const notFound = (kind: 'APPROVAL' | 'TASK') =>
  approvalError('NOT_FOUND', `${kind}_NOT_FOUND`, 'The requested record was not found.');

/** lifecycle 的拒绝统一映射：版本竞争 409，守卫/校验 422，其余原样抛出。 */
export function approvalLifecycleError(error: unknown): ApiError {
  if (error instanceof LifecycleError) {
    if (error.code === 'CONFLICT') {
      return approvalError('ABORTED', 'APPROVAL_CONFLICT', 'The approval changed concurrently; reload and retry.');
    }
    if (error.code === 'GUARD_REJECTED' || error.code === 'INVALID_INPUT' || error.code === 'INVALID_STATE') {
      return approvalError('FAILED_PRECONDITION', 'APPROVAL_TRANSITION_REJECTED', error.message, 422);
    }
  }
  throw error;
}

/** 快照里取上下文选择器的值；三个键分别给审批人、候选人与财务复核人。 */
function contextResolver(snapshot: unknown) {
  const values: Record<string, readonly string[]> = {
    approvers: snapshotIds(snapshot, 'approvers'),
    candidates: snapshotIds(snapshot, 'candidates'),
    financeApprovers: snapshotIds(snapshot, 'financeApprovers'),
  };
  return createApprovalReviewerResolver({
    departmentByCode: async () => null,
    contextValue: async (key: string) => values[key] ?? [],
    eligible: async () => true,
  });
}

async function resolveIds(
  selections: readonly ReviewerSelection[] | undefined,
  snapshot: unknown,
): Promise<readonly string[]> {
  if (!selections || selections.length === 0) return [];
  return contextResolver(snapshot)(selections, {
    scope: 'app',
    ...(snapshot !== null && typeof snapshot === 'object'
      ? (snapshot as Record<string, unknown>)
      : {}),
  } as never);
}

export interface ApprovalDetail {
  readonly id: string;
  readonly status: ApprovalStatus;
  readonly currentRound: number;
  readonly lifecycleVersion: number;
  readonly workflowKey: string;
  readonly collectionName: string;
  readonly dataKey: string;
  readonly rounds: readonly RoundRow[];
  readonly records: readonly RecordRow[];
  readonly available: readonly string[];
}

export interface CandidateRow {
  readonly id: string;
  readonly name: string | null;
  readonly username: string | null;
}

/**
 * 详情里的五个审批人动作名，与写端点的路径同名（页面据此显隐按钮）。
 * 审批单 lifecycle 里这些转移是系统转移，不出现在 runtime.available() 里。
 */
export const REVIEWER_ACTIONS = [
  'approve',
  'reject',
  'return',
  'delegate',
  'add-sign',
] as const;

/**
 * 审批动作的同一套 guard：写的端点校验与详情 available 都问它。
 * 只判业务前置条件（本人任务待处理、单据在进行中），不代替端点授权与行级资格。
 */
export function reviewerActionGuard(
  task: Pick<ApprovalRecordLike, 'status'> | undefined,
  approval: Pick<ApprovalRow, 'status'>,
): { readonly allowed: boolean; readonly reason?: 'TASK_ALREADY_ACTED' | 'APPROVAL_NOT_IN_PROGRESS' } {
  if (task === undefined || task.status !== 'pending') {
    return { allowed: false, reason: 'TASK_ALREADY_ACTED' };
  }
  if (approval.status !== 'submitted' && approval.status !== 'processing') {
    return { allowed: false, reason: 'APPROVAL_NOT_IN_PROGRESS' };
  }
  return { allowed: true };
}

export class ApprovalsService {
  public constructor(
    private readonly database: DatabaseManager,
    private readonly runtime: import('@nocobase/lifecycle').LifecycleRuntime,
    private readonly people: PeopleQueryService,
  ) {}

  private connection(): DatabaseConnection {
    return this.database.connection();
  }

  /**
   * 详情：审批记录只回姓名（由端点裁列），不带邮箱手机号。
   * `reviewerTasks` 是端点用 review 的「仅本人」范围取到的、属于这张单的任务；
   * 只有这些任务上的动作才能进 available，申请人侧的动作仍限申请人本人。
   */
  async detail(
    approval: ApprovalRow,
    actor: ApprovalActor,
    reviewerTasks: readonly RecordRow[] = [],
  ): Promise<ApprovalDetail> {
    const rounds = await this.connection()
      .repository<RoundRow>('approvalRounds')
      .findMany({ filter: { approvalId: approval.id } });
    const roundIds = rounds.map((round) => round.id);
    const records = roundIds.length === 0
      ? []
      : await this.connection()
          .repository<RecordRow>('approvalRecords')
          .findMany({
            filter: (filter) =>
              filter.or(roundIds.map((id) => filter.string('roundId').eq(id))),
          });
    const available = await this.runtime.available('approvals', approval.id, {
      id: actor.id,
    });
    // 审批人只回姓名：按标识解析成姓名一列，不回邮箱、手机号或完整用户资料。
    const people = await this.people.byIds(
      records
        .map((record) => record.assigneeId)
        .filter((id): id is string => typeof id === 'string'),
    );
    const names = new Map(people.map((person) => [person.id, person.name]));
    return {
      id: approval.id,
      status: approval.status,
      currentRound: approval.currentRound,
      lifecycleVersion: approval.lifecycleVersion,
      workflowKey: approval.workflowKey,
      collectionName: approval.collectionName,
      dataKey: approval.dataKey,
      rounds,
      records: records.map((record) => ({
        ...record,
        assigneeName: names.get(record.assigneeId ?? '') ?? null,
      })),
      available: [
        ...new Set([
          ...(approval.applicantId === actor.id
            ? available.filter((entry) => entry.allowed).map((entry) => entry.name)
            : []),
          ...(reviewerTasks.some((task) => reviewerActionGuard(task, approval).allowed)
            ? REVIEWER_ACTIONS
            : []),
        ]),
      ],
    };
  }

  /**
   * 建单。草稿只插 approvals 一行；submit=true 时同一事务开第 1 轮、写审批任务、
   * 再走 submit 转移。审批人解析为空时拒绝提交（422），不建任何任务。
   */
  async create(
    input: CreateApprovalInput,
    actor: ApprovalActor,
    policy: RepositoryPolicy,
    /** 业务单据片传入自己的事务，让审批单与业务状态在同一事务里落库。 */
    connection?: DatabaseConnection,
  ): Promise<ApprovalRow> {
    const workflow = workflowOf(input.workflowKey);
    if (!workflow) {
      throw approvalError('INVALID_ARGUMENT', 'WORKFLOW_NOT_FOUND', 'Unknown workflowKey.', 422);
    }
    const id = randomUUID();
    const now = new Date();
    const work = async (tx: DatabaseConnection): Promise<ApprovalRow> => {
      const created = await tx
        .repository<ApprovalRow>('approvals')
        .withPolicy(policy)
        .createOne({
          values: {
            id,
            collectionName: input.collectionName,
            dataKey: input.dataKey,
            workflowKey: input.workflowKey,
            // 初始草稿的状态与定义名由建单人写；之后的每次状态变化都只经 lifecycle。
            status: 'draft',
            lifecycleDefinition: 'approvals',
            applicantId: actor.id,
            createdAt: now,
            updatedAt: now,
          },
        });
      if (input.submit) {
        await this.openRound(tx, created.record as ApprovalRow, input.data, 1, workflow);
        await this.fire(tx, id, 'submit', actor, { data: input.data });
      }
      return await this.readApproval(tx, id);
    };
    try {
      return connection === undefined
        ? await this.connection().transaction(work)
        : await work(connection);
    } catch (error) {
      throw approvalLifecycleError(error);
    }
  }

  /** 草稿或退回后的重新提交；submit=false 只改草稿的业务列。 */
  async update(
    approval: ApprovalRow,
    input: { readonly data?: Record<string, unknown>; readonly submit: boolean },
    actor: ApprovalActor,
    connection?: DatabaseConnection,
  ): Promise<ApprovalRow> {
    if (approval.status !== 'draft' && approval.status !== 'returned') {
      throw approvalError('FAILED_PRECONDITION', 'APPROVAL_NOT_EDITABLE', 'Only a draft or returned approval can be edited.', 422);
    }
    const work = async (tx: DatabaseConnection): Promise<ApprovalRow> => {
      await tx
        .repository('approvals')
        .updateOne({
          filter: { id: approval.id },
          values: {
            collectionName: approval.collectionName,
            dataKey: approval.dataKey,
            workflowKey: approval.workflowKey,
            updatedAt: new Date(),
          },
        });
      if (input.submit) {
        const data = input.data ?? {};
        const workflow = workflowOf(approval.workflowKey);
        if (!workflow) {
          throw approvalError('INVALID_ARGUMENT', 'WORKFLOW_NOT_FOUND', 'Unknown workflowKey.', 422);
        }
        await this.openRound(tx, approval, data, approval.currentRound + 1, workflow);
        await this.fire(tx, approval.id, 'submit', actor, { data });
      }
      return await this.readApproval(tx, approval.id);
    };
    try {
      return connection === undefined
        ? await this.connection().transaction(work)
        : await work(connection);
    } catch (error) {
      throw approvalLifecycleError(error);
    }
  }

  /** 撤回：当前轮还没有人处理过才允许；轮次与任务行随转移一起收场。 */
  async withdraw(approval: ApprovalRow, actor: ApprovalActor): Promise<ApprovalRow> {
    if (approval.status !== 'submitted') {
      throw approvalError('FAILED_PRECONDITION', 'APPROVAL_NOT_WITHDRAWABLE', 'Only an unprocessed submitted approval can be withdrawn.', 422);
    }
    const round = await this.currentRoundOf(approval.id, approval.currentRound);
    const records = round === undefined
      ? []
      : await this.recordsOfRound(this.connection(), round.id);
    if (records.some((record) => record.status !== 'pending' && record.status !== 'assigned')) {
      throw approvalError('FAILED_PRECONDITION', 'APPROVAL_ALREADY_ACTED', 'Someone already acted on this round.', 422);
    }
    try {
      return await this.connection().transaction(async (tx) => {
        await this.closeRound(tx, round, 'withdrawn');
        await this.markRecords(tx, records, 'withdrawn');
        await this.fire(tx, approval.id, 'withdraw', actor, {});
        return await this.readApproval(tx, approval.id);
      });
    } catch (error) {
      throw approvalLifecycleError(error);
    }
  }

  async abort(approval: ApprovalRow, actor: ApprovalActor): Promise<ApprovalRow> {
    try {
      return await this.connection().transaction(async (tx) => {
        const round = await this.currentRoundOf(approval.id, approval.currentRound);
        await this.closeRound(tx, round, 'withdrawn');
        const records = round === undefined ? [] : await this.recordsOfRound(tx, round.id);
        await this.markRecords(tx, records, 'withdrawn');
        await this.fire(tx, approval.id, 'abort', actor, {});
        return await this.readApproval(tx, approval.id);
      });
    } catch (error) {
      throw approvalLifecycleError(error);
    }
  }

  /**
   * 审批动作：条件更新抢占任务行、数票、服务端触发结论/过程转移，全在一个事务里。
   * 拒绝时抛错回滚，不留下「任务已写、转移没记」的半截状态。
   */
  async act(
    task: RecordRow,
    approval: ApprovalRow,
    action: 'approve' | 'reject' | 'return' | 'delegate' | 'addSign',
    input: ActionInput,
    actor: ApprovalActor,
  ): Promise<ApprovalRow> {
    // 与详情 available 同一套 guard；顺序保留抢占优先于状态前置条件（验收 C7 的 409）。
    const verdict = reviewerActionGuard(task, approval);
    if (!verdict.allowed) {
      if (verdict.reason === 'TASK_ALREADY_ACTED') {
        throw approvalError('ABORTED', 'TASK_ALREADY_ACTED', 'This task has already been handled.');
      }
      throw approvalError('FAILED_PRECONDITION', 'APPROVAL_NOT_IN_PROGRESS', 'The approval is not in progress.', 422);
    }
    const round = await this.roundOf(task.roundId);
    const node = this.nodeOf(approval.workflowKey, task.nodeKey, round?.snapshot);
    try {
      return await this.connection().transaction(async (tx) => {
        const claim = pendingTaskClaim(task);
        const claimed = await tx.query
          .updateTable('approvalRecords')
          .set({ status: 'pending' })
          .where('id', '=', claim.id)
          .where('status', '=', claim.where.status)
          .execute();
        if ((claimed.updatedCount ?? 0) === 0) {
          throw approvalError('ABORTED', 'TASK_ALREADY_ACTED', 'This task has already been handled.');
        }

        if (action === 'delegate' || action === 'addSign') {
          await this.derive(tx, task, node, action, input, round?.snapshot);
          await this.fire(tx, approval.id, action, actor, {
            nodeKey: task.nodeKey,
            toUserId: input.toUserId,
            userIds: [...(input.userIds ?? [])],
          });
          return await this.readApproval(tx, approval.id);
        }

        const finalStatus = action === 'approve' ? 'approved' : action === 'reject' ? 'rejected' : 'returned';
        await tx.query
          .updateTable('approvalRecords')
          .set({ status: finalStatus, comment: asText(input.comment), actedAt: new Date() })
          .where('id', '=', task.id)
          .execute();
        const records = await this.recordsOfRound(tx, task.roundId);
        const decision = decideNode(records, {
          negotiation: node?.negotiation ?? 'all',
          order: node?.order,
          threshold: node?.threshold,
        });
        if (decision.settleIds.length > 0) {
          await this.markRecordsByIds(tx, decision.settleIds, 'unprocessed');
        }
        if (decision.openIds.length > 0) {
          await this.markRecordsByIds(tx, decision.openIds, 'pending');
        }
        if (decision.decision === 'approved') {
          await this.fire(tx, approval.id, 'approve', actor, { data: input.data ?? {} });
        } else if (decision.decision === 'rejected') {
          await this.fire(tx, approval.id, 'reject', actor, {});
        } else if (action === 'return') {
          await this.fire(tx, approval.id, 'sendBack', actor, {
            returnToNodeKey: asText(input.returnToNodeKey),
            data: input.data ?? {},
          });
        } else if (approval.status === 'submitted') {
          await this.fire(tx, approval.id, 'process', actor, {});
        }
        return await this.readApproval(tx, approval.id);
      });
    } catch (error) {
      throw approvalLifecycleError(error);
    }
  }

  /** 候选人：专属端点、只在本任务的审批人范围内搜、只回三列。 */
  async candidates(
    task: RecordRow,
    approval: ApprovalRow,
    type: 'delegate' | 'add',
    q: string,
    page: number,
    pageSize: number,
  ): Promise<{ rows: readonly CandidateRow[]; total: number }> {
    const round = await this.roundOf(task.roundId);
    const node = this.nodeOf(approval.workflowKey, task.nodeKey, round?.snapshot);
    const selections = type === 'delegate' ? node?.delegateCandidates : node?.addCandidates;
    const allowed = await resolveIds(selections, round?.snapshot);
    const records = await this.recordsOfRound(this.connection(), task.roundId);
    const exclude = [
      ...(typeof task.assigneeId === 'string' ? [task.assigneeId] : []),
      ...(type === 'add'
        ? records
            .filter((row) => row.status === 'pending' || row.status === 'assigned')
            .map((row) => row.id)
            .filter((id): id is string => typeof id === 'string')
        : []),
    ];
    const result = await this.people.search({
      q,
      userIds: allowed.length === 0 ? [] : allowed,
      excludeUserIds: exclude,
      page,
      pageSize,
    });
    return {
      rows: result.rows.map((row) => ({
        id: row.id,
        name: asText(row.name),
        username: asText(row.username),
      })),
      total: result.total,
    };
  }

  // ---- 内部 -------------------------------------------------------------

  private async readApproval(tx: DatabaseConnection, id: string): Promise<ApprovalRow> {
    const row = await tx.repository<ApprovalRow>('approvals').findOne({ filter: { id } });
    if (!row) throw notFound('APPROVAL');
    return row;
  }

  private async currentRoundOf(
    approvalId: string,
    round: number,
  ): Promise<RoundRow | undefined> {
    return this.connection()
      .repository<RoundRow>('approvalRounds')
      .findOne({ filter: { approvalId, round } });
  }

  private async roundOf(id: string): Promise<RoundRow | undefined> {
    return this.connection().repository<RoundRow>('approvalRounds').findOne({ filter: { id } });
  }

  private async recordsOfRound(
    connection: DatabaseConnection,
    roundId: string,
  ): Promise<readonly RecordRow[]> {
    return connection.repository<RecordRow>('approvalRecords').findMany({ filter: { roundId } });
  }

  private nodeOf(
    workflowKey: string,
    nodeKey: string,
    snapshot: unknown,
  ): ApprovalWorkflowNode | undefined {
    const workflow = workflowOf(workflowKey);
    if (!workflow) return undefined;
    const amount = snapshot !== null && typeof snapshot === 'object'
      ? Number((snapshot as Record<string, unknown>)[workflow.amountField])
      : Number.NaN;
    const nodes = planApprovalNodes(workflow.nodes, {
      amount,
      parameters: { extraApprovalThreshold: 100, extraNode: workflow.extraNode },
    }) as readonly ApprovalWorkflowNode[];
    return nodes.find((node) => node.key === nodeKey);
  }

  private async openRound(
    tx: DatabaseConnection,
    approval: ApprovalRow,
    data: Record<string, unknown>,
    roundNumber: number,
    workflow: NonNullable<ReturnType<typeof workflowOf>>,
  ): Promise<void> {
    const amount = Number(data[workflow.amountField]);
    const nodes = planApprovalNodes(workflow.nodes, {
      amount,
      parameters: { extraApprovalThreshold: 100, extraNode: workflow.extraNode },
    }) as readonly ApprovalWorkflowNode[];
    const roundId = randomUUID();
    const now = new Date();
    await tx.repository('approvalRounds').createOne({
      values: {
        id: roundId,
        approvalId: approval.id,
        round: roundNumber,
        status: 'processing',
        startedAt: now,
        snapshot: data,
      },
    });
    let seq = 0;
    for (const node of nodes) {
      const assignees = await resolveIds(node.reviewers, data);
      if (assignees.length === 0) {
        throw approvalError('FAILED_PRECONDITION', 'NO_REVIEWER', `Node ${node.key} has no reviewer.`, 422);
      }
      for (const assigneeId of [...new Set(assignees)]) {
        seq += 1;
        await tx.repository('approvalRecords').createOne({
          values: {
            id: randomUUID(),
            roundId,
            nodeKey: node.key,
            assigneeId,
            status: node.order ? 'assigned' : 'pending',
            seq,
            origin: 'normal',
            dueAt:
              node.dueAfterMs === undefined
                ? null
                : new Date(now.getTime() + node.dueAfterMs),
          },
        });
      }
    }
  }

  private async closeRound(
    tx: DatabaseConnection,
    round: RoundRow | undefined,
    status: string,
  ): Promise<void> {
    if (!round) return;
    await tx.query
      .updateTable('approvalRounds')
      .set({ status, endedAt: new Date() })
      .where('id', '=', round.id)
      .execute();
  }

  private async markRecords(
    tx: DatabaseConnection,
    records: readonly RecordRow[],
    status: string,
  ): Promise<void> {
    if (records.length === 0) return;
    await this.markRecordsByIds(tx, records.map((row) => row.id), status);
  }

  private async markRecordsByIds(
    tx: DatabaseConnection,
    ids: readonly string[],
    status: string,
  ): Promise<void> {
    if (ids.length === 0) return;
    await tx.query
      .updateTable('approvalRecords')
      .set({ status })
      .where('id', 'in', [...ids])
      .execute();
  }

  private async derive(
    tx: DatabaseConnection,
    task: RecordRow,
    node: ApprovalWorkflowNode | undefined,
    action: 'delegate' | 'addSign',
    input: ActionInput,
    snapshot: unknown,
  ): Promise<void> {
    const selections = action === 'delegate' ? node?.delegateCandidates : node?.addCandidates;
    const allowed = await resolveIds(selections, snapshot);
    const targets =
      action === 'delegate'
        ? input.toUserId === undefined ? [] : [input.toUserId]
        : [...(input.userIds ?? [])].filter((id): id is string => typeof id === 'string');
    if (
      !node ||
      (action === 'delegate' && !node.canDelegate) ||
      (action === 'addSign' && !node.canAddSign) ||
      targets.length === 0 ||
      targets.some((id) => !allowed.includes(id)) ||
      (action === 'delegate' &&
        task.assigneeId !== undefined &&
        targets.includes(task.assigneeId))
    ) {
      throw approvalError('FAILED_PRECONDITION', 'CANDIDATE_OUT_OF_SCOPE', 'The target is outside this node’s candidate scope.', 422);
    }
    const records = await this.recordsOfRound(tx, task.roundId);
    const maxSeq = records.reduce((max, row) => Math.max(max, Number(row.seq) || 0), 0);
    const seq = maxSeq + 1;
    for (const [index, target] of [...new Set(targets)].entries()) {
      const before = action === 'addSign' && input.position !== 'after';
      await tx.repository('approvalRecords').createOne({
        values: {
          id: randomUUID(),
          roundId: task.roundId,
          nodeKey: task.nodeKey,
          assigneeId: target,
          status: 'pending',
          seq: before ? seq - targets.length + index : seq + index,
          origin: action === 'delegate' ? 'delegated' : 'added',
          prevRecordId: task.id,
          dueAt: null,
        },
      });
    }
    if (action === 'delegate') {
      await tx.query
        .updateTable('approvalRecords')
        .set({ status: 'delegated', actedAt: new Date(), comment: asText(input.comment) })
        .where('id', '=', task.id)
        .execute();
    }
  }

  private async fire(
    tx: DatabaseConnection,
    id: string,
    transition: string,
    actor: ApprovalActor,
    input: Record<string, unknown>,
  ): Promise<void> {
    const current = await this.readApproval(tx, id);
    await this.runtime.fire('approvals', id, transition, {
      actor,
      transaction: tx,
      expect: approvalExpectation(current),
      input: input as never,
    });
  }
}

export const approvalsServiceToken: ServiceToken<ApprovalsService> =
  createServiceToken<ApprovalsService>('app/approvals-service');

/** 单独导出给端点与测试复用，避免每个文件各写一份状态集合。 */
export const APPROVAL_STATUSES_FOR_API = APPROVAL_STATUSES;

export default class ApprovalsProvider extends ServiceProvider<Application> {
  public readonly name = 'app.approvals';

  public override register(): void {
    this.app.container.singleton(approvalsServiceToken, () => {
      const database = this.app.container.resolve(databaseManagerToken);
      const runtime = this.app.container.resolve(lifecycleRuntimeToken);
      const people = this.app.container.resolve(peopleQueryServiceToken);
      return new ApprovalsService(database, runtime, people);
    });
  }
}
