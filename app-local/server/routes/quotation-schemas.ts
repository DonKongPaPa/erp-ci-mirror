import { z } from 'zod';

import { FileIdsSchema } from './schemas.js';

/**
 * R-022 复刻波 1 端点的 zod schema。只挡形状与长度；业务规则（有效期、优惠、明细、
 * 引用有效性）留在服务层，无授权者先拿 403。六个合计不在输入 schema 里，带了会被剥掉。
 */
const page = z.coerce.number().int().min(1).default(1);
const pageSize = z.coerce.number().int().min(1).max(100).default(20);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u);
const id = z.string().min(1).max(64);

const status = z.enum(['draft', 'confirmed', 'converted', 'void']);

const lineInput = z.object({
  itemId: id,
  qty: z.number(),
  price: z.number().nullable().optional(),
  taxExcludedPrice: z.number().nullable().optional(),
  taxRate: z.number().nullable().optional(),
  deliveryDate: day.nullable().optional(),
  note: z.string().max(500).nullable().optional(),
});

const headerInput = {
  quoteDate: day.optional(),
  validUntil: day.nullable().optional(),
  warehouseId: id.nullable().optional(),
  customerId: id.nullable().optional(),
  contactName: z.string().max(128).nullable().optional(),
  contactPhone: z.string().max(64).nullable().optional(),
  deliveryAddress: z.string().max(512).nullable().optional(),
  projectCode: id.nullable().optional(),
  settlementCode: id.nullable().optional(),
  customerOrderNo: z.string().max(64).nullable().optional(),
  handlerUserId: id.nullable().optional(),
  discountAmount: z.number().optional(),
  fileIds: FileIdsSchema,
} as const;

export const QuotationListQuery = z.object({
  customerId: id.optional(),
  projectCode: id.optional(),
  status: status.optional(),
  validFrom: day.optional(),
  validTo: day.optional(),
  q: z.string().min(1).max(128).optional(),
  page,
  pageSize,
});

export const CreateQuotationBody = z.object({
  ...headerInput,
  lines: z.array(lineInput).default([]),
});
export const UpdateQuotationBody = z.object({
  ...headerInput,
  lines: z.array(lineInput).optional(),
});

const itemSummary = z.object({
  id: z.string(), code: z.string(), name: z.string(),
  spec: z.string().nullable(), unitCode: z.string(),
});
const quotationLine = z.object({
  id: z.string(),
  quotationId: z.string(),
  itemId: z.string(),
  qty: z.number(),
  price: z.number().nullable(),
  deliveryDate: z.string().nullable(),
  taxRate: z.number().nullable(),
  taxExcludedPrice: z.number().nullable(),
  taxExcludedAmount: z.number().nullable(),
  taxAmount: z.number().nullable(),
  taxIncludedAmount: z.number().nullable(),
  note: z.string().nullable(),
  item: itemSummary,
});
const person = z.object({ userId: z.string(), name: z.string() });
const partner = z.object({ id: z.string(), code: z.string(), name: z.string() });
const warehouse = z.object({ id: z.string(), name: z.string() });
const file = z.object({ id: z.string(), name: z.string(), contentType: z.string(), size: z.number() });

const quotation = z.object({
  id: z.string(),
  docNo: z.string(),
  quoteDate: z.string(),
  validUntil: z.string().nullable(),
  status,
  expired: z.boolean(),
  warehouse: warehouse.nullable(),
  customer: partner.nullable(),
  contactName: z.string().nullable(),
  contactPhone: z.string().nullable(),
  deliveryAddress: z.string().nullable(),
  projectCode: z.string().nullable(),
  projectLabel: z.string().nullable(),
  settlementCode: z.string().nullable(),
  settlementLabel: z.string().nullable(),
  customerOrderNo: z.string().nullable(),
  handler: person.nullable(),
  discountAmount: z.number(),
  totalQty: z.number().nullable(),
  taxIncludedTotal: z.number().nullable(),
  taxExcludedTotal: z.number().nullable(),
  taxTotal: z.number().nullable(),
  payableTotal: z.number().nullable(),
  convertedOrderId: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const QuotationSchemaOut = quotation.extend({
  lines: z.array(quotationLine),
  files: z.array(file),
});
export const QuotationListSchema = z.object({
  items: z.array(quotation),
  total: z.number(),
  page: z.number(),
  pageSize: z.number(),
});
export const ConvertResultSchema = z.object({
  quotation: QuotationSchemaOut,
  salesOrderId: z.string(),
});
