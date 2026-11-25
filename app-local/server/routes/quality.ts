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
import {
  databaseManagerToken,
  type DatabaseConnection,
  type RepositoryPolicy,
} from '@nocobase/db';
import {
  ApiError,
  apiErrorResponse,
  apiValidator,
  dataResponse,
  defineApiRoutes,
  describeRoute,
  executeIdempotentMutation,
  listResponse,
  repositoryIdempotencyToken,
  type AppApiRouteContribution,
} from '@nocobase/app-server/router';
import { Hono, type Context } from 'hono';
import { randomUUID } from 'node:crypto';

import {
  ApproveScreeningBody,
  IngestMessageBody,
  IngestResultSchema,
  ListTicketsQuery,
  MessageSchema,
  ScreeningListItemSchema,
  ScreeningSchema,
  TicketSchema,
  type IngestMessageInput,
} from './schemas.js';
import { qualityScreeningToken } from '../providers/quality-screening.js';

type FqcAction = 'view' | 'handle' | 'intake';
type FqcTable = 'fqcMessages' | 'fqcScreenings' | 'fqcTickets';
type FqcDecision = AuthorizationDecision<CompositeResourceConditions>;

/**
 * `fqc` 的一次业务动作授权。
 *
 * 一个请求只授权一次；返回的每张表的范围用 `withPolicy` 绑上再查。事后不再调
 * `policyFor` —— 它会折上下文的四条 CRUD 决策，等于拿别的动作的授权把范围放宽。
 * 也不能用 `require`：业务动作授权成功的结果是「有条件放行」，`require` 对它一律拒绝。
 *
 * 被拒（业务动作本身 deny，或决策里没带数据库条件）就在这一步抛 403
 * `AUTHORIZATION_DENIED`，后面碰请求头、开事务之前就已经结束了。
 */
async function authorizeFqc(
  context: Context<AuthEnv & AuthorizationEnv>,
  action: FqcAction,
): Promise<FqcDecision> {
  const decision = await context.get('authz').authorize({
    resource: { type: 'composite', id: 'fqc' },
    action,
  });
  if (
    decision.effect === 'deny' ||
    decision.conditions?.database === undefined
  ) {
    throw new AuthorizationDeniedError(decision);
  }
  return decision;
}

/**
 * 一张表的范围。
 *
 * 业务动作的声明覆盖它组合的每张表，框架对每张表都会给出
 * `{ read, create, update, delete }` 四个键，所以这个键不会缺；这里只是声明与代码
 * 不一致时的兜底，绝不退化成不带范围的查询。
 *
 * 单张表被拒时范围会折叠成 `false`（不是缺键），实际表现是：读被拒是 403
 * `READ_FORBIDDEN`（domain `app`）；复核先按范围读，被排除的行与不存在同形，得到
 * 404 `SCREENING_NOT_FOUND`，行不会被改。投递不受影响：新建不解析数据范围。
 */
function policyOf(decision: FqcDecision, table: FqcTable): RepositoryPolicy {
  const policy = decision.conditions?.database?.[table];
  if (!policy) {
    throw new AuthorizationDeniedError(decision);
  }
  return policy;
}

/**
 * 置信度写进 `decimal(5, 4)` 列（标度 4 见迁移 `202611220001_create_fqc_demo`）。投递
 * 不带读、不回读，201 由这次写入的值拼，所以这里按列的读回形态给文本：驱动以文本
 * 读回 numeric 的方言（Postgres）保留列的标度（`"0.7500"`），以数字读回的方言
 * （SQLite）按数字转文本（`"0.75"`）。两种形态都与列表端点随后读到的同一条逐字一致。
 */
function confidenceText(confidence: number, dialect: string): string {
  return dialect === 'sqlite' ? String(confidence) : confidence.toFixed(4);
}

/**
 * `datetime` 列的读回形态：主机本地墙钟、毫秒三位、不带时区。
 *
 * 与仓储写入时的归一化一致，也与列表端点读回来的文字一致；投递不回读，响应直接
 * 用这个形态，201 里的时间才与随后的读取相等（`Date` 经 JSON 会变成 UTC 的 `Z` 形态）。
 */
function storedDateTime(value: Date): string {
  const pad = (part: number) => String(part).padStart(2, '0');
  return (
    `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}` +
    `T${pad(value.getHours())}:${pad(value.getMinutes())}:${pad(value.getSeconds())}.${String(
      value.getMilliseconds(),
    ).padStart(3, '0')}`
  );
}

/**
 * 客户消息接入与 AI 初筛派单。
 *
 * 链路：消息入库 → 规则/模型初筛 → 生成工单。
 * 与 raw/项目决策/2026-11-22-客服FQC-AI场景细化.md 描述一致：
 * AI 不对外回复，只做记录、初筛、派发。
 *
 * 端点授权照 R-013：登录校验之后挂 `authz.middleware()`，每个请求只 `authorize` 一次，
 * 读到的每张表用返回的范围 `withPolicy` 绑上。投递另认 API 密钥与幂等键。
 */
export const apiRoutes: AppApiRouteContribution<Application> = defineApiRoutes(
  (app) => {
    const router = new Hono<AuthEnv & AuthorizationEnv>();
    const auth = app.container.resolve(authenticationToken);
    const authz = app.container.resolve(authorizationToken);
    const screening = app.container.resolve(qualityScreeningToken);
    const database = app.container.resolve(databaseManagerToken);

    /**
     * 投递在同一个事务里写三张表，每张表用「投递」决策给出的范围。
     *
     * 「投递」不带读，所以用 `createMany` 写、不要求回读：`createOne` 会把刚落库的
     * 记录读回来当返回值，而读在投递的授权里是 false（READ_FORBIDDEN）。响应由这次
     * 写入的值组成，写入的内容与以前一致；时间与置信度按列的读回形态给，201 与随后
     * 从列表端点读到的同一条逐字段相等。
     */
    async function ingestOnce(
      input: IngestMessageInput,
      transaction: DatabaseConnection,
      policies: {
        readonly messages: RepositoryPolicy;
        readonly screenings: RepositoryPolicy;
        readonly tickets: RepositoryPolicy;
      },
    ) {
      const now = new Date();
      const receivedAt = input.receivedAt ? new Date(input.receivedAt) : now;
      const storedNow = storedDateTime(now);
      const result = screening.screen(input.content);

      const message = {
        id: randomUUID(),
        channel: input.channel,
        externalId: input.externalId ?? null,
        senderName: input.senderName ?? null,
        senderContact: input.senderContact ?? null,
        content: input.content,
        rawContentType: input.contentType,
        receivedAt: storedDateTime(receivedAt),
        status: 'screened',
        createdAt: storedNow,
        updatedAt: storedNow,
      };
      await transaction
        .repository('fqcMessages')
        .withPolicy(policies.messages)
        .createMany({ values: [message] });

      const record = {
        id: randomUUID(),
        messageId: message.id,
        category: result.category,
        severity: result.severity,
        suggestedOwner: result.suggestedOwner,
        summary: result.summary,
        confidence: confidenceText(result.confidence, transaction.dialect),
        evidence: result.evidence,
        modelName: 'rule-baseline',
        outcome: result.confidence >= 0.5 ? 'auto' : 'needs-review',
        createdAt: storedNow,
        updatedAt: storedNow,
      };
      await transaction
        .repository('fqcScreenings')
        .withPolicy(policies.screenings)
        .createMany({ values: [record] });

      const ticket = {
        id: randomUUID(),
        code: `FQC-${String(now.getTime()).slice(-8)}`,
        title: `${result.category} / ${result.severity}`,
        description: input.content.slice(0, 2000),
        sourceMessageId: message.id,
        screeningId: record.id,
        category: result.category,
        severity: result.severity,
        ownerDepartment: result.suggestedOwner,
        assigneeId: null,
        state: 'open',
        dueAt: null,
        closedAt: null,
        createdAt: storedNow,
        updatedAt: storedNow,
      };
      await transaction
        .repository('fqcTickets')
        .withPolicy(policies.tickets)
        .createMany({ values: [ticket] });

      return { message, screening: record, ticket };
    }

    // 先登录，再授权。投递的调用方是服务账号的 API 密钥：这类密钥不带范围也按带范围
    // 处理，不写 `scopedKeys: true` 就一律 403。其余端点的调用方是浏览器会话。
    router.use(
      '/quality/intake',
      auth.required({ scopedKeys: true }),
      authz.middleware(),
    );
    router.use('/quality/tickets', auth.required(), authz.middleware());
    router.use('/quality/tickets/*', auth.required(), authz.middleware());
    router.use('/quality/messages', auth.required(), authz.middleware());
    router.use('/quality/screenings', auth.required(), authz.middleware());
    router.use('/quality/screenings/*', auth.required(), authz.middleware());

    // 外部渠道回调：企业微信/微信网关把客户消息推到这里。
    // 授权一次「投递」；三张表的写入在同一个事务里完成，写入的内容与以前一致。
    // 幂等键由框架的 executeIdempotentMutation 管：同一个键重复投递返回第一次的结果，
    // 同键异体是 409 OPERATION_CONFLICT。收据与业务写在同一个事务里。
    router.post(
      '/quality/intake',
      describeRoute({
        tags: ['Quality'],
        summary: 'Ingest a customer message and screen it',
        operationId: 'ingestQualityMessage',
        responses: {
          '201': dataResponse(IngestResultSchema),
          '400': apiErrorResponse(400),
          '401': apiErrorResponse(401),
          '403': apiErrorResponse(403),
          '409': apiErrorResponse(409),
          '500': apiErrorResponse(500),
        },
      }),
      apiValidator('json', IngestMessageBody),
      async (context) => {
        const body = context.req.valid('json');
        // 先授权再碰请求头：没有投递资格的人一律 403，不因缺键先得到 400。
        const decision = await authorizeFqc(context, 'intake');
        const key = context.req.header('Idempotency-Key');
        if (!key) {
          throw new ApiError({
            status: 'INVALID_ARGUMENT',
            reason: 'OPERATION_KEY_REQUIRED',
            domain: 'quality',
            message: 'Quality intake requires an Idempotency-Key header.',
          });
        }
        const protection = app.container.resolve(repositoryIdempotencyToken);
        const principal = await protection.principal(context);
        if (!principal) {
          throw new ApiError({
            status: 'PERMISSION_DENIED',
            reason: 'PRINCIPAL_REQUIRED',
            domain: 'quality',
            message: 'An authenticated principal is required.',
          });
        }
        const result = await executeIdempotentMutation({
          connection: database.connection(),
          key,
          principal,
          operation: `${context.req.method} ${new URL(context.req.url).pathname}`,
          input: body,
          // 每次请求（含重放）认证与上面的 authorize 都重新跑过，这里无需重复。
          authorize: () => undefined,
          // 投递的授权不带读，重放不检查「结果还可见」；返回的是第一次落库的结果。
          authorizeReplay: () => undefined,
          execute: (transaction) =>
            ingestOnce(body, transaction, {
              messages: policyOf(decision, 'fqcMessages'),
              screenings: policyOf(decision, 'fqcScreenings'),
              tickets: policyOf(decision, 'fqcTickets'),
            }),
        });
        context.header('Idempotency-Replayed', String(result.replayed));
        return context.json({ data: result.data }, 201);
      },
    );

    router.get(
      '/quality/tickets',
      describeRoute({
        tags: ['Quality'],
        summary: 'List quality tickets',
        operationId: 'listQualityTickets',
        responses: {
          '200': listResponse(TicketSchema),
          '401': apiErrorResponse(401),
          '403': apiErrorResponse(403),
          '500': apiErrorResponse(500),
        },
      }),
      apiValidator('query', ListTicketsQuery),
      async (context) => {
        const { state, ownerDepartment, page, pageSize } =
          context.req.valid('query');
        const decision = await authorizeFqc(context, 'view');
        const filter: Record<string, string> = {};
        if (state) {
          filter.state = state;
        }
        if (ownerDepartment) {
          filter.ownerDepartment = ownerDepartment;
        }
        const repo = database
          .repository('fqcTickets')
          .withPolicy(policyOf(decision, 'fqcTickets'));
        const scoped = Object.keys(filter).length > 0;
        const rows = await repo.findMany({
          ...(scoped ? { filter } : {}),
          limit: pageSize,
          offset: (page - 1) * pageSize,
          sort: {
            kind: 'sort',
            version: 1,
            items: [{ kind: 'field', path: ['createdAt'], direction: 'desc' }],
          },
        });
        const total = await (scoped ? repo.count({ filter }) : repo.count());
        return context.json({
          data: rows,
          meta: { page, pageSize, total },
        });
      },
    );

    router.get(
      '/quality/messages',
      describeRoute({
        tags: ['Quality'],
        summary: 'List ingested customer messages',
        operationId: 'listQualityMessages',
        responses: {
          '200': listResponse(MessageSchema),
          '401': apiErrorResponse(401),
          '403': apiErrorResponse(403),
          '500': apiErrorResponse(500),
        },
      }),
      async (context) => {
        const decision = await authorizeFqc(context, 'view');
        const repo = database
          .repository('fqcMessages')
          .withPolicy(policyOf(decision, 'fqcMessages'));
        const rows = await repo.findMany({
          limit: 50,
          sort: {
            kind: 'sort',
            version: 1,
            items: [{ kind: 'field', path: ['receivedAt'], direction: 'desc' }],
          },
        });
        const total = await repo.count();
        return context.json({
          data: rows,
          meta: { page: 1, pageSize: 50, total },
        });
      },
    );

    router.get(
      '/quality/screenings',
      describeRoute({
        tags: ['Quality'],
        summary: 'List AI screening records',
        operationId: 'listQualityScreenings',
        responses: {
          '200': listResponse(ScreeningListItemSchema),
          '401': apiErrorResponse(401),
          '403': apiErrorResponse(403),
          '500': apiErrorResponse(500),
        },
      }),
      async (context) => {
        const decision = await authorizeFqc(context, 'view');
        const repo = database
          .repository('fqcScreenings')
          .withPolicy(policyOf(decision, 'fqcScreenings'));
        const rows = await repo.findMany({
          limit: 50,
          sort: {
            kind: 'sort',
            version: 1,
            items: [{ kind: 'field', path: ['createdAt'], direction: 'desc' }],
          },
        });
        const total = await repo.count();
        // 每行带一个「这一行处于可以确认的状态」。只看这一行的状态：是「待人工复核」
        // 就为真。调用的人有没有处理权限不在这里判 —— 那要在同一个请求里再授权一次。
        // 前端把 canReview 与 useCan 合起来决定按钮显不显示。
        return context.json({
          data: rows.map((row) => ({
            ...row,
            canReview: row.outcome === 'needs-review',
          })),
          meta: { page: 1, pageSize: 50, total },
        });
      },
    );

    // 人工复核：低置信度初筛由质量人员确认或改判。读与改都走带范围的仓储。
    router.post(
      '/quality/screenings/:screeningId/review',
      describeRoute({
        tags: ['Quality'],
        summary: 'Review and correct an AI screening',
        operationId: 'reviewQualityScreening',
        responses: {
          '200': dataResponse(ScreeningSchema),
          '401': apiErrorResponse(401),
          '403': apiErrorResponse(403),
          '404': apiErrorResponse(404),
          '500': apiErrorResponse(500),
        },
      }),
      apiValidator('json', ApproveScreeningBody),
      async (context) => {
        const screeningId = context.req.param('screeningId');
        const body = context.req.valid('json');
        const decision = await authorizeFqc(context, 'handle');
        const repo = database
          .repository('fqcScreenings')
          .withPolicy(policyOf(decision, 'fqcScreenings'));
        const existing = await repo.findOne({
          filter: { id: screeningId },
        });
        if (!existing) {
          throw new ApiError({
            status: 'NOT_FOUND',
            reason: 'SCREENING_NOT_FOUND',
            domain: 'quality',
            message: `Screening ${screeningId} was not found.`,
          });
        }
        await repo.updateOne({
          filter: { id: screeningId },
          values: {
            ...(body.category ? { category: body.category } : {}),
            ...(body.severity ? { severity: body.severity } : {}),
            ...(body.ownerDepartment
              ? { suggestedOwner: body.ownerDepartment }
              : {}),
            outcome: 'reviewed',
            updatedAt: new Date(),
          },
        });
        const updated = await repo.findOne({
          filter: { id: screeningId },
        });
        return context.json({ data: updated });
      },
    );

    return new Hono().route('/', router);
  },
);
