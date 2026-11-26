import { z } from 'zod';

import { DEFECT_CATEGORIES } from '../providers/quality-screening.js';

export const IngestMessageBody = z.object({
  channel: z.string().min(1).max(32),
  // 空串在 schema 层就拒；设计里「空的两条可并存」指归一后的 NULL。
  externalId: z.string().min(1).max(128).optional(),
  senderName: z.string().max(128).optional(),
  senderContact: z.string().max(128).optional(),
  content: z.string().min(1).max(8000),
  contentType: z.enum(['text', 'image', 'file', 'mixed']).default('text'),
  // 带 `Z` 或带偏移的时间都接受；写入列前统一换算成服务器本地墙钟（见 routes/quality.ts）。
  receivedAt: z.string().datetime({ offset: true }).optional(),
  // R-026：投递契约多出的五个可选字段，上报与人工入口同形。
  customerName: z.string().min(1).max(128).optional(),
  productName: z.string().min(1).max(128).optional(),
  model: z.string().min(1).max(128).optional(),
  batchNo: z.string().min(1).max(64).optional(),
  attachmentIds: z.array(z.string().min(1)).optional(),
});

export type IngestMessageInput = z.infer<typeof IngestMessageBody>;

/** 可改的文本字段：不带键是不动，`null` 是清掉，空串是 400。 */
const nullableText = (max: number) =>
  z.union([z.string().min(1).max(max), z.null()]).optional();

/**
 * R-026 新建反馈的请求体。
 *
 * 只收表单字段；`ownerId`、`status`、丢弃三列等由服务端决定，请求体里带了也由
 * z.object 的默认行为剥掉，不在入库值里出现。附件个数在端点里判，才能给
 * `TOO_MANY_ATTACHMENTS` 这个原因码。
 */
export const CreateFeedbackBody = z.object({
  channel: z.enum(['web', 'proxy']).default('web'),
  customerName: nullableText(128),
  senderName: nullableText(128),
  senderContact: nullableText(128),
  productName: nullableText(128),
  model: nullableText(128),
  batchNo: nullableText(64),
  content: z.string().min(1).max(8000),
  attachmentIds: z.array(z.string().min(1)).optional(),
});

export type CreateFeedbackInput = z.infer<typeof CreateFeedbackBody>;

/** 改字段：至少带一个键；一个都不带是 400 `EMPTY_UPDATE`（在端点里判原因码）。 */
export const UpdateFeedbackBody = z.object({
  customerName: nullableText(128),
  productName: nullableText(128),
  model: nullableText(128),
  batchNo: nullableText(64),
  note: nullableText(2000),
  attachmentIds: z.array(z.string().min(1)).max(10).optional(),
});

export type UpdateFeedbackInput = z.infer<typeof UpdateFeedbackBody>;

/** 丢弃的原因，逐项列在声明里。 */
export const DiscardFeedbackBody = z.object({
  reason: z.enum(['not-defect', 'duplicate', 'other']),
});

export type DiscardFeedbackInput = z.infer<typeof DiscardFeedbackBody>;

/** 全部列表的查询参数。`pending` 与 `overdue` 只有 true 生效。 */
export const ListFeedbackQuery = z.object({
  status: z.enum(['open', 'discarded']).optional(),
  channel: z.string().min(1).max(32).optional(),
  pending: z.coerce.boolean().optional(),
  overdue: z.coerce.boolean().optional(),
  createdBefore: z.string().datetime({ offset: true }).optional(),
  createdAfter: z.string().datetime({ offset: true }).optional(),
  q: z.string().min(1).max(64).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export type ListFeedbackQueryInput = z.infer<typeof ListFeedbackQuery>;

/** 「我的反馈」只按状态与分页筛。 */
export const MineFeedbackQuery = z.object({
  status: z.enum(['open', 'discarded']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export type MineFeedbackQueryInput = z.infer<typeof MineFeedbackQuery>;

/** 维护行里带出的初筛八列；列表里没有 `evidence` 等依据列。 */
const ScreenShotSchema = z.object({
  id: z.string(),
  messageId: z.string(),
  category: z.string().nullable(),
  severity: z.string().nullable(),
  suggestedOwner: z.string().nullable(),
  summary: z.string().nullable(),
  confidence: z.string().nullable(),
  outcome: z.string(),
});

/** 一行反馈。`note` 与 `discardedBy` 只在「维护反馈单」的返回里有。 */
export const FeedbackSchema = z.object({
  id: z.string(),
  channel: z.string(),
  externalId: z.string().nullable(),
  senderName: z.string().nullable(),
  senderContact: z.string().nullable(),
  content: z.string(),
  rawContentType: z.string(),
  receivedAt: z.string(),
  status: z.enum(['open', 'discarded']),
  customerName: z.string().nullable(),
  productName: z.string().nullable(),
  model: z.string().nullable(),
  batchNo: z.string().nullable(),
  attachmentIds: z.array(z.string()).nullable(),
  ownerId: z.string().nullable(),
  discardedAt: z.string().nullable(),
  discardReason: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  note: z.string().nullable().optional(),
  discardedBy: z.string().nullable().optional(),
  submitterName: z.string().nullable(),
  attachments: z.array(
    z.object({
      id: z.string(),
      filename: z.string(),
      mimeType: z.string(),
      size: z.number(),
      url: z.string(),
    }),
  ),
  canEdit: z.boolean(),
  canDiscard: z.boolean(),
  screening: ScreenShotSchema.optional(),
  ticket: z
    .object({ id: z.string(), code: z.string(), state: z.string() })
    .nullable()
    .optional(),
});

/** R-026 S4：上传附件成功只回标识与服务端探测出的元数据，不回任何地址。 */
export const FeedbackFileSchema = z.object({
  id: z.string(),
  filename: z.string(),
  mimeType: z.string(),
  size: z.number(),
});

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
  /** 经 PeopleQueryService 解析出的姓名；解析不到是中性占位，不回邮箱、手机号。 */
  actorName: z.string(),
  createdAt: z.string(),
});

/**
 * 初筛的一行。R-002 加六个出处列与 `reviewId`；模型版草稿的值也在这张表上
 * （类别、严重度、建议责任方、摘要、置信度、evidence、modelName）。
 *
 * `review` 是可选的：投递响应不带这行；列表已确认的行随行带最近一次确认记录，
 * 没确认或读不到确认记录时是 `null`。确认端点必带刚写下的那一行。
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
  review: ScreeningReviewSchema.nullable().optional(),
});

/**
 * 初筛列表的一行。
 *
 * `canReview` 只表示这一行的状态：是「待人工复核」就为真。调用的人有没有处理权限
 * 不在这里判 —— 那要在同一个请求里再授权一次。前端把 `canReview` 与 `useCan` 合起来
 * 决定「确认初筛」显不显示。`review` 随行带最近一次确认（或 null），刷新后仍可见。
 */
export const ScreeningListItemSchema = ScreeningSchema.extend({
  canReview: z.boolean(),
  review: ScreeningReviewSchema.nullable(),
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

/**
 * 投递 201 的一行消息：验收 9 起比 `/quality/messages` 的十一列多出五个表单列。
 * `MessageSchema` 仍给按「查看」取行的列表端点用，两者不要混。
 * `ownerId` 机器入口不带，给了也不回；schema 允许它缺席。
 */
export const IngestResultMessageSchema = MessageSchema.extend({
  customerName: z.string().nullable(),
  productName: z.string().nullable(),
  model: z.string().nullable(),
  batchNo: z.string().nullable(),
  attachmentIds: z.array(z.string()).nullable(),
  ownerId: z.string().nullable().optional(),
});

export const IngestResultSchema = z.object({
  message: IngestResultMessageSchema,
  screening: ScreeningSchema,
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

/**
 * R-011 员工端点的请求与响应形状。
 *
 * 邮箱只作为入职的可选输入（不存档案、不回任何读端点）；口令也只在入职输入里出现，
 * 不进响应。响应 schema 逐列列出，多一列（尤其 email）就是暴露面扩大。
 */
const employeeId = z.string().min(1).max(64);
const employeeDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');
const optionalReference = employeeId.nullable().optional();

export const ListEmployeesQuery = z.object({
  q: z.string().min(1).max(64).optional(),
  status: z.enum(['active', 'left']).optional(),
  departmentId: employeeId.optional(),
  positionId: employeeId.optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export type ListEmployeesQueryInput = z.infer<typeof ListEmployeesQuery>;

export const EmployeeCandidatesQuery = z.object({
  q: z.string().min(1).max(64),
  departmentId: employeeId.optional(),
  departmentIds: z.string().max(512).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
});

export type EmployeeCandidatesQueryInput = z.infer<typeof EmployeeCandidatesQuery>;

export const HireEmployeeBody = z.object({
  name: z.string().trim().min(1).max(128),
  username: z.string().trim().min(1).max(64).optional(),
  email: z.string().trim().email().max(254).optional(),
  password: z.string().min(1).max(256).optional(),
  hiredOn: employeeDate,
  positionId: optionalReference,
  gradeId: optionalReference,
  reportsToUserId: optionalReference,
  primaryDepartmentId: optionalReference,
});

export type HireEmployeeInput = z.infer<typeof HireEmployeeBody>;

export const LinkEmployeeBody = z.object({
  userId: employeeId,
  hiredOn: employeeDate,
  positionId: optionalReference,
  gradeId: optionalReference,
  reportsToUserId: optionalReference,
  primaryDepartmentId: optionalReference,
});

export type LinkEmployeeInput = z.infer<typeof LinkEmployeeBody>;

export const UpdateEmployeeBody = z
  .object({
    positionId: optionalReference,
    gradeId: optionalReference,
    reportsToUserId: optionalReference,
  })
  .refine(
    (value) =>
      Object.prototype.hasOwnProperty.call(value, 'positionId') ||
      Object.prototype.hasOwnProperty.call(value, 'gradeId') ||
      Object.prototype.hasOwnProperty.call(value, 'reportsToUserId'),
    'At least one of positionId, gradeId or reportsToUserId is required',
  );

export type UpdateEmployeeInput = z.infer<typeof UpdateEmployeeBody>;

export const LeaveEmployeeBody = z.object({
  leftOn: employeeDate,
  note: z.string().trim().max(500).optional(),
});

export type LeaveEmployeeInput = z.infer<typeof LeaveEmployeeBody>;

export const RehireEmployeeBody = z.object({
  hiredOn: employeeDate,
  primaryDepartmentId: optionalReference,
  positionId: optionalReference,
  gradeId: optionalReference,
  reportsToUserId: optionalReference,
});

export type RehireEmployeeInput = z.infer<typeof RehireEmployeeBody>;

export const EmployeeListRowSchema = z.object({
  userId: z.string(),
  employeeNo: z.string(),
  name: z.string().nullable(),
  username: z.string().nullable(),
  primaryDepartmentName: z.string().nullable(),
  positionName: z.string().nullable(),
  gradeName: z.string().nullable(),
  status: z.enum(['active', 'left']),
  hiredOn: z.string(),
});

export const EmployeeDetailSchema = EmployeeListRowSchema.extend({
  secondaryDepartmentNames: z.array(z.string()),
  reportsToName: z.string().nullable(),
  leftOn: z.string().nullable(),
});

export const EmployeeChangeSchema = z.object({
  kind: z.enum(['hired', 'left', 'rehired', 'position', 'grade', 'reportsTo']),
  fromValue: z.string().nullable(),
  toValue: z.string().nullable(),
  occurredOn: z.string(),
  note: z.string().nullable(),
  actorName: z.string().nullable(),
  createdAt: z.string(),
});

export const EmployeeCandidateSchema = z.object({
  userId: z.string(),
  name: z.string().nullable(),
  username: z.string().nullable(),
  employeeNo: z.string(),
  primaryDepartmentName: z.string().nullable(),
});

export const PositionSchema = z.object({
  id: z.string(),
  title: z.string(),
  active: z.boolean(),
  sortOrder: z.number(),
});

export const JobGradeSchema = z.object({
  id: z.string(),
  title: z.string(),
  rank: z.number(),
  active: z.boolean(),
});

export const CreatePositionBody = z.object({
  id: z.string().trim().min(1).max(64),
  title: z.string().trim().min(1).max(128),
  sortOrder: z.number().int().min(-2147483648).max(2147483647).optional(),
});

export const UpdatePositionBody = z.object({
  title: z.string().trim().min(1).max(128).optional(),
  sortOrder: z.number().int().min(-2147483648).max(2147483647).optional(),
  active: z.boolean().optional(),
});

export const CreateJobGradeBody = z.object({
  id: z.string().trim().min(1).max(32),
  title: z.string().trim().min(1).max(128),
  rank: z.number().int().min(-2147483648).max(2147483647).optional(),
});

export const UpdateJobGradeBody = z.object({
  title: z.string().trim().min(1).max(128).optional(),
  rank: z.number().int().min(-2147483648).max(2147483647).optional(),
  active: z.boolean().optional(),
});
