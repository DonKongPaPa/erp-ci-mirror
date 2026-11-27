import { z } from 'zod';

/** R-065 第一片：支出与到票端点共用的 zod schema。业务规则留在服务层，先授权再读内容。 */
const page = z.coerce.number().int().min(1).default(1);
const pageSize = z.coerce.number().int().min(1).max(100).default(20);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u);
const id = z.string().min(1).max(64);
const code = z.string().min(1).max(32);
const money = z.number();
const status = z.enum(['draft', 'confirmed', 'void']);
const bindMode = z.enum(['purchase_order', 'none']);
const line = z.object({ purchaseOrderId: id, amount: money, note: z.string().max(500).optional() });
const fileIds = z.array(z.string().min(1).max(64)).optional();

const commonBody = {
  supplierId: id.nullable().optional(),
  handlerUserId: id.nullable().optional(),
  projectCode: code.nullable().optional(),
  remark: z.string().max(1000).optional(),
  fileIds,
  amount: money.optional(),
  lines: z.array(line).optional(),
};
const bankBody = {
  payeeName: z.string().max(128).nullable().optional(),
  payeeAccountNo: z.string().max(64).nullable().optional(),
  payeeBankName: z.string().max(128).nullable().optional(),
  payeeBankCode: z.string().max(32).nullable().optional(),
};

export const CreateExpenseBody = z.object({
  expenseDate: day,
  bindMode,
  expenseTypeCode: code.nullable().optional(),
  fundAccountCode: code.nullable().optional(),
  confirm: z.boolean().optional(),
  ...commonBody,
  ...bankBody,
});
export const UpdateExpenseBody = z.object({
  expenseDate: day.optional(),
  expenseTypeCode: code.nullable().optional(),
  fundAccountCode: code.nullable().optional(),
  ...commonBody,
  ...bankBody,
});
export const CreateInvoiceReceiptBody = z.object({
  invoiceDate: day,
  bindMode,
  invoiceTypeCode: code.nullable().optional(),
  issuerName: z.string().max(128).nullable().optional(),
  invoiceNo: z.string().max(64).nullable().optional(),
  confirm: z.boolean().optional(),
  ...commonBody,
});
export const UpdateInvoiceReceiptBody = z.object({
  invoiceDate: day.optional(),
  invoiceTypeCode: code.nullable().optional(),
  issuerName: z.string().max(128).nullable().optional(),
  invoiceNo: z.string().max(64).nullable().optional(),
  ...commonBody,
});

const commonList = {
  status: status.optional(),
  supplierId: id.optional(),
  projectCode: code.optional(),
  from: day.optional(),
  to: day.optional(),
  q: z.string().min(1).max(128).optional(),
  page,
  pageSize,
};
export const ExpenseListQuery = z.object({
  ...commonList,
  expenseTypeCode: code.optional(),
  fundAccountCode: code.optional(),
});
export const InvoiceReceiptListQuery = z.object({
  ...commonList,
  invoiceTypeCode: code.optional(),
  invoiceNo: z.string().max(64).optional(),
});
export const PayableListQuery = z.object({
  supplierId: id.optional(),
  status: z.string().optional(),
  q: z.string().min(1).max(128).optional(),
  page,
  pageSize,
});
export const SupplierOptionsQuery = z.object({
  q: z.string().min(1).max(128).optional(),
  page,
  pageSize,
});

const supplier = z.object({
  id: z.string(), code: z.string(), name: z.string(),
  payeeAccountNo: z.string().nullable(), payeeBankName: z.string().nullable(),
  payeeBankCode: z.string().nullable(),
});
const person = z.object({ userId: z.string(), name: z.string() });
const financeLine = z.object({
  id: z.string(), recordId: z.string(), purchaseOrderId: z.string(), orderNo: z.string(),
  orderPayableAmount: z.number(), paidBefore: z.number().optional(),
  invoicedBefore: z.number().optional(), amount: z.number(), note: z.string().nullable(),
});
const file = z.object({ id: z.string(), name: z.string(), contentType: z.string(), size: z.number() });
const commonRecord = {
  id: z.string(), docNo: z.string(), date: z.string(), status,
  payeeName: z.string().nullable(), supplier: supplier.nullable(),
  bindMode, handler: person.nullable(), projectCode: z.string().nullable(),
  projectLabel: z.string().nullable(), remark: z.string(), totalAmount: z.number(),
  confirmedAt: z.string().nullable(), voidedAt: z.string().nullable(),
  createdAt: z.string(), updatedAt: z.string(),
  lines: z.array(financeLine).optional(), files: z.array(file).optional(),
};
export const ExpenseSchema = z.object({
  ...commonRecord,
  expenseTypeCode: z.string().nullable(), expenseTypeLabel: z.string().nullable(),
  fundAccountCode: z.string().nullable(), fundAccountLabel: z.string().nullable(),
  payeeAccountNo: z.string().nullable(), payeeBankName: z.string().nullable(),
  payeeBankCode: z.string().nullable(),
});
export const InvoiceReceiptSchema = z.object({
  ...commonRecord,
  invoiceTypeCode: z.string().nullable(), invoiceTypeLabel: z.string().nullable(),
  issuerName: z.string().nullable(), invoiceNo: z.string().nullable(),
});
const paged = <T extends z.ZodTypeAny>(item: T) =>
  z.object({ items: z.array(item), total: z.number(), page: z.number(), pageSize: z.number() });
export const ExpenseListSchema = paged(ExpenseSchema);
export const InvoiceReceiptListSchema = paged(InvoiceReceiptSchema);
export const PayableSchema = z.object({
  id: z.string(), orderNo: z.string(), orderDate: z.string(), status: z.string(),
  payableTotal: z.number().nullable(), paidAmount: z.number(), invoicedAmount: z.number(),
  unpaidAmount: z.number().nullable(), supplier: supplier.nullable(),
});
export const PayableListSchema = paged(PayableSchema);
export const SupplierOptionsSchema = paged(supplier);
