import { z } from 'zod';

/** R-066：请款单与报销单端点的请求/响应形状。Zod 只守形状，业务规则由服务层守。 */
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u);
const id = z.string().min(1).max(64);
const page = z.coerce.number().int().min(1).default(1);
const pageSize = z.coerce.number().int().min(1).max(100).default(20);

export const RequestDocType = z.enum(['payment_request', 'expense_claim']);
export const RequestStatus = z.enum([
  'draft', 'approving', 'approved', 'rejected', 'void', 'converted',
]);
export const RequestIdParam = z.object({ id });

export const RequestListQuery = z.object({
  docType: RequestDocType.optional(),
  status: RequestStatus.optional(),
  expenseTypeCode: z.string().min(1).max(32).optional(),
  projectCode: z.string().min(1).max(32).optional(),
  from: z.string().min(1).max(40).optional(),
  to: z.string().min(1).max(40).optional(),
  mine: z.enum(['true', 'false']).transform((value) => value === 'true').optional(),
  page,
  pageSize,
});

export const CreateFinanceRequestBody = z.object({
  docType: RequestDocType,
  requestDate: day.optional(),
  expenseTypeCode: z.string().min(1).max(32).optional(),
  amount: z.number(),
  reason: z.string().max(1000).optional(),
  handlerUserId: id.optional(),
  projectCode: z.string().min(1).max(32).optional(),
  fileIds: z.array(id).max(10).optional(),
});

/** 至少一项；空补丁由 zod 先挡，服务层再守一次状态。 */
export const UpdateFinanceRequestBody = z.object({
  requestDate: day.optional(),
  expenseTypeCode: z.string().min(1).max(32).nullable().optional(),
  amount: z.number().optional(),
  reason: z.string().max(1000).optional(),
  handlerUserId: id.optional(),
  projectCode: z.string().min(1).max(32).nullable().optional(),
  fileIds: z.array(id).max(10).optional(),
}).refine((body) => Object.keys(body).length > 0, {
  message: 'At least one field is required.',
});

const FileView = z.object({
  id: z.string(), name: z.string(), contentType: z.string(), size: z.number(),
});
const PersonRef = z.object({ userId: z.string(), name: z.string() });

export const FinanceRequestSchema = z.object({
  id: z.string(), docType: RequestDocType, docNo: z.string(), requestDate: z.string(),
  status: RequestStatus,
  expenseTypeCode: z.string().nullable(), expenseTypeLabel: z.string().nullable(),
  amount: z.number(), reason: z.string(),
  handler: PersonRef,
  projectCode: z.string().nullable(), projectLabel: z.string().nullable(),
  approvalId: z.string().nullable(), expenseRecordId: z.string().nullable(),
  createdAt: z.string(), updatedAt: z.string(),
  files: z.array(FileView),
});

/** 列表行不带附件。 */
export const FinanceRequestSummarySchema = FinanceRequestSchema.omit({ files: true });
export const FinanceRequestListSchema = z.object({
  items: z.array(FinanceRequestSummarySchema),
  total: z.number(), page: z.number(), pageSize: z.number(),
});
export const ConvertedSchema = z.object({
  request: FinanceRequestSchema,
  expenseRecordId: z.string(),
});
