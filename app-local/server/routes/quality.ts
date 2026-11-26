import {
  authenticationToken,
  type AuthEnv,
} from '@nocobase/app-plugin-authentication';
import {
  authorizationToken,
  type AuthorizationEnv,
} from '@nocobase/app-plugin-authorization/server';
import { serverFileRepositoryManagerToken } from '@nocobase/app-plugin-file/server';
import type { Application } from '@nocobase/app-server/application';
import { driveManagerToken } from '@nocobase/app-server/drive';
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
  type FilterBuilder,
  type RepositoryPolicy,
} from '@nocobase/db';
import {
  ApiError,
  apiErrorHandler,
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
import {
  LifecycleError,
  lifecycleErrorFields,
  type JsonObject,
} from '@nocobase/lifecycle';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { bodyLimit } from 'hono/body-limit';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';

import {
  ApproveScreeningBody,
  CreateFeedbackBody,
  DispatchScreeningBody,
  DispatchedTicketSchema,
  DiscardFeedbackBody,
  DraftingStatsQuery,
  DraftingStatsSchema,
  FeedbackFileSchema,
  FireTransitionBody,
  FeedbackSchema,
  IngestMessageBody,
  IngestResultSchema,
  ListFeedbackQuery,
  ListTicketsQuery,
  MessageSchema,
  MineFeedbackQuery,
  ScreeningListItemSchema,
  ScreeningReviewResultSchema,
  SetAssigneeBody,
  TicketCandidateSchema,
  TicketCandidatesQuery,
  TicketSchema,
  UpdateFeedbackBody,
  type CreateFeedbackInput,
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
import {
  qualityScreeningToken,
  screenByRules,
  type ScreeningResult,
} from '../providers/quality-screening.js';
import {
  departmentServiceToken,
  peopleQueryServiceToken,
} from '../providers/departments.js';
import {
  inTicketScope,
  ticketScopeOfDecision,
} from '../ticket-scope.js';
import { lifecycleRuntimeToken } from '../providers/lifecycles.js';

type FqcAction =
  | 'view'
  | 'handle'
  | 'intake'
  | 'submit'
  | 'maintain'
  | 'ticket';
type FqcTable =
  | 'fqcMessages'
  | 'fqcScreenings'
  | 'fqcTickets'
  | 'fqcScreeningReviews'
  | 'fqcRoutingRules';

/** 422 没有共享错误响应组件（框架状态表不含 422），照 departments.ts 就地声明。 */
const unprocessableResponse = {
  description: 'The request violates a quality rule (422).',
  content: {
    'application/json': {
      schema: { $ref: '#/components/schemas/ApiErrorBody' },
    },
  },
} as const;
type FqcDecision = AuthorizationDecision<CompositeResourceConditions>;

/** 列表随行带出去的确认记录，只比库里那一行多一个姓名（不回邮箱、手机号）。 */
interface ScreeningReviewForList {
  readonly id: string;
  readonly screeningId: string;
  readonly kind: string;
  readonly category: string;
  readonly severity: string;
  readonly departmentId: string | null;
  readonly actorId: string;
  readonly createdAt: unknown;
}

/** 账号已删、解析不到姓名时的中性占位；不是账号 id，也不泄露账号是否存在。 */
const UNKNOWN_ACTOR_NAME = '—';

/**
 * R-026 S4：附件的上传与取内容。
 *
 * 只调插件的服务端文件仓储，不登记它的 HTTP 路由：公开的内容路由根本不存在。
 * 盘用应用配好的私有 `local`，对象前缀 `fqc-feedback`；单个文件上限比盘级上限小。
 * 类型收在声明的 MIME 与扩展名对得上的四种，插件不做内容嗅探，所以这里也不声称做过。
 */
const FEEDBACK_FILE_MAX_BYTES = 10 * 1024 * 1024;
// multipart 的边界与头部开销；按请求长度先挡住明显过大的体，精确大小在解析后按文件判。
const FEEDBACK_FILE_BODY_SLACK = 64 * 1024;
const FEEDBACK_FILE_DISK = 'local';
const FEEDBACK_FILE_STORAGE_PREFIX = 'fqc-feedback';
// 只用于构造仓储（getUrl 的地址形态），本应用从不登记这条路由。
const FEEDBACK_FILE_ACCESS_PATH = '/quality/feedback-files-private';
const FEEDBACK_FILE_TYPES: Readonly<Record<string, readonly string[]>> = {
  'image/jpeg': ['jpg', 'jpeg'],
  'image/png': ['png'],
  'image/webp': ['webp'],
  'application/pdf': ['pdf'],
};

/** 与插件内容路由同一套类型归一：非法类型落回 application/octet-stream。 */
function feedbackMime(value: string): string {
  return /^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/u.test(value)
    ? value.toLowerCase()
    : 'application/octet-stream';
}

/** 上传仓储的策略：ownerId 由服务端写进默认列，调用方碰不到任何字段。 */
function feedbackFileUploadPolicy(ownerId: string): RepositoryPolicy {
  return {
    read: { scope: true },
    create: { scope: true, defaults: { ownerId } },
    update: false,
    delete: false,
  };
}

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

/** 反馈单的两个入口共用的字段；`ownerId` 永远由调用方按会话写进来。 */
export interface FeedbackIngestInput {
  readonly channel: string;
  readonly externalId?: string | null;
  readonly senderName?: string | null;
  readonly senderContact?: string | null;
  readonly content: string;
  readonly contentType: string;
  readonly receivedAt?: string;
  readonly customerName?: string | null;
  readonly productName?: string | null;
  readonly model?: string | null;
  readonly batchNo?: string | null;
  readonly attachmentIds?: readonly string[] | null;
  readonly ownerId: string | null;
}

/** 迁移 `202611260002` 加的唯一约束名；只有撞上它才换成领域原因码。 */
const UNIQUE_CHANNEL_EXTERNAL = 'uq_fqc_messages_channel_external';

/**
 * 外部标识的空串在进库前归一成 NULL。schema 已经直接拒空串，这里再守一道：
 * 唯一约束对 NULL 不生效，「空的两条可并存」指的是 NULL 而不是空串。
 */
export function feedbackExternalId(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** 仓储记录里的未知值转文本；不靠 String(object) 的默认字符串化。 */
function asText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

/**
 * 把 `(channel, externalId)` 这一个唯一约束的冲突换成领域 409。
 *
 * 别的主键或唯一索引撞了仍然是未识别的数据库错误（500），绝不戴上
 * `FEEDBACK_ALREADY_RECORDED` 这个原因码。Postgres 的错误带 `constraint`，
 * SQLite 只在消息里写列名，两种都认。
 */
export function feedbackUniqueError(error: unknown): ApiError | undefined {
  if (!isUniqueConstraintViolation(error)) {
    return undefined;
  }
  let current = error as {
    constraint?: unknown;
    constraintName?: unknown;
    message?: unknown;
    cause?: unknown;
    originalError?: unknown;
  } | null;
  const visited = new Set<unknown>();
  while (current !== null && typeof current === 'object' && !visited.has(current)) {
    visited.add(current);
    const name = current.constraint ?? current.constraintName;
    const message = typeof current.message === 'string' ? current.message : '';
    const matches =
      name === UNIQUE_CHANNEL_EXTERNAL ||
      (/UNIQUE/i.test(message) &&
        /(?:fqcMessages|fqc_messages)\.channel/i.test(message) &&
        /(?:fqcMessages|fqc_messages)\.(?:externalId|external_id)/i.test(message));
    if (matches) {
      return new ApiError({
        status: 'ALREADY_EXISTS',
        reason: 'FEEDBACK_ALREADY_RECORDED',
        domain: 'quality',
        message:
          'A feedback with this channel and external id has already been recorded.',
      });
    }
    current = current.cause ?? current.originalError ?? null;
  }
  return undefined;
}

/**
 * 两个入口共用的录入函数：核附件、挂标识、写原文、写草稿，四件事同成同败。
 *
 * 事务由调用方开；投递在这个事务里还多写一张工单，网页入口不写。附件表没有
 * 登记进授权，但读写都发生在已按业务动作授权过的端点里、并在这个事务内，
 * 所以这里直接取仓储，没有带策略的版本。
 */
export async function ingestFeedback(
  input: FeedbackIngestInput,
  transaction: DatabaseConnection,
  policies: {
    readonly messages: RepositoryPolicy;
    readonly screenings: RepositoryPolicy;
  },
  attachmentOwnerId: string | null,
  screen: (text: string) => ScreeningResult = screenByRules,
): Promise<{
  message: Record<string, unknown>;
  screening: Record<string, unknown>;
}> {
  const now = new Date();
  const storedNow = storedDateTime(now);
  const receivedAt = input.receivedAt ? new Date(input.receivedAt) : now;
  const result = screen(input.content);
  const attachmentIds = [...(input.attachmentIds ?? [])];
  const files = transaction.repository('fqcFeedbackFiles');

  // ① 每个标识都得是调用者自己上传的、而且还没挂在别的单上。
  for (const id of attachmentIds) {
    const file = await files.findOne({
      filter: (filter) =>
        filter.and([
          filter.string('id').eq(id),
          attachmentOwnerId === null
            ? filter.string('ownerId').empty()
            : filter.string('ownerId').eq(attachmentOwnerId),
          filter.string('feedbackId').empty(),
        ]),
    });
    if (!file) {
      throw new ApiError({
        status: 'FAILED_PRECONDITION',
        httpStatus: 422,
        reason: 'ATTACHMENT_NOT_AVAILABLE',
        domain: 'quality',
        message: `Attachment ${id} is not available to this caller.`,
      });
    }
  }

  const message: Record<string, unknown> = {
    id: randomUUID(),
    channel: input.channel,
    externalId: feedbackExternalId(input.externalId),
    senderName: input.senderName ?? null,
    senderContact: input.senderContact ?? null,
    content: input.content,
    rawContentType: input.contentType,
    receivedAt: storedDateTime(receivedAt),
    status: 'open',
    customerName: input.customerName ?? null,
    productName: input.productName ?? null,
    model: input.model ?? null,
    batchNo: input.batchNo ?? null,
    attachmentIds,
    ...(input.ownerId === null ? {} : { ownerId: input.ownerId }),
    createdAt: storedNow,
    updatedAt: storedNow,
  };

  // ② 先挂上标识：带谓词的更新，只认「还没被占用」的行。前面的核验与这里的更新
  // 不在同一个锁里：真 Postgres 上两个事务同时绑同一个附件时，后到的更新会在
  // 行锁释放后重算谓词，匹配 0 行。不检查行数就会让同一个附件挂到两张单上。
  if (attachmentIds.length > 0) {
    const bound = await files.updateMany({
      filter: (filter) =>
        filter.and([
          filter.or(attachmentIds.map((id) => filter.string('id').eq(id))),
          filter.string('feedbackId').empty(),
        ]),
      values: { feedbackId: message.id, updatedAt: storedNow } as never,
    });
    if (bound.updatedCount !== attachmentIds.length) {
      throw new ApiError({
        status: 'FAILED_PRECONDITION',
        httpStatus: 422,
        reason: 'ATTACHMENT_NOT_AVAILABLE',
        domain: 'quality',
        message: 'An attachment was claimed by another feedback while this one was being submitted.',
      });
    }
  }

  // ③ 写原文。不先查再写：撞唯一约束时整笔事务回滚，附件绑定也随之撤销。
  try {
    await transaction
      .repository('fqcMessages')
      .withPolicy(policies.messages)
      .createMany({ values: [message] as never });
  } catch (error) {
    const mapped = feedbackUniqueError(error);
    if (mapped) {
      throw mapped;
    }
    throw error;
  }

  // ④ 写规则版草稿。`reviewId`、`promptVersion` 留空，`engine`、`degraded`、
  // `redacted` 靠列上的默认值；只有这十五列在「提交反馈」的建列清单里。
  const screening: Record<string, unknown> = {
    id: randomUUID(),
    messageId: message.id,
    category: result.category,
    severity: result.severity,
    suggestedOwner: result.suggestedOwner,
    summary: result.summary,
    confidence: confidenceText(result.confidence, transaction.dialect),
    evidence: result.evidence,
    modelName: 'rule-baseline',
    outcome: screeningOutcome(result.confidence),
    // R-002 的裁决：事务里只出规则版，这时还没跑过模型，不声称任何回落原因。
    // 真正的原因由提交后的升级按结果写；确认抢先或升级失败就留 null。
    degradeReason: null,
    knowledgeRefs: [],
    ...(input.ownerId === null ? {} : { ownerId: input.ownerId }),
    createdAt: storedNow,
    updatedAt: storedNow,
  };
  await transaction
    .repository('fqcScreenings')
    .withPolicy(policies.screenings)
    .createMany({ values: [screening] as never });

  return { message, screening };
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
     * 投递只写消息与初筛两张表（R-003：工单在人工确认草稿之后才建）。
     *
     * 「投递」不带读，所以用 `createMany` 写、不要求回读：`createOne` 会把刚落库的
     * 记录读回来当返回值，而读在投递的授权里是 false（READ_FORBIDDEN）。响应由这次
     * 写入的值组成，写入的内容与以前一致；时间与置信度按列的读回形态给，201 与随后
     * 从列表端点读到的同一条逐字段相等。**响应里没有 `ticket`。**
     */
    async function ingestOnce(
      input: IngestMessageInput,
      transaction: DatabaseConnection,
      policies: {
        readonly messages: RepositoryPolicy;
        readonly screenings: RepositoryPolicy;
      },
      attachmentOwnerId: string | null,
    ) {
      // 四件事都在调用方给的这一个事务里；任何一件失败都整笔回滚。
      const { message, screening: record } = await ingestFeedback(
        {
          channel: input.channel,
          externalId: input.externalId,
          senderName: input.senderName,
          senderContact: input.senderContact,
          content: input.content,
          contentType: input.contentType,
          ...(input.receivedAt === undefined ? {} : { receivedAt: input.receivedAt }),
          customerName: input.customerName ?? null,
          productName: input.productName ?? null,
          model: input.model ?? null,
          batchNo: input.batchNo ?? null,
          attachmentIds: input.attachmentIds ?? [],
          ownerId: null,
        },
        transaction,
        { messages: policies.messages, screenings: policies.screenings },
        attachmentOwnerId,
        (text) => screening.screen(text),
      );
      // 录入只写十五列；投递的 201 按列的默认值（或空）把其余列拼回来，
      // 与随后按「查看」读到的同一条逐字段相等。写库的值不变。
      const screeningResponse: Record<string, unknown> = {
        engine: 'rules',
        promptVersion: null,
        degraded: false,
        redacted: false,
        reviewId: null,
        // 建行留 null，这里按列形态把「没写」补成 null，与随后读到的一致。
        degradeReason: record.degradeReason ?? null,
        ...record,
      };
      return { message, screening: screeningResponse };
    }

    /**
     * 事务提交之后、响应回去之前的模型升级位置。范围由调用方传进来：投递给投递
     * 决策里的，网页表单给「提交反馈」决策里的；这里绝不写死成「投递」。
     */
    async function runPostCommitUpgrade(
      context: Context<AuthEnv & AuthorizationEnv>,
      options: {
      readonly screeningId: string;
      readonly text: string;
      readonly policy: RepositoryPolicy;
    }): Promise<Record<string, unknown> | null> {
      const session = context.get('auth');
      const reader =
        session?.user?.id === undefined
          ? undefined
          : { userId: String(session.user.id) };
      try {
        const cases = await readerCaseSources(context, database.connection());
        const upgrade = await upgradeScreeningDraft({
          connection: database.connection(),
          policy: options.policy,
          screeningId: options.screeningId,
          text: options.text,
          ...(reader === undefined ? {} : { reader }),
          ...(cases === undefined ? {} : { cases }),
          drafting,
        });
        return upgrade.written ? (upgrade.values ?? null) : null;
      } catch (error) {
        // 反馈已经落库了：升级失败既不回滚，也不把 201 变成 500。
        logger?.warn(
          { error },
          'The post-commit model upgrade failed; the feedback stands.',
        );
        return null;
      }
    }

    const people = app.container.resolve(peopleQueryServiceToken);
    const departments = app.container.resolve(departmentServiceToken);
    const lifecycle = app.container.resolve(lifecycleRuntimeToken);

    /** lifecycle 的拒绝映射成设计的 HTTP 码；服务端自己的故障仍原样抛出成 500。 */
    function toLifecycleApiError(error: unknown): unknown {
      if (!(error instanceof LifecycleError)) return error;
      const blocker = error.blockers?.[0];
      if (
        blocker?.code === 'ASSIGNED_TO_OTHER' ||
        blocker?.code === 'DEPARTMENT_DISABLED' ||
        error.code === 'INVALID_STATE'
      ) {
        return new ApiError({
          status: 'ABORTED',
          reason:
            error.code === 'INVALID_STATE'
              ? 'INVALID_TRANSITION'
              : (blocker?.code ?? 'INVALID_TRANSITION'),
          domain: 'quality',
          message: error.message,
        });
      }
      if (blocker?.code === 'DEPARTMENT_OUT_OF_SCOPE') {
        return new ApiError({
          status: 'PERMISSION_DENIED',
          reason: 'DEPARTMENT_OUT_OF_SCOPE',
          domain: 'quality',
          message: error.message,
        });
      }
      if (blocker?.code === 'ASSIGNEE_NOT_DEPARTMENT_MEMBER') {
        return new ApiError({
          status: 'FAILED_PRECONDITION',
          httpStatus: 422,
          reason: 'ASSIGNEE_NOT_DEPARTMENT_MEMBER',
          domain: 'quality',
          message: error.message,
        });
      }
      const fields = lifecycleErrorFields(error, { inputField: 'input' });
      return fields ? new ApiError({ ...fields, domain: 'quality' }) : error;
    }

    // ---- R-026 S4：附件上传与取内容 ----

    const attachmentNotFound = (id: string) =>
      new ApiError({
        status: 'NOT_FOUND',
        reason: 'ATTACHMENT_NOT_FOUND',
        domain: 'quality',
        message: `Attachment ${id} was not found.`,
      });

    const fileError = (
      status: 'INVALID_ARGUMENT' | 'PERMISSION_DENIED',
      reason: string,
      httpStatus: 400 | 413 | 415 | undefined,
      message: string,
    ) =>
      new ApiError({
        status,
        reason,
        domain: 'quality',
        message,
        ...(httpStatus === undefined ? {} : { httpStatus }),
      });

    /** 上传端点在授权中间件里记下调用者，解析期的 bodyLimit 之前不再重复授权。 */
    const uploadOwner = new WeakMap<Context<AuthEnv & AuthorizationEnv>, string>();

    /**
     * 服务端文件仓储：只有上传路径绑策略（插件自己从 `create.defaults` 写 ownerId），
     * 不建表、不登记路由。普通读写仍走应用自己的仓储，与录入函数同一张表。
     */
    const feedbackFileRepository = (ownerId: string) =>
      app.container
        .resolve(serverFileRepositoryManagerToken)
        .repository('fqcFeedbackFiles', {
          connection: 'main',
          disk: FEEDBACK_FILE_DISK,
          storagePrefix: FEEDBACK_FILE_STORAGE_PREFIX,
          accessPath: FEEDBACK_FILE_ACCESS_PATH,
          policy: feedbackFileUploadPolicy(ownerId),
        });

    /**
     * 照插件内容路由的做法自己拼响应头：类型与扩展名取记录里的值，文件名先 NFC 化、去控制字符
     * 与路径分隔符（存储层已做一次），再用 RFC 5987 编码；盘上对象不存在与记录不存在同形。
     */
    async function sendFeedbackFile(
      context: Context<AuthEnv & AuthorizationEnv>,
      record: Record<string, unknown>,
    ) {
      const key = String(record.key);
      const disk = app.container.resolve(driveManagerToken).use(String(record.disk));
      if (!(await disk.exists(key))) {
        throw attachmentNotFound(String(record.id));
      }
      const filename = Buffer.from(String(record.filename)).toString('utf8');
      const encoded = encodeURIComponent(filename).replace(/['()*]/gu, (char) =>
        `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
      );
      context.header('Cache-Control', 'private, no-store');
      context.header('Content-Type', feedbackMime(String(record.mimeType)));
      context.header('Content-Length', String(Number(record.size)));
      context.header('X-Content-Type-Options', 'nosniff');
      context.header('Content-Security-Policy', "sandbox; default-src 'none'");
      context.header('Content-Disposition', `attachment; filename*=UTF-8''${encoded}`);
      return context.body(Readable.toWeb(await disk.getStream(key)));
    }

    /** 一批单的附件，按 feedbackId 归堆；取内容端点由下一片提供，这里只拼地址。 */
    async function attachmentsOf(ids: readonly string[]) {
      const grouped = new Map<string, Record<string, unknown>[]>();
      if (ids.length === 0) {
        return grouped;
      }
      const rows = (await database
        .connection()
        .repository('fqcFeedbackFiles')
        .findMany({
          filter: (filter) =>
            filter.or(ids.map((id) => filter.string('feedbackId').eq(id))),
        })) as unknown as Record<string, unknown>[];
      for (const file of rows) {
        const key = asText(file.feedbackId);
        const list = grouped.get(key) ?? [];
        list.push(file);
        grouped.set(key, list);
      }
      return grouped;
    }

    async function namesOf(ids: readonly string[]) {
      const unique = [...new Set(ids.filter((id) => id.length > 0))];
      const rows = unique.length > 0 ? await people.byIds(unique) : [];
      return new Map(rows.map((row) => [row.id, row.name]));
    }

    /**
     * 列表随行带的最近一次确认：用查看决策里这张表自己的范围读，按
     * `createdAt DESC, id DESC` 排序，每个初筛只留第一条。读被折成 false 时整段为空，
     * 不报错，也不许绕开范围按 id 另查。
     */
    async function latestReviewsOf(
      decision: FqcDecision,
      screeningIds: readonly string[],
    ): Promise<Map<string, ScreeningReviewForList>> {
      const policy = policyOf(decision, 'fqcScreeningReviews');
      if (screeningIds.length === 0 || policy.read === false) {
        return new Map();
      }
      const rows = (await database
        .connection()
        .repository('fqcScreeningReviews')
        .withPolicy(policy)
        .findMany({
          filter: (filter) =>
            filter.or(
              screeningIds.map((id) => filter.string('screeningId').eq(id)),
            ),
          sort: {
            kind: 'sort',
            version: 1,
            items: [
              { kind: 'field', path: ['createdAt'], direction: 'desc' },
              { kind: 'field', path: ['id'], direction: 'desc' },
            ],
          },
        })) as unknown as Record<string, unknown>[];
      const latest = new Map<string, ScreeningReviewForList>();
      for (const row of rows) {
        const screeningId = asText(row.screeningId);
        if (latest.has(screeningId)) {
          continue;
        }
        latest.set(screeningId, {
          id: String(row.id),
          screeningId,
          kind: String(row.kind),
          category: String(row.category),
          severity: String(row.severity),
          departmentId:
            row.departmentId === null || row.departmentId === undefined
              ? null
              : asText(row.departmentId),
          actorId: String(row.actorId),
          createdAt: row.createdAt,
        });
      }
      return latest;
    }

    /** 初筛八列与工单五列按 messageId / sourceMessageId 归堆，只给维护端点用。 */
    async function relatedOf(
      decision: FqcDecision,
      ids: readonly string[],
    ): Promise<{
      screenings: Map<string, Record<string, unknown>>;
      tickets: Map<string, Record<string, unknown>>;
    }> {
      if (ids.length === 0) {
        return { screenings: new Map(), tickets: new Map() };
      }
      const screeningRows = (await database
        .connection()
        .repository('fqcScreenings')
        .withPolicy(policyOf(decision, 'fqcScreenings'))
        .findMany({
          filter: (filter) =>
            filter.or(ids.map((id) => filter.string('messageId').eq(id))),
        })) as unknown as Record<string, unknown>[];
      const ticketRows = (await database
        .connection()
        .repository('fqcTickets')
        .withPolicy(policyOf(decision, 'fqcTickets'))
        .findMany({
          filter: (filter) =>
            filter.or(ids.map((id) => filter.string('sourceMessageId').eq(id))),
        })) as unknown as Record<string, unknown>[];
      return {
        screenings: new Map(
          screeningRows.map((row) => [asText(row.messageId), row]),
        ),
        tickets: new Map(
          ticketRows.map((row) => [asText(row.sourceMessageId), row]),
        ),
      };
    }

    /** 端点拼出来的行：附件、提交人姓名、两个 can 与按动作裁剪的内部列。 */
    async function decorate(
      rows: readonly Record<string, unknown>[],
      maintain: boolean,
      decision: FqcDecision,
    ) {
      const files = await attachmentsOf(rows.map((row) => String(row.id)));
      const names = await namesOf(
        rows.map((row) => (row.ownerId === null ? '' : asText(row.ownerId))),
      );
      const related = maintain
        ? await relatedOf(decision, rows.map((row) => String(row.id)))
        : { screenings: new Map<string, Record<string, unknown>>(), tickets: new Map<string, Record<string, unknown>>() };
      return rows.map((row) => {
        const id = String(row.id);
        const status = String(row.status);
        const ticket = related.tickets.get(id) ?? null;
        const { note: _note, discardedBy: _discardedBy, ...base } = row;
        return {
          ...(maintain ? row : base),
          submitterName:
            row.ownerId === null || row.ownerId === undefined
              ? null
              : names.get(asText(row.ownerId)) ?? null,
          attachments: (files.get(id) ?? []).map((file) => ({
            id: String(file.id),
            filename: String(file.filename),
            mimeType: String(file.mimeType),
            size: Number(file.size),
            url: maintain
              ? `/api/quality/feedbacks/${id}/attachments/${String(file.id)}`
              : `/api/quality/feedbacks/mine/${id}/attachments/${String(file.id)}`,
          })),
          canEdit: status === 'open',
          canDiscard: status === 'open' && ticket === null,
          ...(maintain && related.screenings.has(id)
            ? { screening: related.screenings.get(id) }
            : {}),
          ...(maintain ? { ticket } : {}),
        };
      });
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
    router.use('/quality/ticket-candidates', auth.required(), authz.middleware());
    router.use('/quality/messages', auth.required(), authz.middleware());
    router.use('/quality/screenings', auth.required(), authz.middleware());
    router.use('/quality/screenings/*', auth.required(), authz.middleware());
    router.use('/quality/drafting/stats', auth.required(), authz.middleware());
    router.use('/quality/feedbacks', auth.required(), authz.middleware());
    router.use('/quality/feedbacks/*', auth.required(), authz.middleware());
    router.use('/quality/feedback-files', auth.required(), authz.middleware());
    router.use('/quality/feedback-files/*', auth.required(), authz.middleware());

    // 外部渠道回调：企业微信/微信网关把客户消息推到这里。
    // 授权一次「投递」；两张表的写入在同一个事务里完成，不建工单。
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
          execute: (transaction) => {
            const session = context.get('auth');
            return ingestOnce(
              body,
              transaction,
              {
                messages: policyOf(decision, 'fqcMessages'),
                screenings: policyOf(decision, 'fqcScreenings'),
              },
              session?.user?.id === undefined ? null : String(session.user.id),
            );
          },
        });
        context.header('Idempotency-Replayed', String(result.replayed));
        const ingested = result.data.screening;
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

    /**
     * R-003 流转：只经 lifecycle 改状态，路由不直接写 `state`。
     *
     * 先按「处理工单」授权、再用带范围的仓储按 id 取行：范围外的行与不存在同形
     * 404。之后交给唯一的运行时 fire，`manual: true` 让五个转移都能由人点；
     * 并发靠运行时的同版本条件更新裁决，另一个请求得到 409。
     */
    router.post(
      '/quality/tickets/:ticketId/transitions',
      describeRoute({
        tags: ['Quality'],
        summary: 'Fire a lifecycle transition on a quality ticket',
        operationId: 'transitionQualityTicket',
        responses: {
          '200': dataResponse(z.unknown()),
          '400': apiErrorResponse(400),
          '401': apiErrorResponse(401),
          '403': apiErrorResponse(403),
          '404': apiErrorResponse(404),
          '409': apiErrorResponse(409),
          '422': unprocessableResponse,
          '500': apiErrorResponse(500),
        },
      }),
      apiValidator('json', FireTransitionBody),
      async (context) => {
        const ticketId = context.req.param('ticketId');
        const body = context.req.valid('json');
        const decision = await authorizeFqc(context, 'ticket');
        const session = context.get('auth');
        if (!session?.user?.id) {
          throw new ApiError({
            status: 'PERMISSION_DENIED',
            reason: 'PRINCIPAL_REQUIRED',
            domain: 'quality',
            message: 'An authenticated principal is required.',
          });
        }
        const actor = { id: String(session.user.id) };
        const found = await database
          .connection()
          .repository('fqcTickets')
          .withPolicy(policyOf(decision, 'fqcTickets'))
          .findOne({ filter: { id: ticketId } });
        if (!found) {
          throw new ApiError({
            status: 'NOT_FOUND',
            reason: 'TICKET_NOT_FOUND',
            domain: 'quality',
            message: `Ticket ${ticketId} was not found.`,
          });
        }
        try {
          const result = await lifecycle.fire(
            'fqcTickets',
            ticketId,
            body.name,
            {
              actor,
              manual: true,
              input: (body.input ?? {}) as JsonObject,
            },
          );
          const view = await lifecycle.view('fqcTickets', ticketId, actor);
          return context.json({
            data: { ...view, replayed: result.replayed === true },
          });
        } catch (error) {
          throw toLifecycleApiError(error);
        }
      },
    );

    /** 只换经办人，不换部门；不是流转，所以状态与版本都不动。 */
    router.post(
      '/quality/tickets/:ticketId/assignee',
      describeRoute({
        tags: ['Quality'],
        summary: 'Change the assignee of a quality ticket',
        operationId: 'setQualityTicketAssignee',
        responses: {
          '200': dataResponse(z.unknown()),
          '400': apiErrorResponse(400),
          '401': apiErrorResponse(401),
          '403': apiErrorResponse(403),
          '404': apiErrorResponse(404),
          '409': apiErrorResponse(409),
          '422': unprocessableResponse,
          '500': apiErrorResponse(500),
        },
      }),
      apiValidator('json', SetAssigneeBody),
      async (context) => {
        const ticketId = context.req.param('ticketId');
        const assigneeId = context.req.valid('json').assigneeId;
        const decision = await authorizeFqc(context, 'ticket');
        const repo = database
          .connection()
          .repository('fqcTickets')
          .withPolicy(policyOf(decision, 'fqcTickets'));
        const ticket = await repo.findOne({ filter: { id: ticketId } });
        if (!ticket) {
          throw new ApiError({
            status: 'NOT_FOUND',
            reason: 'TICKET_NOT_FOUND',
            domain: 'quality',
            message: `Ticket ${ticketId} was not found.`,
          });
        }
        if (ticket.state === 'closed') {
          throw new ApiError({
            status: 'ABORTED',
            reason: 'TICKET_CLOSED',
            domain: 'quality',
            message: 'The ticket is closed; reopen it before changing the assignee.',
          });
        }
        if (assigneeId !== null) {
          const memberIds = await departments.memberIdsOf(
            asText(ticket.departmentId),
          );
          if (!memberIds.includes(assigneeId)) {
            throw new ApiError({
              status: 'FAILED_PRECONDITION',
              httpStatus: 422,
              reason: 'ASSIGNEE_NOT_DEPARTMENT_MEMBER',
              domain: 'quality',
              message: 'The assignee is not a member of the responsible department.',
            });
          }
        }
        const changed = await repo.updateMany({
          filter: { id: ticketId },
          values: { assigneeId },
        });
        if (changed.updatedCount !== 1) {
          throw new ApiError({
            status: 'ABORTED',
            reason: 'TICKET_ASSIGNEE_CONFLICT',
            domain: 'quality',
            message: 'The ticket changed while changing the assignee.',
          });
        }
        const updated = await repo.findOne({ filter: { id: ticketId } });
        return context.json({ data: updated });
      },
    );

    /**
     * R-003 搜同事：只回标识、姓名、用户名三列，只在目标部门的未停用成员里搜。
     *
     * 目标部门必须存在、未停用、且在调用者按「处理工单」在工单表上的范围里；三者
     * 同形回 404（与不存在、已停用的部门一样），故意不暴露部门是否存在。范围解析
     * 与转派共用 `ticket-scope.ts`，关键字只按姓名与用户名匹配（共用的搜人服务，
     * 不经过会连邮箱一起匹配的账号管理搜索）。
     */
    router.get(
      '/quality/ticket-candidates',
      describeRoute({
        tags: ['Quality'],
        summary: 'Search colleagues of a department for ticket assignment',
        operationId: 'searchTicketCandidates',
        responses: {
          '200': listResponse(TicketCandidateSchema),
          '400': apiErrorResponse(400),
          '401': apiErrorResponse(401),
          '403': apiErrorResponse(403),
          '404': apiErrorResponse(404),
          '500': apiErrorResponse(500),
        },
      }),
      apiValidator('query', TicketCandidatesQuery),
      async (context) => {
        const { departmentId, q, page, pageSize } =
          context.req.valid('query');
        const decision = await authorizeFqc(context, 'ticket');
        const scope = ticketScopeOfDecision(decision);
        const notFound = () =>
          new ApiError({
            status: 'NOT_FOUND',
            reason: 'DEPARTMENT_NOT_FOUND',
            domain: 'quality',
            message: `Department ${departmentId} is unavailable.`,
          });
        // 范围解析不出来（含 {scope:true}）时拒绝，绝不退化成「全部成员」。
        if (scope === null || !inTicketScope(scope, departmentId)) throw notFound();
        // 部门不存在或已停用时 subtreeIds 回空；与范围外同形。
        if ((await departments.subtreeIds(departmentId)).length === 0) throw notFound();

        const memberIds = await departments.memberIdsOf(departmentId);
        const result = await people.search({
          q,
          userIds: memberIds,
          page,
          pageSize,
        });
        // 共用服务只 select 三列，匹配只按姓名与用户名，不按邮箱；再显式裁一次，
        // 以后服务若扩列也不会从这里漏出去。
        return context.json({
          data: result.rows.map((row) => ({
            id: row.id,
            name: row.name,
            username: row.username,
          })),
          meta: { page, pageSize, total: result.total },
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
        // 已确认的行随行带最近一次确认记录：读这张表仍用同一个查看决策的范围，
        // 读不到就是 null，不报错。姓名只经 PeopleQueryService 解析成姓名一列，
        // `actorId` 留着给排障，但页面上不再把它显示给用户。
        const confirmed = rows.filter((row) => asText(row.reviewId).length > 0);
        const reviews = await latestReviewsOf(
          decision,
          confirmed.map((row) => asText(row.id)),
        );
        const names = await namesOf(
          [...reviews.values()].map((review) => review.actorId),
        );
        // 每行带一个「这一行处于可以确认的状态」。只看这一行的状态：是「待人工复核」
        // 就为真。调用的人有没有处理权限不在这里判 —— 那要在同一个请求里再授权一次。
        // 前端把 canReview 与 useCan 合起来决定按钮显不显示。
        return context.json({
          data: rows.map((row) => {
            const review = asText(row.reviewId).length > 0
              ? reviews.get(asText(row.id))
              : undefined;
            return {
              ...row,
              canReview: row.outcome === 'needs-review',
              review: review
                ? {
                    ...review,
                    actorName:
                      names.get(review.actorId) ?? UNKNOWN_ACTOR_NAME,
                  }
                : null,
            };
          }),
          meta: { page: 1, pageSize: 50, total },
        });
      },
    );

    /**
     * R-003 派单：把一份草稿变成一张 open 工单。
     *
     * 四个生效值按字段回退（各自取第一个有的）：类别与严重度取请求 → 最近一次确认
     * 记录 → 草稿；责任部门取请求 → 确认记录 → 这一类的派单规则（草稿的
     * `suggestedOwner` 是规则版路由键，不是部门，绝不参与）；经办人只取请求。
     * 写 dispatch 确认记录、把初筛的 reviewId 指过去、outcome 记成 reviewed、建工单，
     * 四件事同一个事务。`screeningId` 的唯一约束是「一份草稿一张单」的最后仲裁，
     * 先查到的重复只给一个清楚的 409。
     */
    router.post(
      '/quality/screenings/:screeningId/dispatch',
      describeRoute({
        tags: ['Quality'],
        summary: 'Confirm a screening and dispatch an internal ticket',
        operationId: 'dispatchQualityScreening',
        responses: {
          '201': dataResponse(DispatchedTicketSchema),
          '400': apiErrorResponse(400),
          '401': apiErrorResponse(401),
          '403': apiErrorResponse(403),
          '404': apiErrorResponse(404),
          '409': apiErrorResponse(409),
          '422': unprocessableResponse,
          '500': apiErrorResponse(500),
        },
      }),
      apiValidator('json', DispatchScreeningBody),
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

        const screeningNotFound = () =>
          new ApiError({
            status: 'NOT_FOUND',
            reason: 'SCREENING_NOT_FOUND',
            domain: 'quality',
            message: `Screening ${screeningId} was not found.`,
          });
        const alreadyDispatched = () =>
          new ApiError({
            status: 'ABORTED',
            reason: 'SCREENING_ALREADY_DISPATCHED',
            domain: 'quality',
            message: 'A ticket already exists for this screening.',
          });

        const ticket = await database.connection().transaction(async (transaction) => {
          const screenings = transaction
            .repository('fqcScreenings')
            .withPolicy(policyOf(decision, 'fqcScreenings'));
          const reviews = transaction
            .repository('fqcScreeningReviews')
            .withPolicy(policyOf(decision, 'fqcScreeningReviews'));
          const tickets = transaction
            .repository('fqcTickets')
            .withPolicy(policyOf(decision, 'fqcTickets'));
          const routing = transaction
            .repository('fqcRoutingRules')
            .withPolicy(policyOf(decision, 'fqcRoutingRules'));

          const existing = await screenings.findOne({ filter: { id: screeningId } });
          if (!existing) throw screeningNotFound();
          if (
            await transaction
              .repository('fqcTickets')
              .findOne({ filter: { screeningId } })
          ) {
            throw alreadyDispatched();
          }

          // 最近一次确认记录：按 createdAt、id 都倒序，只取第一条。
          const reviewPolicy = policyOf(decision, 'fqcScreeningReviews');
          let latest: Record<string, unknown> | undefined;
          if (reviewPolicy.read !== false) {
            const rows = (await reviews.findMany({
              filter: (filter) =>
                filter.string('screeningId').eq(screeningId),
              sort: {
                kind: 'sort',
                version: 1,
                items: [
                  { kind: 'field', path: ['createdAt'], direction: 'desc' },
                  { kind: 'field', path: ['id'], direction: 'desc' },
                ],
              },
              limit: 1,
            })) as unknown as Record<string, unknown>[];
            latest = rows[0];
          }

          const category =
            body.category || asText(latest?.category) || asText(existing.category);
          const severity =
            body.severity || asText(latest?.severity) || asText(existing.severity);
          if (!category || !severity) {
            throw new ApiError({
              status: 'INVALID_ARGUMENT',
              reason: 'SCREENING_DRAFT_INCOMPLETE',
              domain: 'quality',
              message:
                'Neither the request, a confirmation nor the draft has a category and severity.',
            });
          }

          let departmentId =
            body.departmentId ??
            (latest && asText(latest.departmentId).length > 0
              ? asText(latest.departmentId)
              : null);
          if (!departmentId) {
            const rule = await routing.findOne({ filter: { category } });
            departmentId = rule ? asText(rule.departmentId) : null;
          }
          if (!departmentId) {
            throw new ApiError({
              status: 'FAILED_PRECONDITION',
              httpStatus: 422,
              reason: 'ROUTING_RULE_MISSING',
              domain: 'quality',
              message:
                'This category has no routing rule; pass a departmentId to dispatch.',
            });
          }

          // 不变量 3：责任部门必须在派单那一刻存在且未停用。与转派同一处部门服务判定；
          // 校验放在写确认记录与建工单之前，失败时两样都不落库。
          if ((await departments.subtreeIds(departmentId)).length === 0) {
            throw new ApiError({
              status: 'FAILED_PRECONDITION',
              httpStatus: 422,
              reason: 'DEPARTMENT_NOT_FOUND',
              domain: 'quality',
              message: `Department ${departmentId} does not exist or is disabled.`,
            });
          }

          const assigneeId = body.assigneeId ?? null;
          if (assigneeId !== null) {
            const memberIds = await departments.memberIdsOf(departmentId);
            if (!memberIds.includes(assigneeId)) {
              throw new ApiError({
                status: 'FAILED_PRECONDITION',
                httpStatus: 422,
                reason: 'ASSIGNEE_NOT_DEPARTMENT_MEMBER',
                domain: 'quality',
                message: 'The assignee is not a member of the responsible department.',
              });
            }
          }

          const reviewId = randomUUID();
          await reviews.createMany({
            values: [
              {
                id: reviewId,
                screeningId,
                kind: 'dispatch',
                category,
                severity,
                departmentId,
                actorId,
                createdAt: new Date(),
              },
            ],
          });

          // 与确认同一套版本前提：并发派单只让一个 UPDATE 匹配到行。
          const observedReviewId =
            typeof existing.reviewId === 'string' && existing.reviewId.length > 0
              ? existing.reviewId
              : null;
          const changed = await screenings.updateMany({
            filter: (filter) =>
              filter.and([
                filter.string('id').eq(screeningId),
                observedReviewId === null
                  ? filter.string('reviewId').empty()
                  : filter.string('reviewId').eq(observedReviewId),
              ]),
            values: { outcome: 'reviewed', reviewId, updatedAt: new Date() },
          });
          if (changed.updatedCount !== 1) {
            throw new ApiError({
              status: 'ABORTED',
              reason: 'SCREENING_REVIEW_CONFLICT',
              domain: 'quality',
              message: 'This screening changed while dispatching. Reload and try again.',
            });
          }

          const messageId = asText(existing.messageId);
          const message = messageId
            ? await transaction
                .repository('fqcMessages')
                .withPolicy(policyOf(decision, 'fqcMessages'))
                .findOne({ filter: { id: messageId } })
            : null;
          const now = new Date();
          const values = {
            id: randomUUID(),
            code: `FQC-${String(now.getTime()).slice(-8)}`,
            title: `${category} / ${severity}`,
            description: message
              ? asText(message.content).slice(0, 2000)
              : null,
            sourceMessageId: messageId.length > 0 ? messageId : null,
            screeningId,
            category,
            severity,
            departmentId,
            createdBy: actorId,
            assigneeId,
            state: 'open',
            closedAt: null,
            createdAt: now,
            updatedAt: now,
            statusChangedAt: null,
            lifecycleVersion: 0,
            lifecycleDefinition: 'fqcTickets',
          };
          try {
            await tickets.createMany({ values: [values] as never });
          } catch (error) {
            if (isUniqueConstraintViolation(error)) throw alreadyDispatched();
            throw error;
          }
          const stored = await tickets.findOne({ filter: { id: values.id } });
          if (!stored) {
            throw new ApiError({
              status: 'INTERNAL',
              reason: 'TICKET_NOT_WRITTEN',
              domain: 'quality',
              message: 'The new ticket could not be read back.',
            });
          }
          return stored;
        });

        return context.json({ data: ticket }, 201);
      },
    );

    // 人工确认（R-002 起语义改了）：不再原地改写草稿。读初筛、写一行确认记录、把
    // outcome 记成 reviewed 并把 reviewId 指过去，三件事在同一个事务里。
    // 有工单时这是改判：另写一行 rejudge，工单的类别与严重度跟着改（R-003 验收 6）。
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
          '422': unprocessableResponse,
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
            const tickets = transaction
              .repository('fqcTickets')
              .withPolicy(policyOf(decision, 'fqcTickets'));
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
            // 有工单就是改判，没有才是确认。两个分支共用一个事务与确认记录指针，
            // 区别只在 kind、工单要不要联动，以及两条额外的拒绝（R-003 验收 6）。
            const ticket = await tickets.findOne({
              filter: { screeningId },
            });
            const isRejudge = ticket !== null && ticket !== undefined;
            if (isRejudge) {
              if (ticket.state === 'closed') {
                throw new ApiError({
                  status: 'ABORTED',
                  reason: 'TICKET_CLOSED',
                  domain: 'quality',
                  message: 'The ticket is closed; reopen it before rejudging.',
                });
              }
              if (
                body.departmentId !== undefined &&
                asText(ticket.departmentId) !== body.departmentId
              ) {
                throw new ApiError({
                  status: 'FAILED_PRECONDITION',
                  httpStatus: 422,
                  reason: 'USE_REASSIGN',
                  domain: 'quality',
                  message: 'Changing the responsible department is a reassignment.',
                });
              }
            }
            // 请求体缺省时用草稿里的值：人没有改，就是确认 AI 的判断。
            const category = body.category ?? asText(existing.category);
            const severity = body.severity ?? asText(existing.severity);
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
              kind: isRejudge ? 'rejudge' : 'confirm',
              category,
              severity,
              departmentId:
                body.departmentId ??
                (isRejudge && asText(ticket.departmentId).length > 0
                  ? asText(ticket.departmentId)
                  : null),
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
          if (isRejudge) {
            // 只动类别与严重度：责任部门、经办人、状态、流转历史都不碰。
            await tickets.updateMany({
              filter: { id: asText(ticket.id) },
              values: { category, severity },
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
        // 确认当场回的这一行要和列表随行带的同形：schema 把 actorName 钉成必带，
        // 页面在列表重取回来之前先渲染这一行。只解析确认人一个姓名，解析不到给占位。
        const reviewNames = await namesOf([actorId]);
        return context.json({
          data: {
            ...result.screening,
            review: {
              ...result.review,
              actorName: reviewNames.get(actorId) ?? UNKNOWN_ACTOR_NAME,
            },
          },
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


    const notFound = (id: string) =>
      new ApiError({
        status: 'NOT_FOUND',
        reason: 'FEEDBACK_NOT_FOUND',
        domain: 'quality',
        message: `Feedback ${id} was not found.`,
      });
    const notOpen = () =>
      new ApiError({
        status: 'ABORTED',
        reason: 'FEEDBACK_NOT_OPEN',
        domain: 'quality',
        message: 'This feedback is no longer open.',
      });
    const replayUnreadable = () =>
      new ApiError({
        status: 'ALREADY_EXISTS',
        reason: 'OPERATION_CONFLICT',
        domain: 'app',
        message: "The replayed feedback is not readable in this caller's range.",
      });
    const requiredKey = () =>
      new ApiError({
        status: 'INVALID_ARGUMENT',
        reason: 'OPERATION_KEY_REQUIRED',
        domain: 'quality',
        message: 'Feedback creation requires an Idempotency-Key header.',
      });
    const principalRequired = () =>
      new ApiError({
        status: 'PERMISSION_DENIED',
        reason: 'PRINCIPAL_REQUIRED',
        domain: 'quality',
        message: 'An authenticated principal is required.',
      });

    /**
     * 新建（网页表单与人工代录）：只收表单字段，`ownerId` 一律按会话写。
     * 授权一次「提交反馈」；201 由写入值拼，不回内部备注与谁丢弃的。
     * 事务提交之后等模型升级那一步做完再回响应；重放经请求自己的读范围读回。
     */
    router.post(
      '/quality/feedbacks',
      describeRoute({
        tags: ['Quality'],
        summary: 'Submit a feedback sheet',
        operationId: 'submitFeedback',
        responses: {
          '201': dataResponse(FeedbackSchema),
          '400': apiErrorResponse(400),
          '401': apiErrorResponse(401),
          '403': apiErrorResponse(403),
          '409': apiErrorResponse(409),
          '500': apiErrorResponse(500),
        },
      }),
      apiValidator('json', CreateFeedbackBody),
      async (context) => {
        const body: CreateFeedbackInput = context.req.valid('json');
        // 先授权，再校验缺键、代录客户与附件个数：没有资格的人一律先 403。
        const decision = await authorizeFqc(context, 'submit');
        const session = context.get('auth');
        if (!session?.user?.id) {
          throw principalRequired();
        }
        const actorId = String(session.user.id);
        if ((body.attachmentIds?.length ?? 0) > 10) {
          throw new ApiError({
            status: 'INVALID_ARGUMENT',
            reason: 'TOO_MANY_ATTACHMENTS',
            domain: 'quality',
            message: 'A feedback may carry at most ten attachments.',
          });
        }
        if (body.channel === 'proxy' && !body.customerName) {
          throw new ApiError({
            status: 'INVALID_ARGUMENT',
            reason: 'CUSTOMER_REQUIRED',
            domain: 'quality',
            message: 'A proxy feedback must name the customer.',
          });
        }
        const key = context.req.header('Idempotency-Key');
        if (!key) {
          throw requiredKey();
        }
        const protection = app.container.resolve(repositoryIdempotencyToken);
        const principal = await protection.principal(context);
        if (!principal) {
          throw principalRequired();
        }
        const result = await executeIdempotentMutation({
          connection: database.connection(),
          key,
          principal,
          operation: `${context.req.method} ${new URL(context.req.url).pathname}`,
          input: body,
          authorize: () => undefined,
          authorizeReplay: () => undefined,
          execute: (transaction) =>
            ingestFeedback(
              {
                channel: body.channel,
                content: body.content,
                contentType: 'text',
                customerName: body.customerName ?? null,
                // 网页入口的发件人两列不落库；人工代录才落。
                senderName: body.channel === 'proxy' ? (body.senderName ?? null) : null,
                senderContact:
                  body.channel === 'proxy' ? (body.senderContact ?? null) : null,
                productName: body.productName ?? null,
                model: body.model ?? null,
                batchNo: body.batchNo ?? null,
                attachmentIds: body.attachmentIds ?? [],
                ownerId: actorId,
              },
              transaction,
              {
                messages: policyOf(decision, 'fqcMessages'),
                screenings: policyOf(decision, 'fqcScreenings'),
              },
              actorId,
              (text) => screening.screen(text),
            ),
        });
        context.header('Idempotency-Replayed', String(result.replayed));
        const written = result.data.message;
        // 首回由写入值拼；丢弃两列由服务端决定、建行时不写，但 FeedbackSchema
        // 把它们声明为必有，所以按列形态补 null，与重放读回来的键集一致。
        let responseRow: Record<string, unknown> = {
          discardedAt: null,
          discardReason: null,
          ...written,
        };
        if (result.replayed) {
          // 不带范围的仓储按 id 读回，会让重放拿到别人的行；这里必须用本次请求
          // 「提交反馈」的范围。读不到与重复投递同形，响应只有 error。
          const policy = policyOf(decision, 'fqcMessages');
          const current =
            policy.read === false
              ? undefined
              : await database
                  .connection()
                  .repository('fqcMessages')
                  .withPolicy(policy)
                  .findOne({ filter: { id: String(written.id) } });
          if (!current) {
            throw replayUnreadable();
          }
          responseRow = current;
        } else {
          await runPostCommitUpgrade(context, {
            screeningId: String(
              result.data.screening.id,
            ),
            text: String(written.content),
            policy: policyOf(decision, 'fqcScreenings'),
          });
        }
        return context.json({ data: responseRow }, 201);
      },
    );

    /** 「我的反馈」：提交反馈、仅本人；行里没有内部备注与谁丢弃的。 */
    router.get(
      '/quality/feedbacks/mine',
      describeRoute({
        tags: ['Quality'],
        summary: 'List feedbacks submitted by the current user',
        operationId: 'listMyFeedbacks',
        responses: {
          '200': listResponse(FeedbackSchema),
          '401': apiErrorResponse(401),
          '403': apiErrorResponse(403),
          '500': apiErrorResponse(500),
        },
      }),
      apiValidator('query', MineFeedbackQuery),
      async (context) => {
        const { status, page, pageSize } = context.req.valid('query');
        const decision = await authorizeFqc(context, 'submit');
        const repo = database
          .connection()
          .repository('fqcMessages')
          .withPolicy(policyOf(decision, 'fqcMessages'));
        const filter =
          status === undefined
            ? undefined
            : (filter: FilterBuilder) =>
                filter.string('status').eq(status);
        const rows = (await repo.findMany({
          ...(filter === undefined ? {} : { filter }),
          limit: pageSize,
          offset: (page - 1) * pageSize,
          sort: {
            kind: 'sort',
            version: 1,
            items: [{ kind: 'field', path: ['createdAt'], direction: 'desc' }],
          },
        })) as unknown as Record<string, unknown>[];
        const total =
          filter === undefined ? await repo.count() : await repo.count({ filter });
        return context.json({
          data: await decorate(rows, false, decision),
          meta: { page, pageSize, total },
        });
      },
    );

    /** 维护反馈单：全部的单，带四个筛选与拼出来的字段。 */
    router.get(
      '/quality/feedbacks',
      describeRoute({
        tags: ['Quality'],
        summary: 'List all feedback sheets',
        operationId: 'listFeedbacks',
        responses: {
          '200': listResponse(FeedbackSchema),
          '400': apiErrorResponse(400),
          '401': apiErrorResponse(401),
          '403': apiErrorResponse(403),
          '500': apiErrorResponse(500),
        },
      }),
      apiValidator('query', ListFeedbackQuery),
      async (context) => {
        const {
          status,
          channel,
          pending,
          overdue,
          createdBefore,
          createdAfter,
          q,
          page,
          pageSize,
        } = context.req.valid('query');
        const decision = await authorizeFqc(context, 'maintain');
        const repo = database
          .connection()
          .repository('fqcMessages')
          .withPolicy(policyOf(decision, 'fqcMessages'));

        // 没处理只认初筛的 outcome：人工确认与派单都把它记成 reviewed。
        let pendingIds: string[] | undefined;
        if (pending === true || overdue === true) {
          const screeningRows = (await database
            .connection()
            .repository('fqcScreenings')
            .withPolicy(policyOf(decision, 'fqcScreenings'))
            .findMany({ limit: 5000 })) as unknown as {
            messageId: unknown;
            outcome: unknown;
          }[];
          pendingIds = screeningRows
            .filter((row) => row.outcome !== 'reviewed')
            .map((row) => asText(row.messageId));
        }
        const overdueBefore = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        const filter = (
          filter: FilterBuilder,
        ) => {
          const parts = [
            ...(status === undefined ? [] : [filter.string('status').eq(status)]),
            ...(channel === undefined ? [] : [filter.string('channel').eq(channel)]),
            ...(createdBefore === undefined
              ? []
              : [filter.date('createdAt').before(new Date(createdBefore))]),
            ...(createdAfter === undefined
              ? []
              : [filter.date('createdAt').after(new Date(createdAfter))]),
            ...(overdue === true
              ? [filter.date('createdAt').before(overdueBefore)]
              : []),
            ...(pendingIds === undefined
              ? []
              : [
                  filter.or(
                    pendingIds.map((id) => filter.string('id').eq(id)),
                  ),
                ]),
            ...(q === undefined
              ? []
              : [
                  filter.or([
                    filter.string('customerName').includes(q, { mode: 'insensitive' }),
                    filter.string('productName').includes(q, { mode: 'insensitive' }),
                    filter.string('model').includes(q, { mode: 'insensitive' }),
                    filter.string('batchNo').includes(q, { mode: 'insensitive' }),
                    filter.text('content').includes(q, { mode: 'insensitive' }),
                  ]),
                ]),
          ];
          return parts.length === 0 ? filter.string('id').notEmpty() : filter.and(parts);
        };
        if (pendingIds !== undefined && pendingIds.length === 0) {
          return context.json({
            data: [],
            meta: { page, pageSize, total: 0 },
          });
        }
        const rows = (await repo.findMany({
          filter,
          limit: pageSize,
          offset: (page - 1) * pageSize,
          sort: {
            kind: 'sort',
            version: 1,
            items: [{ kind: 'field', path: ['createdAt'], direction: 'desc' }],
          },
        })) as unknown as Record<string, unknown>[];
        const total = await repo.count({ filter });
        return context.json({
          data: await decorate(rows, true, decision),
          meta: { page, pageSize, total },
        });
      },
    );

    router.get(
      '/quality/feedbacks/:feedbackId',
      describeRoute({
        tags: ['Quality'],
        summary: 'Get one feedback sheet',
        operationId: 'getFeedback',
        responses: {
          '200': dataResponse(FeedbackSchema),
          '401': apiErrorResponse(401),
          '403': apiErrorResponse(403),
          '404': apiErrorResponse(404),
          '500': apiErrorResponse(500),
        },
      }),
      async (context) => {
        const id = context.req.param('feedbackId');
        const decision = await authorizeFqc(context, 'maintain');
        const row = (await database
          .connection()
          .repository('fqcMessages')
          .withPolicy(policyOf(decision, 'fqcMessages'))
          .findOne({ filter: { id } })) as unknown as Record<string, unknown> | undefined;
        if (!row) {
          throw notFound(id);
        }
        const [decorated] = await decorate([row], true, decision);
        return context.json({ data: decorated });
      },
    );

    router.patch(
      '/quality/feedbacks/:feedbackId',
      describeRoute({
        tags: ['Quality'],
        summary: 'Change the form fields of a feedback sheet',
        operationId: 'updateFeedback',
        responses: {
          '200': dataResponse(FeedbackSchema),
          '400': apiErrorResponse(400),
          '401': apiErrorResponse(401),
          '403': apiErrorResponse(403),
          '404': apiErrorResponse(404),
          '409': apiErrorResponse(409),
          '500': apiErrorResponse(500),
        },
      }),
      apiValidator('json', UpdateFeedbackBody),
      async (context) => {
        const id = context.req.param('feedbackId');
        const body = context.req.valid('json') as Record<string, unknown>;
        const decision = await authorizeFqc(context, 'maintain');
        if (Object.keys(body).length === 0) {
          throw new ApiError({
            status: 'INVALID_ARGUMENT',
            reason: 'EMPTY_UPDATE',
            domain: 'quality',
            message: 'At least one field is required.',
          });
        }
        const session = context.get('auth');
        const actorId = session?.user?.id === undefined ? null : String(session.user.id);
        const result = await database.connection().transaction(async (transaction) => {
          const repo = transaction
            .repository('fqcMessages')
            .withPolicy(policyOf(decision, 'fqcMessages'));
          const existing = (await repo.findOne({ filter: { id } })) as unknown as
            | Record<string, unknown>
            | undefined;
          if (!existing) {
            throw notFound(id);
          }
          if (asText(existing.status) !== 'open') {
            throw notOpen();
          }
          const fields: Record<string, unknown> = {};
          for (const key of ['customerName', 'productName', 'model', 'batchNo', 'note'] as const) {
            if (key in body) {
              fields[key] = body[key];
            }
          }
          const desiredIds =
            body.attachmentIds === undefined
              ? undefined
              : [...(body.attachmentIds as string[])];
          if (desiredIds !== undefined && desiredIds.length > 10) {
            throw new ApiError({
              status: 'INVALID_ARGUMENT',
              reason: 'TOO_MANY_ATTACHMENTS',
              domain: 'quality',
              message: 'A feedback may carry at most ten attachments.',
            });
          }
          // 附件三条规则与录入共用一处判断，都在这个事务里。
          const files = transaction.repository('fqcFeedbackFiles');
          const previousIds = Array.isArray(existing.attachmentIds)
            ? (existing.attachmentIds as string[]).map(String)
            : [];
          const added = (desiredIds ?? []).filter((fileId) => !previousIds.includes(fileId));
          for (const fileId of added) {
            const file = await files.findOne({
              filter: (filter) =>
                filter.and([
                  filter.string('id').eq(fileId),
                  actorId === null
                    ? filter.string('ownerId').empty()
                    : filter.string('ownerId').eq(actorId),
                  filter.string('feedbackId').empty(),
                ]),
            });
            if (!file) {
              throw new ApiError({
                status: 'FAILED_PRECONDITION',
                httpStatus: 422,
                reason: 'ATTACHMENT_NOT_AVAILABLE',
                domain: 'quality',
                message: `Attachment ${fileId} is not available to this caller.`,
              });
            }
          }
          fields.updatedAt = storedDateTime(new Date());
          if (desiredIds !== undefined) {
            fields.attachmentIds = desiredIds;
          }
          const updated = await repo.updateMany({
            filter: (filter) =>
              filter.and([
                filter.string('id').eq(id),
                filter.string('status').eq('open'),
              ]),
            values: fields as never,
          });
          if (updated.updatedCount !== 1) {
            throw notOpen();
          }
          if (desiredIds !== undefined) {
            const removed = previousIds.filter((fileId) => !desiredIds.includes(fileId));
            const now = storedDateTime(new Date());
            if (added.length > 0) {
              await files.updateMany({
                filter: (filter) =>
                  filter.and([
                    filter.or(added.map((fileId) => filter.string('id').eq(fileId))),
                    filter.string('feedbackId').empty(),
                  ]),
                values: { feedbackId: id, updatedAt: now } as never,
              });
            }
            if (removed.length > 0) {
              await files.updateMany({
                filter: (filter) =>
                  filter.and([
                    filter.or(removed.map((fileId) => filter.string('id').eq(fileId))),
                    filter.string('feedbackId').eq(id),
                  ]),
                values: { feedbackId: null, updatedAt: now } as never,
              });
            }
          }
          return await repo.findOne({ filter: { id } });
        });
        if (!result) {
          throw notFound(id);
        }
        const [decorated] = await decorate([result], true, decision);
        return context.json({ data: decorated });
      },
    );

    router.post(
      '/quality/feedbacks/:feedbackId/discard',
      describeRoute({
        tags: ['Quality'],
        summary: 'Discard a feedback sheet',
        operationId: 'discardFeedback',
        responses: {
          '200': dataResponse(FeedbackSchema),
          '400': apiErrorResponse(400),
          '401': apiErrorResponse(401),
          '403': apiErrorResponse(403),
          '404': apiErrorResponse(404),
          '409': apiErrorResponse(409),
          '500': apiErrorResponse(500),
        },
      }),
      apiValidator('json', DiscardFeedbackBody),
      async (context) => {
        const id = context.req.param('feedbackId');
        const { reason } = context.req.valid('json');
        const decision = await authorizeFqc(context, 'maintain');
        const session = context.get('auth');
        const actorId = session?.user?.id === undefined ? null : String(session.user.id);
        const result = await database.connection().transaction(async (transaction) => {
          const repo = transaction
            .repository('fqcMessages')
            .withPolicy(policyOf(decision, 'fqcMessages'));
          const existing = await repo.findOne({ filter: { id } });
          if (!existing) {
            throw notFound(id);
          }
          if (asText(existing.status) !== 'open') {
            throw notOpen();
          }
          const tickets = await transaction
            .repository('fqcTickets')
            .withPolicy(policyOf(decision, 'fqcTickets'))
            .count({ filter: { sourceMessageId: id } });
          if (tickets > 0) {
            throw new ApiError({
              status: 'ABORTED',
              reason: 'FEEDBACK_DISPATCHED',
              domain: 'quality',
              message: 'A feedback with a ticket cannot be discarded.',
            });
          }
          const updated = await repo.updateMany({
            filter: (filter) =>
              filter.and([
                filter.string('id').eq(id),
                filter.string('status').eq('open'),
              ]),
            values: {
              status: 'discarded',
              discardedAt: storedDateTime(new Date()),
              discardedBy: actorId,
              discardReason: reason,
              updatedAt: storedDateTime(new Date()),
            },
          });
          if (updated.updatedCount !== 1) {
            throw notOpen();
          }
          return await repo.findOne({ filter: { id } });
        });
        if (!result) {
          throw notFound(id);
        }
        const [decorated] = await decorate([result], true, decision);
        return context.json({ data: decorated });
      },
    );

    /**
     * 上传一个附件（表单提交之前）。先按「提交反馈」授权，再碰请求体；没有资格的人
     * 发一个坏掉的请求体也得到 403。类型按上传声明与扩展名判，大小按文件精确判，
     * 请求长度先把明显过大的体挡在解析之前。失败时既不写盘也不写库。
     */
    router.post(
      '/quality/feedback-files',
      describeRoute({
        tags: ['Quality'],
        summary: 'Upload one feedback attachment',
        operationId: 'uploadFeedbackFile',
        requestBody: {
          required: true,
          content: {
            'multipart/form-data': {
              schema: {
                type: 'object',
                required: ['file'],
                properties: { file: { type: 'string', format: 'binary' } },
              },
            },
          },
        },
        responses: {
          '201': dataResponse(FeedbackFileSchema),
          '400': apiErrorResponse(400, 'No single `file` was uploaded.'),
          '401': apiErrorResponse(401),
          '403': apiErrorResponse(403),
          '413': apiErrorResponse(413),
          '415': apiErrorResponse(415),
          '500': apiErrorResponse(500),
        },
      }),
      // 先授权再读请求体：没有 submit 的人一律 403，坏请求体也不会先得到 400。
      // Hono 的 bodyLimit 信任 content-length；谎报或缺失的客户端会绕过解析前预检，
      // 所以在挂硬闸之前把该头去掉，让 bodyLimit 走按字节计数的流式分支。
      async (context, next) => {
        await authorizeFqc(context, 'submit');
        const session = context.get('auth');
        if (!session?.user?.id) {
          throw principalRequired();
        }
        uploadOwner.set(context, String(session.user.id));
        const length = context.req.header('content-length');
        if (
          length !== undefined &&
          Number(length) > FEEDBACK_FILE_MAX_BYTES + FEEDBACK_FILE_BODY_SLACK
        ) {
          throw fileError(
            'INVALID_ARGUMENT',
            'FILE_TOO_LARGE',
            413,
            `A feedback attachment may be at most ${FEEDBACK_FILE_MAX_BYTES} bytes.`,
          );
        }
        context.req.raw.headers.delete('content-length');
        await next();
      },
      // 解析期硬闸：即使请求头谎报或分块传输，也在读完之前中断并回 413。
      bodyLimit({
        maxSize: FEEDBACK_FILE_MAX_BYTES + FEEDBACK_FILE_BODY_SLACK,
        onError: (c) =>
          apiErrorHandler(
            fileError(
              'INVALID_ARGUMENT',
              'FILE_TOO_LARGE',
              413,
              `A feedback attachment request body may be at most ${
                FEEDBACK_FILE_MAX_BYTES + FEEDBACK_FILE_BODY_SLACK
              } bytes.`,
            ),
            c,
          ),
      }),
      async (context) => {
        const actorId = uploadOwner.get(context);
        if (actorId === undefined) {
          throw principalRequired();
        }
        const media = context.req.header('content-type')?.toLowerCase() ?? '';
        if (!media.startsWith('multipart/form-data;')) {
          throw fileError(
            'INVALID_ARGUMENT',
            'UNSUPPORTED_MEDIA_TYPE',
            415,
            'Expected multipart/form-data.',
          );
        }
        let body: Record<string, unknown>;
        try {
          body = await context.req.parseBody({ all: true });
        } catch {
          throw fileError(
            'INVALID_ARGUMENT',
            'INVALID_MULTIPART',
            400,
            'Invalid multipart body.',
          );
        }
        const file = body.file;
        if (!(file instanceof File) || Array.isArray(file)) {
          throw fileError(
            'INVALID_ARGUMENT',
            'FILE_REQUIRED',
            undefined,
            'Exactly one `file` is required.',
          );
        }
        if (file.size > FEEDBACK_FILE_MAX_BYTES) {
          throw fileError(
            'INVALID_ARGUMENT',
            'FILE_TOO_LARGE',
            413,
            `A feedback attachment may be at most ${FEEDBACK_FILE_MAX_BYTES} bytes.`,
          );
        }
        // 文件名里的路径与声明的扩展名都要对上；请求体里另塞的字段一概不读。
        const filename = String(file.name).split(/[\\/]/u).pop() ?? '';
        const dot = filename.lastIndexOf('.');
        const ext = dot > 0 ? filename.slice(dot + 1).toLowerCase() : '';
        const declared = String(file.type).toLowerCase();
        if (FEEDBACK_FILE_TYPES[declared]?.includes(ext) !== true) {
          throw fileError(
            'INVALID_ARGUMENT',
            'FILE_TYPE_NOT_ALLOWED',
            415,
            `Attachment type ${declared} with extension "${ext}" is not allowed.`,
          );
        }
        const { record } = await feedbackFileRepository(actorId).uploadOne({
          file,
        });
        return context.json(
          {
            data: {
              id: record.id,
              filename: record.filename,
              mimeType: record.mimeType,
              size: Number(record.size),
            },
          },
          201,
        );
      },
    );

    /** 「我的反馈」下的附件：先按本人范围确认这张单，再确认文件挂在这张单上。 */
    router.get(
      '/quality/feedbacks/mine/:feedbackId/attachments/:fileId',
      describeRoute({
        tags: ['Quality'],
        summary: 'Get one attachment of one of my feedbacks',
        operationId: 'getMyFeedbackAttachment',
        responses: {
          '200': { description: 'The attachment bytes.' },
          '401': apiErrorResponse(401),
          '403': apiErrorResponse(403),
          '404': apiErrorResponse(404),
          '500': apiErrorResponse(500),
        },
      }),
      async (context) => {
        const decision = await authorizeFqc(context, 'submit');
        const id = String(context.req.param('feedbackId'));
        const fileId = String(context.req.param('fileId'));
        const policy = policyOf(decision, 'fqcMessages');
        const feedback =
          policy.read === false
            ? undefined
            : await database
                .connection()
                .repository('fqcMessages')
                .withPolicy(policy)
                .findOne({ filter: { id } });
        if (!feedback) {
          throw attachmentNotFound(fileId);
        }
        const file = (await database
          .connection()
          .repository('fqcFeedbackFiles')
          .findOne({
            filter: (filter) =>
              filter.and([
                filter.string('id').eq(fileId),
                filter.string('feedbackId').eq(id),
              ]),
          })) as unknown as Record<string, unknown> | undefined;
        if (!file) {
          throw attachmentNotFound(fileId);
        }
        return await sendFeedbackFile(context, file);
      },
    );

    /** 维护反馈单下的附件：先按全部范围确认这张单，再确认文件挂在这张单上。 */
    router.get(
      '/quality/feedbacks/:feedbackId/attachments/:fileId',
      describeRoute({
        tags: ['Quality'],
        summary: 'Get one attachment of a feedback sheet',
        operationId: 'getFeedbackAttachment',
        responses: {
          '200': { description: 'The attachment bytes.' },
          '401': apiErrorResponse(401),
          '403': apiErrorResponse(403),
          '404': apiErrorResponse(404),
          '500': apiErrorResponse(500),
        },
      }),
      async (context) => {
        const decision = await authorizeFqc(context, 'maintain');
        const id = String(context.req.param('feedbackId'));
        const fileId = String(context.req.param('fileId'));
        const feedback = await database
          .connection()
          .repository('fqcMessages')
          .withPolicy(policyOf(decision, 'fqcMessages'))
          .findOne({ filter: { id } });
        if (!feedback) {
          throw notFound(id);
        }
        const file = (await database
          .connection()
          .repository('fqcFeedbackFiles')
          .findOne({
            filter: (filter) =>
              filter.and([
                filter.string('id').eq(fileId),
                filter.string('feedbackId').eq(id),
              ]),
          })) as unknown as Record<string, unknown> | undefined;
        if (!file) {
          throw attachmentNotFound(fileId);
        }
        return await sendFeedbackFile(context, file);
      },
    );

    return new Hono().route('/', router);
  },
);
