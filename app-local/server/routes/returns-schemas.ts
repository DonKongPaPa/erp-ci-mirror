import { z } from 'zod';

const page = z.coerce.number().int().min(1).default(1);
const pageSize = z.coerce.number().int().min(1).max(100).default(20);
const isoDate = z.string().datetime({ offset: true });
const id = z.string().min(1).max(64);
const status = z.enum(['draft', 'posted', 'void']);
const returnLine = z.object({
  sourceLineId: id,
  returnQty: z.number().positive(),
  warehouseId: id.optional(),
  note: z.string().max(500).nullable().optional(),
});
const fileIds = z.array(z.string().min(1).max(128)).max(20).optional();

export const ReturnListQuery = z.object({
  status: status.optional(),
  partnerId: id.optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  q: z.string().min(1).max(128).optional(),
  page,
  pageSize,
});
export const SourceOptionQuery = z.object({
  partnerId: id.optional(),
  q: z.string().min(1).max(128).optional(),
  page,
  pageSize,
});
export const FinanceOptionQuery = z.object({
  customerId: id.optional(),
  q: z.string().min(1).max(128).optional(),
  page,
  pageSize,
});
export const CreateReturnBody = z.object({
  sourceType: z.enum(['stock_doc', 'order']),
  sourceId: id,
  handlerUserId: id.nullable().optional(),
  remark: z.string().max(1000).optional(),
  fileIds,
  lines: z.array(returnLine).max(200),
});
export const UpdateReturnBody = z.object({
  handlerUserId: id.nullable().optional(),
  remark: z.string().max(1000).optional(),
  fileIds,
  lines: z.array(returnLine).max(200).optional(),
});
/** 页面片：作废原因必填，老客户端不带 body 时仍可照旧作废。 */
export const VoidReturnBody = z.object({ reason: z.string().min(1).max(500).optional() });

const ref = z.object({ id: z.string(), name: z.string() });
const person = z.object({ userId: z.string(), name: z.string() });
const partner = z.object({ id: z.string(), code: z.string(), name: z.string() });
const item = z.object({
  id: z.string(), code: z.string(), name: z.string(),
  spec: z.string().nullable(), unitCode: z.string(),
});
const line = z.object({
  id: z.string(), sourceLineId: z.string().nullable(), itemId: z.string(),
  warehouseId: z.string(), batchNo: z.string(), qty: z.number(),
  returnQty: z.number(), remainQty: z.number(), note: z.string().nullable(), item,
});
const file = z.object({
  id: z.string(), name: z.string(), contentType: z.string(), size: z.number(),
});
export const ReturnSchema = z.object({
  id: z.string(), docNo: z.string(), docType: z.enum(['purchase', 'sales']),
  sourceType: z.enum(['stock_doc', 'order']), sourceId: z.string(), status,
  partner: partner.nullable(), handler: person.nullable(), warehouse: ref.nullable(),
  remark: z.string(), createdAt: z.string(), updatedAt: z.string(),
  lines: z.array(line), files: z.array(file),
});
export const ReturnListSchema = z.object({
  items: z.array(ReturnSchema), total: z.number(), page: z.number(), pageSize: z.number(),
});
export const SourceOptionSchema = z.object({
  id: z.string(), docNo: z.string(), docDate: z.string().nullable(),
  partner: partner.nullable(),
  lines: z.array(z.object({
    sourceLineId: z.string(), itemId: z.string(), warehouseId: z.string(),
    batchNo: z.string(), remainQty: z.number(),
  })),
});
export const SourceOptionListSchema = z.object({
  items: z.array(SourceOptionSchema), total: z.number(), page: z.number(), pageSize: z.number(),
});
export const FinanceOptionSchema = z.object({
  id: z.string(), docNo: z.string(), returnDate: z.string().nullable(), status,
  customerId: z.string().nullable(),
  lines: z.array(z.object({ itemId: z.string(), qty: z.number() })),
});
export const FinanceOptionListSchema = z.object({
  items: z.array(FinanceOptionSchema), total: z.number(), page: z.number(), pageSize: z.number(),
});
export const PostResultSchema = z.object({
  returnDoc: ReturnSchema, stockDocId: z.string(),
});
