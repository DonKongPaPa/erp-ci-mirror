import { z } from 'zod';

/** R-021 波 1 加片：请购单端点的请求与响应形状。Zod 只守形状，业务规则由服务层守。 */
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u);
const id = z.string().min(1).max(64);
const page = z.coerce.number().int().min(1).default(1);
const pageSize = z.coerce.number().int().min(1).max(100).default(20);

export const RequestStatus = z.enum([
  'draft', 'approving', 'approved', 'rejected', 'void', 'converted',
]);
export const RequestIdParam = z.object({ id });

export const RequestListQuery = z.object({
  departmentId: id.optional(),
  requesterUserId: id.optional(),
  projectCode: z.string().min(1).max(32).optional(),
  status: RequestStatus.optional(),
  from: z.string().min(1).max(40).optional(),
  to: z.string().min(1).max(40).optional(),
  mine: z.enum(['true', 'false']).transform((value) => value === 'true').optional(),
  page,
  pageSize,
});

export const LineInput = z.object({
  itemId: id,
  qty: z.number().positive(),
  expectedPrice: z.number().nonnegative().nullable().optional(),
});

export const CreateRequestHeaderBody = z.object({
  requestDate: day.optional(),
  departmentId: id,
  requesterUserId: id.optional(),
  projectCode: z.string().min(1).max(32).optional(),
  customText1: z.string().max(255).optional(),
  customText2: z.string().max(255).optional(),
  description: z.string().max(2000).optional(),
  fileIds: z.array(id).max(10).optional(),
});

/** 至少一项；空补丁由 zod 先挡，服务层再守一次。 */
export const UpdateRequestHeaderBody = z.object({
  requestDate: day.optional(),
  departmentId: id.optional(),
  requesterUserId: id.optional(),
  projectCode: z.string().min(1).max(32).nullable().optional(),
  customText1: z.string().max(255).nullable().optional(),
  customText2: z.string().max(255).nullable().optional(),
  description: z.string().max(2000).optional(),
  fileIds: z.array(id).max(10).optional(),
}).refine(
  (body) => Object.keys(body).length > 0,
  { message: 'At least one field is required.' },
);

export const SetLinesBody = z.object({
  lines: z.array(LineInput).min(1),
  replace: z.boolean().optional(),
});

const ItemSummary = z.object({
  id: z.string(), code: z.string(), name: z.string(),
  spec: z.string().nullable(), unitCode: z.string(),
});
const RequestLine = z.object({
  id: z.string(), itemId: z.string(), qty: z.number(),
  expectedPrice: z.number().nullable(), expectedAmount: z.number().nullable(),
  item: ItemSummary,
});
const FileView = z.object({
  id: z.string(), name: z.string(), contentType: z.string(), size: z.number(),
});
const PersonRef = z.object({ userId: z.string(), name: z.string() });
const DepartmentRef = z.object({ id: z.string(), name: z.string() });

export const PurchaseRequestSchema = z.object({
  id: z.string(), docNo: z.string(), requestDate: z.string(), status: RequestStatus,
  department: DepartmentRef, requester: PersonRef,
  projectCode: z.string().nullable(), projectLabel: z.string().nullable(),
  customText1: z.string().nullable(), customText2: z.string().nullable(),
  description: z.string(),
  approvalId: z.string().nullable(), convertedOrderId: z.string().nullable(),
  totalQty: z.number().nullable(), estimatedTotal: z.number().nullable(),
  createdAt: z.string(), updatedAt: z.string(),
  lines: z.array(RequestLine),
  files: z.array(FileView),
});

/** 列表行不带明细与附件。 */
export const PurchaseRequestSummarySchema = PurchaseRequestSchema.omit({
  lines: true, files: true,
});
export const PurchaseRequestListSchema = z.object({
  items: z.array(PurchaseRequestSummarySchema),
  total: z.number(), page: z.number(), pageSize: z.number(),
});
export const ConvertedOrderSchema = z.object({
  request: PurchaseRequestSchema,
  purchaseOrderId: z.string(),
});
