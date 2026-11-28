import { z } from 'zod';

import { FileIdsSchema } from './schemas.js';

/**
 * R-020 端点的 zod schema。放在独立文件里（照 department-schemas.ts），
 * 避免和另一条分支往共享 schemas.ts 加物料 schema 时撞车。
 */

const page = z.coerce.number().int().min(1).default(1);
const pageSize = z.coerce.number().int().min(1).max(100).default(20);
const isoDate = z.string().datetime({ offset: true });
const switchBoolean = z
  .enum(['true', 'false'])
  .transform((value) => value === 'true');

const docType = z.enum(['in', 'out']);
const docStatus = z.enum(['draft', 'posted', 'void']);
const docReason = z.enum([
  'purchase_receipt', 'production_receipt', 'sales_return', 'other_in',
  'sales_issue', 'internal_use', 'purchase_return', 'other_out',
]);
const sourceType = z.enum(['purchase_order', 'sales_order']);
const warehouseStatus = z.enum(['active', 'inactive']);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u);
const headerExtras = {
  docDate: day.nullable().optional(),
  partnerId: z.string().min(1).max(64).nullable().optional(),
  contactName: z.string().max(128).nullable().optional(),
  contactPhone: z.string().max(64).nullable().optional(),
  deliveryAddress: z.string().max(512).nullable().optional(),
  customerOrderNo: z.string().max(64).nullable().optional(),
  projectCode: z.string().max(32).nullable().optional(),
  handlerUserId: z.string().min(1).max(64).nullable().optional(),
  takerDepartmentId: z.string().min(1).max(64).nullable().optional(),
  takerUserId: z.string().min(1).max(64).nullable().optional(),
  discountAmount: z.number().optional(),
  fileIds: FileIdsSchema,
  // R-070：可选挂点。不带这个键的建单请求逐字节照旧。
  inspectionId: z.string().min(1).max(64).optional(),
} as const;

export const WarehouseListQuery = z.object({
  status: warehouseStatus.optional(),
  q: z.string().min(1).max(128).optional(),
  page,
  pageSize,
});

export const CreateWarehouseBody = z.object({
  code: z.string().min(1).max(32),
  name: z.string().min(1).max(128),
  status: warehouseStatus.optional(),
  note: z.string().max(500).optional(),
});

/** passthrough：路由要先看见 `code` 这个不可改的键再拒绝它，不能让 zod 静默剥掉。 */
export const UpdateWarehouseBody = z
  .object({
    name: z.string().min(1).max(128).optional(),
    status: warehouseStatus.optional(),
    note: z.string().max(500).optional(),
  })
  .passthrough();

/**
 * 数量与明细的**业务规则**留在服务层（422 STOCK_LINE_INVALID），不写成 zod 的
 * positive()/min(1)：那样会在授权之前先回 400，既违反「先授权后读内容」，也拿不到规则码。
 * 这里只挡类型与长度；缺明细按空数组交给服务判定。
 */
export const StockLineBody = z.object({
  itemId: z.string().min(1).max(64),
  warehouseId: z.string().min(1).max(64),
  batchNo: z.string().max(64).optional(),
  qty: z.number(),
  // R-070：只对带 inspectionId 的采购入库生效，服务端校验后不落明细列。
  inspectionLineId: z.string().min(1).max(64).optional(),
  taxIncludedPrice: z.number().nullable().optional(),
  taxExcludedPrice: z.number().nullable().optional(),
  taxRate: z.number().nullable().optional(),
  productionDate: day.nullable().optional(),
  expiryDate: day.nullable().optional(),
  note: z.string().max(500).nullable().optional(),
});

export const CreateStockDocBody = z.object({
  docType,
  reason: docReason,
  remark: z.string().max(1000).optional(),
  sourceType: sourceType.optional(),
  sourceId: z.string().min(1).max(64).optional(),
  ...headerExtras,
  lines: z.array(StockLineBody).default([]),
});

export const UpdateStockDocBody = z.object({
  reason: docReason.optional(),
  remark: z.string().max(1000).optional(),
  sourceType: sourceType.optional(),
  sourceId: z.string().min(1).max(64).optional(),
  ...headerExtras,
  lines: z.array(StockLineBody).default([]),
});

export const DocListQuery = z.object({
  docType: docType.optional(),
  status: docStatus.optional(),
  reason: docReason.optional(),
  partnerId: z.string().min(1).max(64).optional(),
  projectCode: z.string().max(32).optional(),
  handlerUserId: z.string().min(1).max(64).optional(),
  takerDepartmentId: z.string().min(1).max(64).optional(),
  stocktakingId: z.string().min(1).max(64).optional(),
  transferDocId: z.string().min(1).max(64).optional(),
  dateField: z.literal('docDate').optional(),
  q: z.string().min(1).max(128).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  page,
  pageSize,
  includeVoid: switchBoolean.optional(),
});

export const BalanceListQuery = z.object({
  itemId: z.string().min(1).max(64).optional(),
  warehouseId: z.string().min(1).max(64).optional(),
  q: z.string().min(1).max(64).optional(),
  page,
  pageSize,
});

export const TransactionListQuery = z.object({
  itemId: z.string().min(1).max(64).optional(),
  warehouseId: z.string().min(1).max(64).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  page,
  pageSize,
});

const WarehouseSchema = z.object({
  id: z.string(),
  code: z.string(),
  name: z.string(),
  status: warehouseStatus,
  note: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const StockDocLineSchema = z.object({
  id: z.string(),
  docId: z.string(),
  itemId: z.string(),
  warehouseId: z.string(),
  batchNo: z.string(),
  qty: z.number(),
  productionDate: z.string().nullable().optional(),
  expiryDate: z.string().nullable().optional(),
  note: z.string().nullable().optional(),
  taxRate: z.number().nullable().optional(),
  taxIncludedPrice: z.number().nullable().optional(),
  taxExcludedPrice: z.number().nullable().optional(),
  taxExcludedAmount: z.number().nullable().optional(),
  taxAmount: z.number().nullable().optional(),
  taxIncludedAmount: z.number().nullable().optional(),
});

const StockDocSchema = z.object({
  id: z.string(),
  docNo: z.string(),
  docType,
  reason: docReason,
  status: docStatus,
  remark: z.string(),
  sourceType: sourceType.nullable(),
  sourceId: z.string().nullable(),
  createdById: z.string(),
  postedAt: z.string().nullable(),
  postedById: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  docDate: z.string().nullable().optional(),
  partnerId: z.string().nullable().optional(),
  contactName: z.string().nullable().optional(),
  contactPhone: z.string().nullable().optional(),
  deliveryAddress: z.string().nullable().optional(),
  customerOrderNo: z.string().nullable().optional(),
  projectCode: z.string().nullable().optional(),
  handlerUserId: z.string().nullable().optional(),
  handler: z.object({ userId: z.string(), name: z.string() }).nullable().optional(),
  takerDepartmentId: z.string().nullable().optional(),
  takerUserId: z.string().nullable().optional(),
  taker: z.object({ userId: z.string(), name: z.string() }).nullable().optional(),
  takerDepartment: z.object({ id: z.string(), name: z.string() }).nullable().optional(),
  partner: z.object({ id: z.string(), code: z.string(), name: z.string() }).nullable().optional(),
  totalQty: z.number().nullable().optional(),
  stocktakingId: z.string().optional(),
  transferDocId: z.string().optional(),
  discountAmount: z.number().optional(),
  taxIncludedTotal: z.number().nullable().optional(),
  taxExcludedTotal: z.number().nullable().optional(),
  taxTotal: z.number().nullable().optional(),
  payableTotal: z.number().nullable().optional(),
  files: z.array(z.object({
    id: z.string(), name: z.string(), contentType: z.string(), size: z.number(),
  })).optional(),
  lines: z.array(StockDocLineSchema),
});

const BalanceSchema = z.object({
  itemId: z.string(),
  warehouseId: z.string(),
  batchNo: z.string(),
  qty: z.number(),
});

const TransactionSchema = z.object({
  id: z.string(),
  docId: z.string(),
  docLineId: z.string(),
  docNo: z.string(),
  itemId: z.string(),
  warehouseId: z.string(),
  batchNo: z.string(),
  qtyDelta: z.number(),
  balanceAfter: z.number(),
  at: z.string(),
  byUserId: z.string(),
});

const paged = <T extends z.ZodTypeAny>(item: T) =>
  z.object({
    items: z.array(item),
    total: z.number(),
    page: z.number(),
    pageSize: z.number(),
  });

export const WarehouseListSchema = paged(WarehouseSchema);
export const StockDocSchemaOut = StockDocSchema;
export const StockDocListSchema = paged(StockDocSchema.omit({ lines: true }));
export const BalanceListSchema = paged(BalanceSchema);
export const TransactionListSchema = paged(TransactionSchema);
