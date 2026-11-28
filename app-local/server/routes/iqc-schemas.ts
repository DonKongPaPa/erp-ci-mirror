import { z } from 'zod';

import { FileIdsSchema } from './schemas.js';

/** R-070 端点的 zod schema：数量规则留在服务层，这里只挡类型与长度。 */
const page = z.coerce.number().int().min(1).default(1);
const pageSize = z.coerce.number().int().min(1).max(100).default(20);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u);
const id = z.string().min(1).max(64);
const status = z.enum(['pending', 'passed', 'partial', 'failed', 'void']);
const inspectionTypeCode = z.enum(['full', 'sampling', 'exempt']);

const lineInput = z.object({
  itemId: id,
  inspectionTypeCode,
  receivedQty: z.number(),
  inspectionQty: z.number(),
  qualifiedQty: z.number(),
  samplingQty: z.number(),
  samplingQualifiedQty: z.number(),
  lossQty: z.number().optional(),
  retainedQty: z.number().optional(),
  note: z.string().max(500).nullable().optional(),
});

export const InspectionListQuery = z.object({
  status: status.optional(),
  purchaseOrderId: id.optional(),
  supplierId: id.optional(),
  inspectorUserId: id.optional(),
  from: day.optional(),
  to: day.optional(),
  q: z.string().min(1).max(128).optional(),
  page,
  pageSize,
});
export const ReceivableQuery = z.object({
  purchaseOrderId: id.optional(),
  q: z.string().min(1).max(128).optional(),
  page,
  pageSize,
});
/** 页面片新增：新建检验单时选采购订单行的窄读查询，授权仍走 inspectionOrders.view。 */
export const OrderOptionsQuery = z.object({
  q: z.string().min(1).max(128).optional(),
  page,
  pageSize,
});
export const CreateInspectionBody = z.object({
  inspectionDate: day.nullable().optional(),
  purchaseOrderId: id,
  inspectorUserId: id.nullable().optional(),
  remark: z.string().max(1000).optional(),
  fileIds: FileIdsSchema,
  lines: z.array(lineInput).default([]),
});
export const UpdateInspectionBody = z.object({
  inspectionDate: day.nullable().optional(),
  inspectorUserId: id.nullable().optional(),
  remark: z.string().max(1000).optional(),
  fileIds: FileIdsSchema,
  lines: z.array(lineInput).optional(),
});
