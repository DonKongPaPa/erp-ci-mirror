import { z } from 'zod';

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

export const ScreeningSchema = z.object({
  id: z.string(),
  messageId: z.string(),
  category: z.string().nullable(),
  severity: z.string().nullable(),
  suggestedOwner: z.string().nullable(),
  summary: z.string().nullable(),
  confidence: z.string().nullable(),
  modelName: z.string().nullable(),
  outcome: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
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

export const ApproveScreeningBody = z.object({
  category: z.string().max(64).optional(),
  severity: z.enum(['critical', 'major', 'minor', 'info']).optional(),
  ownerDepartment: z.string().max(64).optional(),
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
