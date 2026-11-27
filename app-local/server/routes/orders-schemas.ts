import { z } from 'zod';

/**
 * R-021/R-022 端点的 zod schema，放在独立文件里（照 inventory-schemas.ts），
 * 不与共享 schemas.ts 撞车。
 *
 * 业务规则（数量为正、明细非空、引用有效、剩余数量）一律留在服务层，
 * 这里只挡类型与长度：否则无授权者会先拿到 400，违反「先授权后读内容」，
 * 也拿不到 422 的规则码。
 */
const page = z.coerce.number().int().min(1).default(1);
const pageSize = z.coerce.number().int().min(1).max(100).default(20);
const isoDate = z.string().datetime({ offset: true });
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u);
const id = z.string().min(1).max(64);
const remark = z.string().max(1000);

const purchaseStatus = z.enum([
  'draft', 'ordered', 'partially_received', 'received', 'cancelled',
]);
const salesStatus = z.enum([
  'draft', 'ordered', 'partially_shipped', 'shipped', 'cancelled',
]);

const lineInput = z.object({
  itemId: id,
  qty: z.number(),
  price: z.number().nullable().optional(),
});
const issueLineInput = z.object({ lineId: id, qty: z.number() });

const commonList = { q: z.string().min(1).max(128).optional(), from: isoDate.optional(), to: isoDate.optional(), page, pageSize } as const;

export const PurchaseOrderListQuery = z.object({
  ...commonList,
  status: purchaseStatus.optional(),
  supplierId: id.optional(),
});
export const SalesOrderListQuery = z.object({
  ...commonList,
  status: salesStatus.optional(),
  customerId: id.optional(),
});

export const CreatePurchaseOrderBody = z.object({
  supplierId: id,
  orderDate: day,
  remark: remark.optional(),
  lines: z.array(lineInput).default([]),
});
export const UpdatePurchaseOrderBody = z.object({
  supplierId: id.optional(),
  orderDate: day.optional(),
  remark: remark.optional(),
  lines: z.array(lineInput).optional(),
});
export const CreateSalesOrderBody = z.object({
  customerId: id,
  orderDate: day,
  remark: remark.optional(),
  lines: z.array(lineInput).default([]),
});
export const UpdateSalesOrderBody = z.object({
  customerId: id.optional(),
  orderDate: day.optional(),
  remark: remark.optional(),
  lines: z.array(lineInput).optional(),
});

/** 生成单据：body 至少给仓库；lines 省略即按剩余全量生成。 */
export const CreateReceiptBody = z.object({
  warehouseId: id,
  lines: z.array(issueLineInput).optional(),
});
export const CreateIssueBody = CreateReceiptBody;

const partnerSummary = z.object({
  id: z.string(),
  code: z.string(),
  name: z.string(),
  status: z.enum(['active', 'inactive']),
});
const orderLine = z.object({
  id: z.string(),
  orderId: z.string(),
  itemId: z.string(),
  qty: z.number(),
  price: z.number().nullable(),
  receivedQty: z.number().optional(),
  shippedQty: z.number().optional(),
  remainingQty: z.number(),
});
const commonOrder = {
  id: z.string(),
  orderNo: z.string(),
  orderDate: z.string(),
  remark: z.string(),
  submittedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
} as const;
const purchaseOrder = z.object({
  ...commonOrder,
  status: purchaseStatus,
  supplierId: z.string(),
  supplier: partnerSummary.nullable(),
  lines: z.array(orderLine),
});
const salesOrder = z.object({
  ...commonOrder,
  status: salesStatus,
  customerId: z.string(),
  customer: partnerSummary.nullable(),
  lines: z.array(orderLine),
});

const paged = <T extends z.ZodTypeAny>(item: T) =>
  z.object({
    items: z.array(item),
    total: z.number(),
    page: z.number(),
    pageSize: z.number(),
  });
export const PurchaseOrderSchemaOut = purchaseOrder;
export const SalesOrderSchemaOut = salesOrder;
export const PurchaseOrderListSchema = paged(
  purchaseOrder.omit({ lines: true, supplier: true }),
);
export const SalesOrderListSchema = paged(
  salesOrder.omit({ lines: true, customer: true }),
);
