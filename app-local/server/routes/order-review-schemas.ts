import { z } from 'zod';

/** R-064 的请求与响应形状。Zod 只校验输入；响应由服务逐列拼好，不回多余列。 */
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u);
const id = z.string().min(1).max(64);
const page = z.coerce.number().int().min(1).default(1);
const pageSize = z.coerce.number().int().min(1).max(100).default(20);

export const ReviewStatus = z.enum(['draft', 'submitted', 'confirmed', 'void']);
export const Factor = z.enum(['man', 'machine', 'material', 'method', 'environment']);
export const ReviewLineInput = z.object({
  factor: Factor,
  // 五项齐不齐、结论空不空由服务层按 REVIEW_FACTORS_INCOMPLETE（422）判，先交给授权之后。
  conclusion: z.string().max(500),
  note: z.string().max(1000).optional(),
});

export const ReviewListQuery = z.object({
  salesOrderId: id.optional(),
  status: ReviewStatus.optional(),
  reviewerUserId: id.optional(),
  from: z.string().min(1).max(40).optional(),
  to: z.string().min(1).max(40).optional(),
  page,
  pageSize,
});

export const CreateReviewBody = z.object({
  salesOrderId: id,
  reviewerUserId: id,
  lines: z.array(ReviewLineInput).max(5),
});

/** passthrough 才能看见空补丁；至少一项由 refine 拒绝，不靠服务层猜。 */
export const UpdateReviewBody = z.object({
  reviewerUserId: id.optional(),
  lines: z.array(ReviewLineInput).max(5).optional(),
}).passthrough().refine(
  (body) => Object.keys(body).some((key) => key === 'reviewerUserId' || key === 'lines'),
  { message: 'At least one field is required.' },
);

export const ConfirmDeliveryBody = z.object({
  confirmedDeliveryDate: day,
});

export const LedgerListQuery = z.object({
  q: z.string().min(1).max(128).optional(),
  customerId: id.optional(),
  projectCode: z.string().min(1).max(32).optional(),
  reviewStatus: z.enum(['pending', 'done']).optional(),
  overdue: z.enum(['true', 'false']).transform((value) => value === 'true').optional(),
  days: z.coerce.number().int().min(0).max(365).default(7),
  status: z.string().min(1).max(32).optional(),
  page,
  pageSize,
});

export const ReminderListQuery = z.object({
  scope: z.enum(['overdue', 'upcoming']).default('overdue'),
  days: z.coerce.number().int().min(0).max(365).default(7),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

const PersonRef = z.object({ userId: z.string(), name: z.string() });
const CustomerRef = z.object({ id: z.string(), code: z.string(), name: z.string() });
const ReviewLine = z.object({
  id: z.string(), factor: Factor, conclusion: z.string(), note: z.string().nullable(),
});
const OrderReview = z.object({
  id: z.string(), salesOrderId: z.string(), status: ReviewStatus,
  reviewer: PersonRef,
  reviewedAt: z.string(),
  confirmedDeliveryDate: z.string().nullable(),
  confirmedAt: z.string().nullable(),
  createdAt: z.string(), updatedAt: z.string(),
  lines: z.array(ReviewLine).optional(),
  salesOrder: z.object({
    id: z.string(), orderNo: z.string(), orderDate: z.string(), status: z.string(),
  }).nullable().optional(),
});
const LedgerSegment = z.object({
  status: z.string().nullable(), qty: z.number().nullable(), total: z.number().nullable(),
});
const LedgerRow = z.object({
  salesOrderId: z.string(), orderNo: z.string(), orderDate: z.string(), status: z.string(),
  customer: CustomerRef.nullable(),
  projectCode: z.string().nullable(), projectLabel: z.string().nullable(),
  handler: PersonRef.nullable(),
  baselineDate: z.string().nullable(),
  review: LedgerSegment.extend({
    confirmedDeliveryDate: z.string().nullable(), reviewer: PersonRef.nullable(),
  }),
  purchase: LedgerSegment, production: LedgerSegment, receipt: LedgerSegment,
  shipping: LedgerSegment, payment: LedgerSegment,
  overdue: z.boolean(), overdueDays: z.number().nullable(), upcoming: z.boolean(),
});
const ReminderRow = z.object({
  salesOrderId: z.string(), orderNo: z.string(), customer: CustomerRef.nullable(),
  baselineDate: z.string(), overdueDays: z.number(), scope: z.enum(['overdue', 'upcoming']),
});

const paged = <T extends z.ZodTypeAny>(item: T) =>
  z.object({
    items: z.array(item), total: z.number(), page: z.number(), pageSize: z.number(),
  });

export const ReviewListSchema = paged(OrderReview);
export const OrderReviewSchema = OrderReview;
export const LedgerListSchema = paged(LedgerRow);
export const ReminderListSchema = z.object({
  items: z.array(ReminderRow), total: z.number(),
});
