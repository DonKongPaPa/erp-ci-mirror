import { z } from 'zod';

/** R-076 打印端点的 zod schema。docType 的取值在路由里判（非法值回 404 规则码，不是 400）。 */

/** 三条只读路由的 docType 写死在路径里，param 只有 docNo；痕迹路由两者都有。 */
export const PrintDocParam = z.object({
  docType: z.string().min(1).max(32).optional(),
  docNo: z.string().min(1).max(64),
});

const price = z.number().nullable().optional();
const approval = z.object({
  approver: z.literal(''),
  approvedAt: z.literal(''),
  approvalStatus: z.literal(''),
  approvalFlow: z.literal(''),
});

export const PrintLineSchema = z.object({
  seq: z.number(),
  itemCode: z.string(),
  itemName: z.string(),
  spec: z.string().nullable(),
  unit: z.string(),
  qty: z.number(),
  batchNo: z.string(),
  productionDate: z.string().nullable(),
  expiryDate: z.string().nullable(),
  note: z.string().nullable(),
  taxIncludedPrice: price,
  taxExcludedPrice: price,
  taxRate: price,
  taxAmount: price,
  taxIncludedAmount: price,
  amount: price,
});

export const PrintDataSchema = z.object({
  docType: z.string(),
  docNo: z.string(),
  docDate: z.string().nullable(),
  status: z.string(),
  header: z.object({
    warehouseName: z.string(),
    partnerName: z.string(),
    contactName: z.string(),
    deliveryAddress: z.string(),
    customerOrderNo: z.string(),
    projectName: z.string(),
    handlerName: z.string(),
    takerDepartmentName: z.string(),
    takerName: z.string(),
    remark: z.string(),
  }),
  lines: z.array(PrintLineSchema),
  party: z.object({ name: z.string(), contactName: z.string(), phone: z.string() }),
  totals: z.object({
    totalQty: z.number().nullable(),
    payableTotal: price,
    taxIncludedTotal: price,
    taxExcludedTotal: price,
    taxTotal: price,
    discountAmount: price,
  }),
  amountInWords: z.string().optional(),
  preparedBy: z.object({ id: z.string(), name: z.string() }),
  printedAt: z.string(),
  approval,
  printCount: z.number(),
});

export const PrintMarkSchema = z.object({
  docNo: z.string(),
  printCount: z.number(),
  lastPrintedAt: z.string(),
  lastPrintedBy: z.string(),
});
