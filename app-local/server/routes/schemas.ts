import { z } from 'zod';

import { DEFECT_CATEGORIES } from '../providers/quality-screening.js';

export const IngestMessageBody = z.object({
  channel: z.string().min(1).max(32),
  externalId: z.string().max(128).optional(),
  senderName: z.string().max(128).optional(),
  senderContact: z.string().max(128).optional(),
  content: z.string().min(1).max(8000),
  contentType: z.enum(['text', 'image', 'file', 'mixed']).default('text'),
  // 带 `Z` 或带偏移的时间都接受；写入列前统一换算成服务器本地墙钟（见 routes/quality.ts）。
  receivedAt: z.string().datetime({ offset: true }).optional(),
});

export type IngestMessageInput = z.infer<typeof IngestMessageBody>;

export const MessageSchema = z.object({
  id: z.string(),
  channel: z.string(),
  externalId: z.string().nullable(),
  senderName: z.string().nullable(),
  senderContact: z.string().nullable(),
  content: z.string(),
  rawContentType: z.string(),
  receivedAt: z.string(),
  status: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

/** 确认记录的一行（R-002）。只追加；`kind` 本条只有 confirm。 */
export const ScreeningReviewSchema = z.object({
  id: z.string(),
  screeningId: z.string(),
  kind: z.string(),
  category: z.string(),
  severity: z.string(),
  departmentId: z.string().nullable(),
  actorId: z.string(),
  createdAt: z.string(),
});

/**
 * 初筛的一行。R-002 加六个出处列与 `reviewId`；模型版草稿的值也在这张表上
 * （类别、严重度、建议责任方、摘要、置信度、evidence、modelName）。
 *
 * `review` 只在确认端点的响应里出现：列表的每一行没有随行读确认记录，
 * 所以它是可选的，不是空的。
 */
export const ScreeningSchema = z.object({
  id: z.string(),
  messageId: z.string(),
  category: z.string().nullable(),
  severity: z.string().nullable(),
  suggestedOwner: z.string().nullable(),
  summary: z.string().nullable(),
  confidence: z.string().nullable(),
  evidence: z.unknown().nullable(),
  modelName: z.string().nullable(),
  engine: z.string(),
  promptVersion: z.string().nullable(),
  degraded: z.boolean(),
  degradeReason: z.string().nullable(),
  knowledgeRefs: z.array(z.string()).nullable(),
  redacted: z.boolean(),
  reviewId: z.string().nullable(),
  outcome: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  review: ScreeningReviewSchema.optional(),
});

/**
 * 初筛列表的一行。
 *
 * `canReview` 只表示这一行的状态：是「待人工复核」就为真。调用的人有没有处理权限
 * 不在这里判 —— 那要在同一个请求里再授权一次。前端把 `canReview` 与 `useCan` 合起来
 * 决定「确认初筛」显不显示。
 */
export const ScreeningListItemSchema = ScreeningSchema.extend({
  canReview: z.boolean(),
});

/** 确认端点的响应：仍是初筛那一行，多出刚写的确认记录。 */
export const ScreeningReviewResultSchema = ScreeningSchema.extend({
  review: ScreeningReviewSchema,
});

export const TicketSchema = z.object({
  id: z.string(),
  code: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  sourceMessageId: z.string().nullable(),
  screeningId: z.string().nullable(),
  category: z.string().nullable(),
  severity: z.string(),
  ownerDepartment: z.string().nullable(),
  assigneeId: z.string().nullable(),
  state: z.string(),
  dueAt: z.string().nullable(),
  closedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const ListTicketsQuery = z.object({
  state: z.string().optional(),
  ownerDepartment: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export const IngestResultSchema = z.object({
  message: MessageSchema,
  screening: ScreeningSchema,
  ticket: TicketSchema,
});

/**
 * 人工确认的请求体（R-002）：只带人确认成的值，缺省时用草稿里的值。
 *
 * `ownerDepartment` 改成 `departmentId`：确认成的责任部门是 R-012 的部门标识，
 * 与工单上那个由规则/模型给出的路由键 `suggestedOwner` 不是一回事。草稿不再被改写，
 * 所以这里的值只进确认记录，不进初筛行。
 */
export const ApproveScreeningBody = z.object({
  category: z.enum(DEFECT_CATEGORIES).optional(),
  severity: z.enum(['critical', 'major', 'minor', 'info']).optional(),
  departmentId: z.string().max(64).optional(),
});

/**
 * 代填效果（R-002）的查询与返回。
 *
 * `from`、`to` 必填，两端都有时才准；区间落在初筛的 `createdAt` 上。返回只有汇总的
 * 数字：各引擎的条数、没跑或回落的原因分布、草稿与确认在类别和严重度上的一致与
 * 不一致、脱敏的条数。没有任何消息正文、发件人姓名与联系方式。
 */
export const DraftingStatsQuery = z.object({
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
});

const CountPairSchema = z.object({
  matched: z.number().int(),
  mismatched: z.number().int(),
});

export const DraftingStatsSchema = z.object({
  from: z.string(),
  to: z.string(),
  total: z.number().int(),
  engines: z.object({
    rules: z.number().int(),
    model: z.number().int(),
  }),
  degradeReasons: z.object({
    'model-disabled': z.number().int(),
    'model-not-configured': z.number().int(),
    'model-error': z.number().int(),
    timeout: z.number().int(),
    'invalid-output': z.number().int(),
  }),
  redacted: z.number().int(),
  confirmed: z.number().int(),
  agreement: z.object({
    category: CountPairSchema,
    severity: CountPairSchema,
  }),
});

/**
 * R-032「应用 API 密钥」：应用自己写的六个端点。应用密钥代表服务账号，
 * 必须过期；明文只在签发与轮换的响应里出现。
 */

export const CreateServiceAccountBody = z.object({
  name: z.string().trim().min(1).max(128),
});

export const ServiceAccountSchema = z.object({
  id: z.string(),
  name: z.string(),
  disabledAt: z.string().nullable(),
});

export const ApplicationApiKeySchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  description: z.string().nullable(),
  start: z.string().nullable(),
  enabled: z.boolean(),
  createdAt: z.string(),
  expiresAt: z.string().nullable(),
  lastUsedAt: z.string().nullable(),
  scope: z.unknown().nullable(),
});

/** 签发与轮换：明文只在这一个响应里。重放同一个幂等键时不再带明文。 */
export const CreatedApplicationApiKeySchema = z.object({
  key: ApplicationApiKeySchema,
  secret: z.string().optional(),
});

export const IssueApplicationApiKeyBody = z.object({
  name: z.string().trim().min(1).max(128),
  description: z.string().trim().max(500).optional(),
  expiresInDays: z.number().int().min(1).max(365),
});

/**
 * R-032 的补充：服务账号的角色就是授权插件里的权限集。名称在库里存成字符串，
 * 或 `{ key, ns }` 这样的词条描述符，页面拿它翻译。
 */
export const PermissionSetTitleSchema = z.union([
  z.string(),
  z.object({ key: z.string(), ns: z.string() }),
]);

export const ServiceAccountRoleSchema = z.object({
  key: z.string(),
  title: PermissionSetTitleSchema.nullable(),
});

/** 持有的权限集，以及可以给它的权限集清单（不含 root 与任何不受限制的权限集）。 */
export const ServiceAccountRolesSchema = z.object({
  roles: z.array(ServiceAccountRoleSchema),
  options: z.array(ServiceAccountRoleSchema),
});

export const ReplaceServiceAccountRolesBody = z.object({
  keys: z.array(z.string().min(1).max(128)),
});
