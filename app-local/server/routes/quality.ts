import {
  authenticationToken,
  type AuthEnv,
} from '@nocobase/app-plugin-authentication';
import {
  authorizationToken,
  type AuthorizationEnv,
} from '@nocobase/app-plugin-authorization/server';
import type { Application } from '@nocobase/app-server/application';
import { loggingToken } from '@nocobase/app-server/logging';
import {
  AuthorizationDeniedError,
  type AuthorizationDecision,
  type CompositeResourceConditions,
} from '@nocobase/authorization/core';
import {
  databaseManagerToken,
  isUniqueConstraintViolation,
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
  DraftingStatsQuery,
  DraftingStatsSchema,
  IngestMessageBody,
  IngestResultSchema,
  ListTicketsQuery,
  MessageSchema,
  ScreeningListItemSchema,
  ScreeningReviewResultSchema,
  TicketSchema,
  type IngestMessageInput,
} from './schemas.js';
import {
  computeDraftingStats,
  confidenceText,
  qualityDraftingToken,
  screeningOutcome,
  storedDateTime,
  upgradeScreeningDraft,
  type DraftSimilarCaseSources,
} from '../providers/quality-drafting.js';
import { qualityScreeningToken } from '../providers/quality-screening.js';

type FqcAction = 'view' | 'handle' | 'intake';
type FqcTable =
  'fqcMessages' | 'fqcScreenings' | 'fqcTickets' | 'fqcScreeningReviews';
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
 * 请求自己对初筛表的读范围：重放时用它读回当前行。投递本来就不带读，所以不能拿
 * 投递决策凑；没有查看资格或读被折成 false 时回 `null`，调用方按「读不到」处理。
 */
async function readerScreeningPolicy(
  context: Context<AuthEnv & AuthorizationEnv>,
): Promise<RepositoryPolicy | null> {
  const decision = await context.get('authz').authorize({
    resource: { type: 'composite', id: 'fqc' },
    action: 'view',
  });
  if (
    decision.effect === 'deny' ||
    decision.conditions?.database === undefined
  ) {
    return null;
  }
  const screening = decision.conditions.database.fqcScreenings;
  if (!screening || screening.read === false) {
    return null;
  }
  return screening;
}

/**
 * 读相似案例用的仓储：用同一个请求主体的「查看」决策绑上范围。投递本来就不带读，
 * 所以不能拿投递决策凑；服务自己不知道调用方是谁，也不会绕开范围去读。
 *
 * 没有查看资格、或三张表里有读不到的，就不取案例（与验收 13 的「没有就为空」同形）。
 */
async function readerCaseSources(
  context: Context<AuthEnv & AuthorizationEnv>,
  connection: DatabaseConnection,
): Promise<DraftSimilarCaseSources | undefined> {
  const decision = await context.get('authz').authorize({
    resource: { type: 'composite', id: 'fqc' },
    action: 'view',
  });
  if (
    decision.effect === 'deny' ||
    decision.conditions?.database === undefined
  ) {
    return undefined;
  }
  const screenings = decision.conditions.database.fqcScreenings;
  const messages = decision.conditions.database.fqcMessages;
  const reviews = decision.conditions.database.fqcScreeningReviews;
  if (!screenings || !messages || !reviews) {
    return undefined;
  }
  if (
    screenings.read === false ||
    messages.read === false ||
    reviews.read === false
  ) {
    return undefined;
  }
  return {
    screenings: connection.repository('fqcScreenings').withPolicy(screenings),
    messages: connection.repository('fqcMessages').withPolicy(messages),
    reviews: connection
      .repository('fqcScreeningReviews')
      .withPolicy(reviews),
  };
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
    const drafting = app.container.resolve(qualityDraftingToken);
    const database = app.container.resolve(databaseManagerToken);
    const logger = app.container.has(loggingToken)
      ? app.container.resolve(loggingToken).getLogger('quality')
      : undefined;

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
        // R-026：反馈单的状态取值是 open（待处理与在办）与 discarded（已丢弃）。
        // 投递写进来的每一行都是「已经记下来的反馈」，写 open，不再写 R-013 的 screened。
        status: 'open',
        createdAt: storedNow,
        updatedAt: storedNow,
      };
      try {
        await transaction
          .repository('fqcMessages')
          .withPolicy(policies.messages)
          .createMany({ values: [message] });
      } catch (error) {
        // R-026 验收10：同一个 (channel, externalId) 再投是 409 FEEDBACK_ALREADY_RECORDED，
        // 不是不透明的 500。不先查再写：直接写，撞上迁移加的唯一约束时事务已经回滚，
        // 把驱动错误换成带原因码的 409；响应里不带已有那一行的标识（投递不带读）。
        if (isUniqueConstraintViolation(error)) {
          throw new ApiError({
            status: 'ALREADY_EXISTS',
            reason: 'FEEDBACK_ALREADY_RECORDED',
            domain: 'quality',
            message:
              'A feedback with this channel and external id has already been recorded.',
          });
        }
        throw error;
      }

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
        // R-002 的六个出处列与确认记录指针。这一段只出规则版：开关与模型的结果在
        // 事务提交之后才知道。`degradeReason` 先留空 —— 没跑过模型就不声称任何
        // 「已回落」的原因；提交之后的那一笔按真实结果补（开关关着才写 model-disabled）。
        engine: 'rules',
        promptVersion: null,
        degraded: false,
        degradeReason: null,
        knowledgeRefs: [],
        redacted: false,
        reviewId: null,
        outcome: screeningOutcome(result.confidence),
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
    router.use('/quality/drafting/stats', auth.required(), authz.middleware());

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
        const ingested = result.data.screening as unknown as Record<
          string,
          unknown
        >;
        let screening = ingested;
        if (result.replayed) {
          // 重放回与库里一致的值，但必须经请求自己的读范围：拿不带策略的仓储按第一次
          // 落库的 id 读，范围窄的人重放别人的单号就能拿到那一行草稿。读不到（没有读
          // 资格、或这一行不在范围内）与「重复投递」同形：409 `OPERATION_CONFLICT`，
          // 响应只有 `error`，不带任何记录字段（与 R-026 唯一冲突的口径一致）。
          const policy = await readerScreeningPolicy(context);
          const current = policy
            ? await database
                .connection()
                .repository('fqcScreenings')
                .withPolicy(policy)
                .findOne({ filter: { id: String(ingested.id) } })
            : undefined;
          if (!current) {
            throw new ApiError({
              status: 'ALREADY_EXISTS',
              reason: 'OPERATION_CONFLICT',
              domain: 'app',
              message:
                'The replayed intake is not readable in this caller\'s range.',
            });
          }
          // 初次 201 已经给过这次的调用方那一行（含读者范围读不到、但建行时写进去的列）；
          // 范围确认之后用它补齐，重放与第一次 201 才是同一组字段（只补第一次 201 返回过的列，不含 `ownerId`）。
          screening = { ...ingested, ...current };
        } else {
          // 模型升级在事务提交之后、响应回去之前。这一步的任何失败都不回滚投递、
          // 也不把 201 变成 500：反馈已经落库了。
          const session = context.get('auth');
          const reader =
            session?.user?.id === undefined
              ? undefined
              : { userId: String(session.user.id) };
          try {
            const cases = await readerCaseSources(
              context,
              database.connection(),
            );
            const upgrade = await upgradeScreeningDraft({
              connection: database.connection(),
              policy: policyOf(decision, 'fqcScreenings'),
              screeningId: String(ingested.id),
              text: body.content,
              ...(reader === undefined ? {} : { reader }),
              ...(cases === undefined ? {} : { cases }),
              drafting,
            });
            if (upgrade.written) {
              screening = { ...ingested, ...upgrade.values };
            } else {
              // 0 行不算成功：确认抢先，或这一行已不在投递的范围里。
              logger?.info(
                { screeningId: ingested.id, source: 'fqc.draft' },
                'The model upgrade matched no row; nothing was written.',
              );
            }
          } catch (error) {
            logger?.warn(
              { error },
              'The post-commit model upgrade failed; the intake stands.',
            );
          }
        }
        return context.json(
          { data: { ...result.data, screening } },
          201,
        );
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

    // 人工确认（R-002 起语义改了）：不再原地改写草稿。读初筛、写一行确认记录、把
    // outcome 记成 reviewed 并把 reviewId 指过去，三件事在同一个事务里。
    // 确认可以不止一次，每一次都留一行；响应里的 review 是刚读回来的那一行（读权不是
    // 可选的：少了它，这个端点会在写完之前被仓库层拒绝）。
    router.post(
      '/quality/screenings/:screeningId/review',
      describeRoute({
        tags: ['Quality'],
        summary: 'Confirm an AI screening and record the human decision',
        operationId: 'reviewQualityScreening',
        responses: {
          '200': dataResponse(ScreeningReviewResultSchema),
          '400': apiErrorResponse(400),
          '401': apiErrorResponse(401),
          '403': apiErrorResponse(403),
          '404': apiErrorResponse(404),
          '409': apiErrorResponse(409),
          '500': apiErrorResponse(500),
        },
      }),
      apiValidator('json', ApproveScreeningBody),
      async (context) => {
        const screeningId = context.req.param('screeningId');
        const body = context.req.valid('json');
        const decision = await authorizeFqc(context, 'handle');
        const session = context.get('auth');
        if (!session?.user?.id) {
          throw new ApiError({
            status: 'PERMISSION_DENIED',
            reason: 'PRINCIPAL_REQUIRED',
            domain: 'quality',
            message: 'An authenticated principal is required.',
          });
        }
        const actorId = String(session.user.id);
        const result = await database
          .connection()
          .transaction(async (transaction) => {
            const screenings = transaction
              .repository('fqcScreenings')
              .withPolicy(policyOf(decision, 'fqcScreenings'));
            const reviews = transaction
              .repository('fqcScreeningReviews')
              .withPolicy(policyOf(decision, 'fqcScreeningReviews'));
            const existing = await screenings.findOne({
              filter: { id: screeningId },
            });
            if (!existing) {
              // 不存在与不在调用者的范围里同形：不给范围外的行留探测口。
              throw new ApiError({
                status: 'NOT_FOUND',
                reason: 'SCREENING_NOT_FOUND',
                domain: 'quality',
                message: `Screening ${screeningId} was not found.`,
              });
            }
            // 请求体缺省时用草稿里的值：人没有改，就是确认 AI 的判断。
            const category = body.category ?? existing.category;
            const severity = body.severity ?? existing.severity;
            if (!category || !severity) {
              throw new ApiError({
                status: 'INVALID_ARGUMENT',
                reason: 'SCREENING_DRAFT_INCOMPLETE',
                domain: 'quality',
                message:
                  'The screening has no category or severity; pass them in the request body.',
              });
            }
            const reviewId = randomUUID();
            const reviewValues = {
              id: reviewId,
              screeningId,
              kind: 'confirm',
              category,
              severity,
              departmentId: body.departmentId ?? null,
              actorId,
              createdAt: new Date(),
            };
            await reviews.createMany({ values: [reviewValues] });
            // 版本前提：只在这一行还是我们读到的那个 reviewId 时更新。两个人同时确认
            // 同一份初筛时，后到的那一个在这里匹配不到行（Postgres 的 UPDATE 在行锁
            // 之后重算谓词），整笔事务回滚，它的确认记录也不落库，得到 409。
            // 顺序确认（同一人再确认一次）读到的已经是新 reviewId，照常成功。
            const observedReviewId =
              typeof existing.reviewId === 'string' &&
              existing.reviewId.length > 0
                ? existing.reviewId
                : null;
            const updatedRows = await screenings.updateMany({
              filter: (filter) =>
                filter.and([
                  filter.string('id').eq(screeningId),
                  observedReviewId === null
                    ? filter.string('reviewId').empty()
                    : filter.string('reviewId').eq(observedReviewId),
                ]),
              values: {
                outcome: 'reviewed',
                reviewId,
                updatedAt: new Date(),
              },
            });
            if (updatedRows.updatedCount !== 1) {
              throw new ApiError({
                status: 'ABORTED',
                reason: 'SCREENING_REVIEW_CONFLICT',
                domain: 'quality',
                message:
                  'This screening was confirmed by someone else while this request was running. Reload it and confirm again.',
              });
            }
            const updated = await screenings.findOne({
              filter: { id: screeningId },
            });
            const review = await reviews.findOne({ filter: { id: reviewId } });
            if (!updated || !review) {
              throw new ApiError({
                status: 'INTERNAL',
                reason: 'REVIEW_NOT_WRITTEN',
                domain: 'quality',
                message: 'The confirmation record could not be read back.',
              });
            }
            return { screening: updated, review };
          });
        return context.json({
          data: { ...result.screening, review: result.review },
        });
      },
    );

    /**
     * 代填效果（R-002）：草稿与人工确认的对照。
     *
     * 范围由调用方带策略的仓储带进服务：服务自己不知道「调用方是谁」，也只会经这两个
     * 仓储查；范围之外的行不计入。日期两端都从 query 来，缺一端、起点晚于终点、
     * 跨度超过一年都是 400。返回只有汇总的数字。
     */
    router.get(
      '/quality/drafting/stats',
      describeRoute({
        tags: ['Quality'],
        summary: 'Compare drafting engines with the human confirmations',
        operationId: 'getQualityDraftingStats',
        responses: {
          '200': dataResponse(DraftingStatsSchema),
          '400': apiErrorResponse(400),
          '401': apiErrorResponse(401),
          '403': apiErrorResponse(403),
          '500': apiErrorResponse(500),
        },
      }),
      apiValidator('query', DraftingStatsQuery),
      async (context) => {
        const { from, to } = context.req.valid('query');
        // 先授权再校验区间：没有查看资格的人一律 403，不因参数不全先得到 400。
        const decision = await authorizeFqc(context, 'view');
        if (from === undefined || to === undefined) {
          throw new ApiError({
            status: 'INVALID_ARGUMENT',
            reason: 'INVALID_DATE_RANGE',
            domain: 'quality',
            message: 'Both `from` and `to` are required.',
          });
        }
        const fromDate = new Date(from);
        const toDate = new Date(to);
        if (fromDate.getTime() > toDate.getTime()) {
          throw new ApiError({
            status: 'INVALID_ARGUMENT',
            reason: 'INVALID_DATE_RANGE',
            domain: 'quality',
            message: '`from` must not be later than `to`.',
          });
        }
        // 「一年」按 365 天算：区间是闭区间，端点相差超过 365 天就拒绝。
        if (toDate.getTime() - fromDate.getTime() > 365 * 24 * 60 * 60 * 1000) {
          throw new ApiError({
            status: 'INVALID_ARGUMENT',
            reason: 'INVALID_DATE_RANGE',
            domain: 'quality',
            message: 'The range must not span more than one year.',
          });
        }
        const reviewPolicy = policyOf(decision, 'fqcScreeningReviews');
        const stats = await computeDraftingStats(
          database
            .repository('fqcScreenings')
            .withPolicy(policyOf(decision, 'fqcScreenings')),
          // 确认记录表的读被范围折成 false：当成没有确认记录，不把整张统计卡变成 403。
          reviewPolicy.read === false
            ? null
            : database
                .repository('fqcScreeningReviews')
                .withPolicy(reviewPolicy),
          { from: fromDate, to: toDate },
        );
        return context.json({ data: { from, to, ...stats } });
      },
    );

    return new Hono().route('/', router);
  },
);
