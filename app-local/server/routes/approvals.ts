import {
  authenticationToken,
  type AuthEnv,
} from '@nocobase/app-plugin-authentication';
import {
  authorizationToken,
  type AuthorizationEnv,
} from '@nocobase/app-plugin-authorization/server';
import type { Application } from '@nocobase/app-server/application';
import {
  AuthorizationDeniedError,
  type AuthorizationDecision,
  type CompositeResourceConditions,
} from '@nocobase/authorization/core';
import { databaseManagerToken, type RepositoryPolicy } from '@nocobase/db';
import {
  ApiError,
  apiErrorResponse,
  dataResponse,
  apiValidator,
  defineApiRoutes,
  describeRoute,
  listResponse,
  type AppApiRouteContribution,
} from '@nocobase/app-server/router';
import { Hono, type Context } from 'hono';
import { z } from 'zod';

import {
  AddSignBody,
  ApprovalIdParam,
  CandidatesQuery,
  CreateApprovalBody,
  DelegateBody,
  DecideBody,
  MineQuery,
  ReturnBody,
  TaskIdParam,
  TasksQuery,
  UpdateApprovalBody,
} from './approval-schemas.js';
import {
  approvalsServiceToken,
  type ApprovalRow,
  type RecordRow,
} from '../approvals-service.js';

type ApprovalContext = Context<AuthEnv & AuthorizationEnv>;
type Decision = AuthorizationDecision<CompositeResourceConditions>;

/** 422 没有共享错误响应组件，照其它路由就地声明。 */
const unprocessableResponse = {
  description: 'The request violates an approval rule (422).',
  content: {
    'application/json': {
      schema: { $ref: '#/components/schemas/ApiErrorBody' },
    },
  },
} as const;

const errorResponses = {
  '400': apiErrorResponse(400),
  '401': apiErrorResponse(401),
  '403': apiErrorResponse(403),
  '404': apiErrorResponse(404),
  '409': apiErrorResponse(409),
  '422': unprocessableResponse,
  '500': apiErrorResponse(500),
} as const;

/**
 * 一个请求只授权一次；拿到决策里的数据库范围后再查内容。
 * `require` 不能用：业务动作的结果是「有条件放行」，require 对它一律拒绝。
 */
async function authorizeApproval(
  context: ApprovalContext,
  action: 'submit' | 'review',
): Promise<Decision> {
  const decision = await context.get('authz').authorize({
    resource: { type: 'composite', id: 'approval' },
    action,
  });
  if (decision.effect === 'deny' || decision.conditions?.database === undefined) {
    throw new AuthorizationDeniedError(decision);
  }
  return decision;
}

/**
 * 详情端点要给申请人与审批人两类调用者：两个业务动作各问一次，各拿各的范围。
 * 没有对应范围就当作没有这项业务授权，统一落到 404，不用 403 暴露编号是否存在。
 */
async function optionalApprovalDecision(
  context: ApprovalContext,
  action: 'submit' | 'review',
  collection: string,
): Promise<Decision | undefined> {
  const decision = await context.get('authz').authorize({
    resource: { type: 'composite', id: 'approval' },
    action,
  });
  return decision.effect !== 'deny' && decision.conditions?.database?.[collection]
    ? decision
    : undefined;
}

function policyOf(decision: Decision, collection: string): RepositoryPolicy {
  const policy = decision.conditions?.database?.[collection];
  if (!policy) throw new AuthorizationDeniedError(decision);
  return policy;
}

function actorOf(context: ApprovalContext): { readonly id: string } {
  const session = context.get('auth');
  const user = session?.user;
  if (user?.id === undefined || String(user.id).length === 0) {
    throw new ApiError({
      status: 'UNAUTHENTICATED',
      reason: 'AUTHENTICATION_REQUIRED',
      domain: 'approvals',
      message: 'An authenticated user is required.',
    });
  }
  // 服务账号只经 API key 起作用，业务端点不给。
  if ((user as { kind?: unknown }).kind === 'service') {
    throw new ApiError({
      status: 'PERMISSION_DENIED',
      reason: 'SERVICE_ACCOUNT_NOT_ALLOWED',
      domain: 'approvals',
      message: 'Service accounts cannot use approval endpoints.',
    });
  }
  return { id: String(user.id) };
}

function requireOrigin(context: ApprovalContext): void {
  const origin = context.req.header('origin');
  if (origin === undefined || origin.trim().length === 0) {
    throw new ApiError({
      status: 'PERMISSION_DENIED',
      reason: 'INVALID_CSRF_ORIGIN',
      domain: 'approvals',
      message: 'The request origin is not trusted for a cookie-authenticated write.',
    });
  }
}

function notFoundError(kind: 'APPROVAL' | 'TASK'): ApiError {
  return new ApiError({
    status: 'NOT_FOUND',
    reason: `${kind}_NOT_FOUND`,
    domain: 'approvals',
    message: 'The requested record was not found.',
  });
}

/** 仓储返回的是 Partial；补齐标识后才交给服务层，避免 undefined 悄悄传下去。 */
function fullApproval(row: Partial<ApprovalRow> | undefined): ApprovalRow | undefined {
  return typeof row?.id === 'string' ? (row as ApprovalRow) : undefined;
}
function fullTask(row: Partial<RecordRow> | undefined): RecordRow | undefined {
  return typeof row?.id === 'string' && typeof row.roundId === 'string'
    ? (row as RecordRow)
    : undefined;
}

function asBody(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : {};
}

export const apiRoutes: AppApiRouteContribution<Application> = defineApiRoutes((app) => {
  const router = new Hono<AuthEnv & AuthorizationEnv>();
  const auth = app.container.resolve(authenticationToken);
  const authz = app.container.resolve(authorizationToken);
  const database = app.container.resolve(databaseManagerToken);
  const service = app.container.resolve(approvalsServiceToken);

  // 没有全局兜底：每个路由自己挂登录与授权中间件，授权动作在 handler 里逐条做。
  router.use('/approvals', auth.required(), authz.middleware());
  router.use('/approvals/*', auth.required(), authz.middleware());

  router.get(
    '/approvals/mine',
    describeRoute({
      tags: ['Approvals'],
      summary: 'List my approval requests',
      operationId: 'listMyApprovals',
      responses: {
        '200': listResponse(z.unknown()),
        ...errorResponses,
      },
    }),
    apiValidator('query', MineQuery),
    async (context) => {
      const decision = await authorizeApproval(context, 'submit');
      actorOf(context);
      const query = context.req.valid('query');
      const statuses: Record<string, readonly string[]> = {
        active: ['draft', 'submitted', 'processing', 'returned'],
        completed: ['approved', 'rejected', 'aborted'],
        all: [...statusesAll],
      };
      const rows = await database
        .connection()
        .repository<ApprovalRow>('approvals')
        .withPolicy(policyOf(decision, 'approvals'))
        .findMany({
          filter: (filter) =>
            filter.or(
              [...statuses[query.scope]].map((status) =>
                filter.string('status').eq(status),
              ),
            ),
          limit: query.pageSize,
          offset: (query.page - 1) * query.pageSize,
        });
      const visible = query.q
        ? rows.filter((row) =>
            `${row.collectionName} ${row.dataKey} ${row.workflowKey}`
              .toLowerCase()
              .includes(query.q!.toLowerCase()),
          )
        : rows;
      return context.json({
        data: visible.map((row) => ({
          id: row.id,
          status: row.status,
          currentRound: row.currentRound,
          workflowKey: row.workflowKey,
          collectionName: row.collectionName,
          dataKey: row.dataKey,
          lifecycleVersion: row.lifecycleVersion,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        })),
        meta: { page: query.page, pageSize: query.pageSize, total: visible.length },
      });
    },
  );

  router.get(
    '/approvals/tasks',
    describeRoute({
      tags: ['Approvals'],
      summary: 'List my approval tasks',
      operationId: 'listApprovalTasks',
      responses: { '200': listResponse(z.unknown()), ...errorResponses },
    }),
    apiValidator('query', TasksQuery),
    async (context) => {
      const decision = await authorizeApproval(context, 'review');
      const query = context.req.valid('query');
      const rows = await database
        .connection()
        .repository<RecordRow>('approvalRecords')
        .withPolicy(policyOf(decision, 'approvalRecords'))
        .findMany({
          filter: (filter) =>
            filter.or(
              (query.scope === 'pending'
                ? ['pending', 'assigned']
                : ['approved', 'rejected', 'returned', 'delegated', 'unprocessed', 'withdrawn']
              ).map((status) => filter.string('status').eq(status)),
            ),
          limit: query.pageSize,
          offset: (query.page - 1) * query.pageSize,
        });
      const rounds = rows.length === 0
        ? []
        : await database
            .connection()
            .repository<{ id: string; approvalId: string }>('approvalRounds')
            .findMany({
              filter: (filter) =>
                filter.or(
                  rows.map((row) =>
                    filter.string('id').eq(String(row.roundId ?? '')),
                  ),
                ),
            });
      const approvalIds = rounds.map((round) => round.approvalId);
      const approvals = approvalIds.length === 0
        ? []
        : await database
            .connection()
            .repository<ApprovalRow>('approvals')
            .findMany({
              filter: (filter) =>
                filter.or(approvalIds.map((id) => filter.string('id').eq(id))),
            });
      const inProgress = new Set(
        approvals
          .filter((row) => row.status === 'submitted' || row.status === 'processing')
          .map((row) => String(row.id ?? '')),
      );
      const roundById = new Map(
        rounds.map((round) => [String(round.id ?? ''), round]),
      );
      const visible = rows.filter((row) => {
        const round = roundById.get(String(row.roundId ?? ''));
        return round !== undefined && inProgress.has(String(round.approvalId ?? ''));
      });
      return context.json({
        data: visible.map((row) => ({
          id: row.id,
          approvalId: roundById.get(String(row.roundId ?? ''))?.approvalId ?? '',
          nodeKey: row.nodeKey,
          status: row.status,
          seq: row.seq,
          dueAt: row.dueAt ?? null,
        })),
        meta: { page: query.page, pageSize: query.pageSize, total: visible.length },
      });
    },
  );

  router.get(
    '/approvals/tasks/:id/candidates',
    describeRoute({
      tags: ['Approvals'],
      summary: 'Search candidates for one approval task',
      operationId: 'approvalTaskCandidates',
      responses: { '200': listResponse(z.unknown()), ...errorResponses },
    }),
    apiValidator('param', TaskIdParam),
    apiValidator('query', CandidatesQuery),
    async (context) => {
      const decision = await authorizeApproval(context, 'review');
      const actor = actorOf(context);
      const { id } = context.req.valid('param');
      const query = context.req.valid('query');
      const task = await database
        .connection()
        .repository<RecordRow>('approvalRecords')
        .withPolicy(policyOf(decision, 'approvalRecords'))
        .findOne({ filter: { id } });
      // 别人调与任务不存在返回同一个 404，不能靠它探测编号是否存在。
      const ownTask = fullTask(task);
      if (!ownTask || ownTask.assigneeId !== actor.id) throw notFoundError('TASK');
      const round = await database
        .connection()
        .repository<{ id: string; approvalId: string; snapshot: unknown }>('approvalRounds')
        .findOne({ filter: { id: ownTask.roundId } });
      if (!round?.id || !round.approvalId) throw notFoundError('TASK');
      const approval = await database
        .connection()
        .repository<ApprovalRow>('approvals')
        .findOne({ filter: { id: round.approvalId } });
      const foundApproval = fullApproval(approval);
      if (!foundApproval) throw notFoundError('TASK');
      const result = await service.candidates(
        ownTask,
        foundApproval,
        query.type === 'delegate' ? 'delegate' : 'add',
        query.q,
        query.page,
        query.pageSize,
      );
      return context.json({
        data: result.rows,
        meta: { page: query.page, pageSize: query.pageSize, total: result.total },
      });
    },
  );

  router.get(
    '/approvals/:id',
    describeRoute({
      tags: ['Approvals'],
      summary: 'Get one approval request',
      operationId: 'getApproval',
      responses: { '200': dataResponse(z.unknown()), ...errorResponses },
    }),
    apiValidator('param', ApprovalIdParam),
    async (context) => {
      // 两个动作都在读内容之前授权；没有范围的人连审批单编号都读不到。
      const submitDecision = await optionalApprovalDecision(context, 'submit', 'approvals');
      const reviewDecision = await optionalApprovalDecision(context, 'review', 'approvalRecords');
      const actor = actorOf(context);
      const { id } = context.req.valid('param');
      let foundApproval: ApprovalRow | undefined;
      if (submitDecision) {
        const approval = await database
          .connection()
          .repository<ApprovalRow>('approvals')
          .withPolicy(policyOf(submitDecision, 'approvals'))
          .findOne({ filter: { id } });
        foundApproval = fullApproval(approval);
      }
      const reviewerTasks: RecordRow[] = [];
      // 双重身份也要取任务：available 是申请人动作与审批人动作的并集。
      if (reviewDecision) {
        // 先用 review 的「仅本人」范围取本人任务，再按轮次认领这张单；已处理的任务也算。
        const ownRecords = await database
          .connection()
          .repository<RecordRow>('approvalRecords')
          .withPolicy(policyOf(reviewDecision, 'approvalRecords'))
          .findMany({ filter: { assigneeId: actor.id } });
        if (ownRecords.length > 0) {
          const rounds = await database
            .connection()
            .repository<{ id: string; approvalId: string }>('approvalRounds')
            .findMany({
              filter: (filter) =>
                filter.or(
                  ownRecords.map((row) => filter.string('id').eq(String(row.roundId ?? ''))),
                ),
            });
          const ownRoundIds = new Set(
            rounds.filter((round) => round.approvalId === id).map((round) => String(round.id ?? '')),
          );
          if (ownRoundIds.size > 0) {
            for (const row of ownRecords) {
              const task = fullTask(row);
              if (task && ownRoundIds.has(task.roundId)) reviewerTasks.push(task);
            }
            const approval = await database
              .connection()
              .repository<ApprovalRow>('approvals')
              .findOne({ filter: { id } });
            foundApproval = fullApproval(approval);
          }
        }
      }
      if (!foundApproval) throw notFoundError('APPROVAL');
      const detail = await service.detail(foundApproval, actor, reviewerTasks);
      // 审批人只回姓名：详情里的记录不带姓名以外的用户资料，更没有邮箱、手机号。
      return context.json({
        data: {
          ...detail,
          records: detail.records.map((record) => ({
            id: record.id,
            roundId: record.roundId,
            nodeKey: record.nodeKey,
            status: record.status,
            seq: record.seq,
            origin: record.origin ?? 'normal',
            assigneeName: (record as { assigneeName?: string | null }).assigneeName ?? null,
            comment: record.comment ?? null,
            actedAt: record.actedAt ?? null,
            prevRecordId: record.prevRecordId ?? null,
          })),
        },
      });
    },
  );

  router.post(
    '/approvals',
    describeRoute({
      tags: ['Approvals'],
      summary: 'Create an approval request',
      operationId: 'createApproval',
      responses: { '201': dataResponse(z.unknown()), ...errorResponses },
    }),
    apiValidator('json', CreateApprovalBody),
    async (context) => {
      const decision = await authorizeApproval(context, 'submit');
      requireOrigin(context);
      const actor = actorOf(context);
      const body = context.req.valid('json');
      const created = await service.create(
        {
          collectionName: body.collectionName,
          dataKey: body.dataKey,
          workflowKey: body.workflowKey,
          data: asBody(body.data),
          submit: body.submit,
        },
        actor,
        policyOf(decision, 'approvals'),
      );
      return context.json(
        {
          data: {
            id: created.id,
            status: created.status,
            currentRound: created.currentRound,
            lifecycleVersion: created.lifecycleVersion,
          },
        },
        201,
      );
    },
  );

  router.patch(
    '/approvals/:id',
    describeRoute({
      tags: ['Approvals'],
      summary: 'Update a draft or resubmit a returned approval',
      operationId: 'updateApproval',
      responses: { '200': dataResponse(z.unknown()), ...errorResponses },
    }),
    apiValidator('param', ApprovalIdParam),
    apiValidator('json', UpdateApprovalBody),
    async (context) => {
      const decision = await authorizeApproval(context, 'submit');
      requireOrigin(context);
      const actor = actorOf(context);
      const { id } = context.req.valid('param');
      const body = context.req.valid('json');
      const approval = await database
        .connection()
        .repository<ApprovalRow>('approvals')
        .withPolicy(policyOf(decision, 'approvals'))
        .findOne({ filter: { id } });
      const found = fullApproval(approval);
      if (!found) throw notFoundError('APPROVAL');
      const updated = await service.update(found, {
        data: body.data === undefined ? undefined : asBody(body.data),
        submit: body.submit,
      }, actor);
      return context.json({ data: viewOf(updated) });
    },
  );

  for (const action of ['withdraw', 'abort'] as const) {
    router.post(
      `/approvals/:id/${action}`,
      describeRoute({
        tags: ['Approvals'],
        summary: `${action} an approval request`,
        operationId: `${action}Approval`,
        responses: { '200': dataResponse(z.unknown()), ...errorResponses },
      }),
      apiValidator('param', ApprovalIdParam),
      async (context) => {
        const decision = await authorizeApproval(context, 'submit');
        requireOrigin(context);
        const actor = actorOf(context);
        const { id } = context.req.valid('param');
        const approval = await database
          .connection()
          .repository<ApprovalRow>('approvals')
          .withPolicy(policyOf(decision, 'approvals'))
          .findOne({ filter: { id } });
        const found = fullApproval(approval);
        if (!found) throw notFoundError('APPROVAL');
        const changed = action === 'withdraw'
          ? await service.withdraw(found, actor)
          : await service.abort(found, actor);
        return context.json({ data: viewOf(changed) });
      },
    );
  }

  const decisions = [
    { path: 'approve', schema: DecideBody, action: 'approve' },
    { path: 'reject', schema: DecideBody, action: 'reject' },
    { path: 'return', schema: ReturnBody, action: 'return' },
  ] as const;
  for (const entry of decisions) {
    router.post(
      `/approvals/tasks/:id/${entry.path}`,
      describeRoute({
        tags: ['Approvals'],
        summary: `${entry.path} an approval task`,
        operationId: `${entry.action}ApprovalTask`,
        responses: { '200': dataResponse(z.unknown()), ...errorResponses },
      }),
      apiValidator('param', TaskIdParam),
      apiValidator('json', entry.schema),
      async (context) => {
        const decision = await authorizeApproval(context, 'review');
        requireOrigin(context);
        const actor = actorOf(context);
        const { id } = context.req.valid('param');
        const body = context.req.valid('json') as {
          comment?: string;
          data?: Record<string, unknown>;
          returnToNodeKey?: string;
        };
        const task = await database
          .connection()
          .repository<RecordRow>('approvalRecords')
          .withPolicy(policyOf(decision, 'approvalRecords'))
          .findOne({ filter: { id } });
        const ownTask = fullTask(task);
        if (!ownTask || ownTask.assigneeId !== actor.id) throw notFoundError('TASK');
        const round = await database
          .connection()
          .repository<{ id: string; approvalId: string }>('approvalRounds')
          .findOne({ filter: { id: ownTask.roundId } });
        if (!round?.id || !round.approvalId) throw notFoundError('TASK');
        const approval = await database
          .connection()
          .repository<ApprovalRow>('approvals')
          .findOne({ filter: { id: round.approvalId } });
        const found = fullApproval(approval);
        if (!found) throw notFoundError('TASK');
        const changed = await service.act(
          ownTask,
          found,
          entry.action,
          {
            comment: body.comment,
            data: body.data,
            returnToNodeKey: body.returnToNodeKey,
          },
          actor,
        );
        return context.json({ data: viewOf(changed) });
      },
    );
  }

  for (const entry of [
    { path: 'delegate', schema: DelegateBody, action: 'delegate' },
    { path: 'add-sign', schema: AddSignBody, action: 'addSign' },
  ] as const) {
    router.post(
      `/approvals/tasks/:id/${entry.path}`,
      describeRoute({
        tags: ['Approvals'],
        summary: `${entry.path} an approval task`,
        operationId: `${entry.action}ApprovalTask`,
        responses: { '200': dataResponse(z.unknown()), ...errorResponses },
      }),
      apiValidator('param', TaskIdParam),
      apiValidator('json', entry.schema),
      async (context) => {
        const decision = await authorizeApproval(context, 'review');
        requireOrigin(context);
        const actor = actorOf(context);
        const { id } = context.req.valid('param');
        const body = context.req.valid('json') as {
          toUserId?: string;
          userIds?: readonly string[];
          comment?: string;
          position?: 'before' | 'after';
        };
        const task = await database
          .connection()
          .repository<RecordRow>('approvalRecords')
          .withPolicy(policyOf(decision, 'approvalRecords'))
          .findOne({ filter: { id } });
        const ownTask = fullTask(task);
        if (!ownTask || ownTask.assigneeId !== actor.id) throw notFoundError('TASK');
        const round = await database
          .connection()
          .repository<{ id: string; approvalId: string; snapshot: unknown }>('approvalRounds')
          .findOne({ filter: { id: ownTask.roundId } });
        if (!round?.id || !round.approvalId) throw notFoundError('TASK');
        const approval = await database
          .connection()
          .repository<ApprovalRow>('approvals')
          .findOne({ filter: { id: round.approvalId } });
        const foundApproval = fullApproval(approval);
        if (!foundApproval) throw notFoundError('TASK');
        const changed = await service.act(ownTask, foundApproval, entry.action, {
          comment: body.comment,
          toUserId: body.toUserId,
          userIds: body.userIds,
          position: body.position,
        }, actor);
        return context.json({ data: viewOf(changed) });
      },
    );
  }

  return new Hono().route('/', router);
});

const statusesAll = ['draft', 'submitted', 'processing', 'returned', 'approved', 'rejected', 'aborted'] as const;

function viewOf(row: ApprovalRow) {
  return {
    id: row.id,
    status: row.status,
    currentRound: row.currentRound,
    lifecycleVersion: row.lifecycleVersion,
  };
}
