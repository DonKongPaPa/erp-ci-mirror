import { z } from 'zod';

/** R-065 复刻波 2：收入、开票、两张对账单与销售窄读共用的 zod schema。 */
const page = z.coerce.number().int().min(1).default(1);
const pageSize = z.coerce.number().int().min(1).max(100).default(20);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u);
const id = z.string().min(1).max(64);
const code = z.string().min(1).max(32);
const money = z.number();
const status = z.enum(['draft', 'confirmed', 'void']);
const bindMode = z.enum(['sales_order', 'receivable_recon', 'payable_recon', 'none']);
const fileIds = z.array(z.string().min(1).max(64)).optional();

const docLine = z.object({
  salesOrderId: id.optional(), receivableReconId: id.optional(),
  amount: money, note: z.string().max(500).optional(),
});

const docBody = {
  customerId: id.nullable().optional(),
  handlerUserId: id.nullable().optional(),
  projectCode: code.nullable().optional(),
  remark: z.string().max(1000).optional(),
  fileIds, amount: money.optional(), lines: z.array(docLine).optional(),
  confirm: z.boolean().optional(),
};

export const CreateIncomeBody = z.object({
  incomeDate: day, bindMode,
  incomeTypeCode: code.nullable().optional(), fundAccountCode: code.nullable().optional(),
  payerName: z.string().max(128).nullable().optional(),
  ...docBody,
});
export const UpdateIncomeBody = z.object({
  incomeDate: day.optional(),
  incomeTypeCode: code.nullable().optional(), fundAccountCode: code.nullable().optional(),
  payerName: z.string().max(128).nullable().optional(),
  ...docBody,
});
export const CreateSaleInvoiceBody = z.object({
  invoiceDate: day, bindMode,
  invoiceTypeCode: code.nullable().optional(),
  invoiceToName: z.string().max(128).nullable().optional(),
  invoiceNo: z.string().max(64).nullable().optional(),
  ...docBody,
});
export const UpdateSaleInvoiceBody = z.object({
  invoiceDate: day.optional(),
  invoiceTypeCode: code.nullable().optional(),
  invoiceToName: z.string().max(128).nullable().optional(),
  invoiceNo: z.string().max(64).nullable().optional(),
  ...docBody,
});

export const DocListQuery = z.object({
  status: status.optional(), customerId: id.optional(), bindMode: bindMode.optional(),
  typeCode: code.optional(), from: day.optional(), to: day.optional(),
  projectCode: code.optional(), q: z.string().min(1).max(128).optional(),
  page, pageSize,
});

const reconBody = {
  expectedPayDate: day.nullable().optional(),
  periodAmount: money,
  contactName: z.string().max(128).nullable().optional(),
  phone: z.string().max(64).nullable().optional(),
  handlerUserId: id.nullable().optional(),
  projectCode: code.nullable().optional(),
  remark: z.string().max(1000).optional(),
  fileIds,
  outStockDocIds: z.array(id).optional(),
  returnDocIds: z.array(id).optional(),
  purchaseStockDocIds: z.array(id).optional(),
};
export const CreateReceivableReconBody = z.object({
  reconDate: day, customerId: id, ...reconBody,
});
export const UpdateReceivableReconBody = z.object({
  reconDate: day.optional(), customerId: id.optional(),
  expectedPayDate: day.nullable().optional(), periodAmount: money.optional(),
  contactName: z.string().max(128).nullable().optional(),
  phone: z.string().max(64).nullable().optional(),
  handlerUserId: id.nullable().optional(), projectCode: code.nullable().optional(),
  remark: z.string().max(1000).optional(), fileIds,
  outStockDocIds: z.array(id).optional(), returnDocIds: z.array(id).optional(),
});
export const CreatePayableReconBody = z.object({
  reconDate: day, supplierId: id, invoiceTypeCode: code.nullable().optional(), ...reconBody,
});
export const UpdatePayableReconBody = z.object({
  reconDate: day.optional(), supplierId: id.optional(), invoiceTypeCode: code.nullable().optional(),
  expectedPayDate: day.nullable().optional(), periodAmount: money.optional(),
  contactName: z.string().max(128).nullable().optional(),
  phone: z.string().max(64).nullable().optional(),
  handlerUserId: id.nullable().optional(), projectCode: code.nullable().optional(),
  remark: z.string().max(1000).optional(), fileIds,
  purchaseStockDocIds: z.array(id).optional(),
});

export const ReconListQuery = z.object({
  status: status.optional(),
  customerId: id.optional(), supplierId: id.optional(), invoiceTypeCode: code.optional(),
  from: day.optional(), to: day.optional(), q: z.string().min(1).max(128).optional(),
  page, pageSize,
});
export const ReceivableListQuery = z.object({
  customerId: id.optional(), status: z.string().optional(),
  q: z.string().min(1).max(128).optional(), page, pageSize,
});
/** 下拉把空关键词原样发成 `?q=`；空串等价于不传。 */
const optionQuery = z.string().max(128).optional()
  .transform((value) => (value === undefined || value.trim() === '' ? undefined : value));
export const ReconOptionsQuery = z.object({
  customerId: id.optional(), supplierId: id.optional(), q: optionQuery, page, pageSize,
});

const partner = z.object({ id: z.string(), code: z.string(), name: z.string() });
const person = z.object({ userId: z.string(), name: z.string() });
const file = z.object({ id: z.string(), name: z.string(), contentType: z.string(), size: z.number() });
const docLineView = z.object({
  id: z.string(), recordId: z.string(), salesOrderId: z.string().nullable(),
  receivableReconId: z.string().nullable(), orderPayableAmount: z.number(),
  receivedBefore: z.number().optional(), invoicedBefore: z.number().optional(),
  amount: z.number(), note: z.string().nullable(),
});
const commonDoc = {
  id: z.string(), docNo: z.string(), date: z.string(), status,
  bindMode, customerId: z.string().nullable(), customer: partner.nullable(),
  payerName: z.string().nullable(), invoiceToName: z.string().nullable(),
  invoiceNo: z.string().nullable(),
  incomeTypeCode: z.string().nullable(), incomeTypeLabel: z.string().nullable(),
  invoiceTypeCode: z.string().nullable(), invoiceTypeLabel: z.string().nullable(),
  fundAccountCode: z.string().nullable(), fundAccountLabel: z.string().nullable(),
  handler: person.nullable(), projectCode: z.string().nullable(),
  projectLabel: z.string().nullable(), remark: z.string(), totalAmount: z.number(),
  confirmedAt: z.string().nullable(), voidedAt: z.string().nullable(),
  createdAt: z.string(), updatedAt: z.string(),
  lines: z.array(docLineView), files: z.array(file).optional(),
};
export const DocSchema = z.object(commonDoc);
export const ItemSnapshot = z.object({
  id: z.string(), code: z.string(), name: z.string(), spec: z.string().nullable(), unitCode: z.string(),
});
export const SnapshotLineSchema = z.object({
  id: z.string(), reconId: z.string(), side: z.enum(['out', 'return', 'in']),
  sourceDocId: z.string(), itemId: z.string(), item: ItemSnapshot,
  qty: z.number(), taxRate: z.number().nullable(),
  taxIncludedPrice: z.number().nullable(), taxIncludedAmount: z.number().nullable(),
  note: z.string().nullable(),
});
export const ReconSchema = z.object({
  id: z.string(), docNo: z.string(), reconDate: z.string(), expectedPayDate: z.string().nullable(),
  periodAmount: z.number(), status, reconStatus: z.enum(['unsettled', 'partial', 'settled']),
  reconciledIncomeAmount: z.number().optional(), reconciledInvoiceAmount: z.number().optional(),
  reconciledPaidAmount: z.number().optional(),
  customer: partner.nullable(), supplier: partner.nullable(),
  contactName: z.string().nullable(), phone: z.string().nullable(),
  invoiceTypeCode: z.string().nullable(), handler: person.nullable(),
  projectCode: z.string().nullable(), remark: z.string(),
  confirmedAt: z.string().nullable(), voidedAt: z.string().nullable(),
  createdAt: z.string(), updatedAt: z.string(),
  snapshotLines: z.array(SnapshotLineSchema), files: z.array(file).optional(),
});
export const ReceivableOrderSchema = z.object({
  id: z.string(), orderNo: z.string(), orderDate: z.string(), status: z.string(),
  customerId: z.string().nullable(), payableTotal: z.number().nullable(),
  receivedAmount: z.number(), invoicedAmount: z.number(), customer: partner.nullable(),
});
export const ReconOptionSchema = z.object({
  id: z.string(), docNo: z.string(), reconDate: z.string(), periodAmount: z.number(),
  reconciledIncomeAmount: z.number().optional(), reconciledInvoiceAmount: z.number().optional(),
  reconciledPaidAmount: z.number().optional(),
});
const paged = <T extends z.ZodTypeAny>(item: T) =>
  z.object({ items: z.array(item), total: z.number(), page: z.number(), pageSize: z.number() });
export const DocListSchema = paged(DocSchema);
export const ReconListSchema = paged(ReconSchema);
export const ReceivableListSchema = paged(ReceivableOrderSchema);
export const ReconOptionsSchema = paged(ReconOptionSchema);

/** 页面必需的窄读：财务勾选已过账出入库单与对账单客户/供应商下拉。 */
const sourceKind = z.enum(['out', 'in']);
const partnerKind = z.enum(['customer', 'supplier']);
export const SourceDocsQuery = z.object({ kind: sourceKind, q: optionQuery, page, pageSize });
export const PartnerOptionsQuery = z.object({ kind: partnerKind, q: optionQuery, page, pageSize });
export const SourceDocSchema = z.object({
  id: z.string(), docNo: z.string(), docDate: z.string().nullable(),
  partnerId: z.string().nullable(), partnerName: z.string().nullable(),
  reason: z.string(), status: z.string(), totalQty: z.number().nullable(),
});
export const SourceDocsSchema = paged(SourceDocSchema);
export const PartnerOptionsSchema = paged(partner);
