import { ApiClientError } from '@nocobase/app-client';

import type { FieldErrors } from '#components/erp/form-dialog';
import { serverMessage, type Translate } from '#components/erp/messages';

import type { CreateFinanceInput, FinanceRecord } from './client.js';
import { parseDate, today } from '../orders/model.js';
import type { FinanceKind } from './kinds.js';

/** 两分钱的金额：大于 0，最多两位小数。 */
const MONEY = /^\d+(\.\d{1,2})?$/u;
export function parseMoney(text: string): number | undefined {
  const value = text.trim();
  if (!MONEY.test(value)) return undefined;
  const number = Number(value);
  return number > 0 ? number : undefined;
}

export interface FinanceLineDraft {
  readonly key: string;
  readonly purchaseOrderId: string;
  readonly amount: string;
  readonly note: string;
}

let sequence = 0;
export const emptyLine = (): FinanceLineDraft => ({
  key: `new-${(sequence += 1)}`,
  purchaseOrderId: '',
  amount: '',
  note: '',
});

export interface FinanceFormValues {
  readonly date: string;
  readonly typeCode: string;
  readonly fundAccountCode: string;
  readonly payeeName: string;
  readonly supplierId: string;
  readonly payeeAccountNo: string;
  readonly payeeBankName: string;
  readonly payeeBankCode: string;
  readonly issuerName: string;
  readonly invoiceNo: string;
  readonly bindMode: 'purchase_order' | 'none';
  readonly amount: string;
  readonly projectCode: string;
  readonly handlerUserId: string;
  readonly remark: string;
  readonly fileIds: readonly string[];
  readonly lines: readonly FinanceLineDraft[];
}

export const emptyForm = (): FinanceFormValues => ({
  date: today(),
  typeCode: '',
  fundAccountCode: '',
  payeeName: '',
  supplierId: '',
  payeeAccountNo: '',
  payeeBankName: '',
  payeeBankCode: '',
  issuerName: '',
  invoiceNo: '',
  bindMode: 'purchase_order',
  amount: '',
  projectCode: '',
  handlerUserId: '',
  remark: '',
  fileIds: [],
  lines: [emptyLine()],
});

export const formOf = (record: FinanceRecord): FinanceFormValues => ({
  date: (record.expenseDate ?? record.invoiceDate ?? '').trim(),
  typeCode: record.expenseTypeCode ?? record.invoiceTypeCode ?? '',
  fundAccountCode: record.fundAccountCode ?? '',
  payeeName: record.payeeName ?? '',
  supplierId: record.supplier?.id ?? '',
  payeeAccountNo: record.payeeAccountNo ?? '',
  payeeBankName: record.payeeBankName ?? '',
  payeeBankCode: record.payeeBankCode ?? '',
  issuerName: record.issuerName ?? '',
  invoiceNo: record.invoiceNo ?? '',
  bindMode: record.bindMode,
  amount: record.bindMode === 'none' ? String(record.totalAmount) : '',
  projectCode: record.projectCode ?? '',
  handlerUserId: record.handler?.userId ?? '',
  remark: record.remark,
  fileIds: (record.files ?? []).map((file) => file.id),
  lines: record.lines.map((line) => ({
    key: line.id,
    purchaseOrderId: line.purchaseOrderId,
    amount: String(line.amount),
    note: line.note ?? '',
  })),
});

/** 提交时才跑：错误键就是光标要落下的控件名。 */
export function validate(values: FinanceFormValues, t: Translate): FieldErrors {
  const errors: Record<string, string | undefined> = {};
  if (!values.date.trim()) errors.date = t('finance.errors.dateRequired');
  else if (!parseDate(values.date)) errors.date = t('orderDocs.errors.dateInvalid');
  if (values.bindMode === 'purchase_order') {
    if (values.lines.length === 0)
      errors.lines = t('finance.errors.linesRequired');
    const used = new Set<string>();
    values.lines.forEach((line, index) => {
      const prefix = `line.${index}.`;
      if (!line.purchaseOrderId) errors[`${prefix}purchaseOrderId`] = t('finance.errors.orderRequired');
      else if (used.has(line.purchaseOrderId))
        errors[`${prefix}purchaseOrderId`] = t('finance.errors.orderDuplicated');
      used.add(line.purchaseOrderId);
      if (!line.amount.trim()) errors[`${prefix}amount`] = t('finance.errors.amountRequired');
      else if (parseMoney(line.amount) === undefined)
        errors[`${prefix}amount`] = t('finance.errors.amountInvalid');
    });
  } else if (parseMoney(values.amount) === undefined) {
    errors.amount = t('finance.errors.amountInvalid');
  }
  return errors;
}

function optional<T>(values: Record<string, T | undefined>): Record<string, T> {
  return Object.fromEntries(
    Object.entries(values).filter(([, value]) => value !== undefined && value !== ''),
  ) as Record<string, T>;
}

/** 发给端点的请求体；`confirm: true` 时一步登记。 */
export function inputOf(
  values: FinanceFormValues,
  kind: FinanceKind,
  register = false,
): CreateFinanceInput {
  const dateKey = kind.dateField;
  const typeKey = kind.typeField;
  return {
    [dateKey]: values.date.trim(),
    [typeKey]: values.typeCode,
    bindMode: values.bindMode,
    ...optional<unknown>({
      fundAccountCode: values.fundAccountCode,
      payeeName: values.payeeName,
      supplierId: values.supplierId,
      payeeAccountNo: values.payeeAccountNo,
      payeeBankName: values.payeeBankName,
      payeeBankCode: values.payeeBankCode,
      issuerName: values.issuerName,
      invoiceNo: values.invoiceNo,
      projectCode: values.projectCode,
      handlerUserId: values.handlerUserId,
      remark: values.remark,
    }),
    ...(values.fileIds.length > 0 ? { fileIds: [...values.fileIds] } : {}),
    ...(values.bindMode === 'none'
      ? { amount: parseMoney(values.amount) ?? 0 }
      : {
          lines: values.lines.map((line) => ({
            purchaseOrderId: line.purchaseOrderId,
            amount: parseMoney(line.amount) ?? 0,
            ...(line.note.trim() ? { note: line.note.trim() } : {}),
          })),
        }),
    ...(register ? { confirm: true } : {}),
  };
}

/** 服务端的规则码落到哪一项下面；提示仍用服务端翻好的那句话。 */
export function fieldErrors(error: unknown): FieldErrors {
  if (!(error instanceof ApiClientError)) return {};
  const message = serverMessage(error);
  switch (error.reason) {
    case 'FINANCE_ORDER_NOT_PAYABLE':
    case 'FINANCE_LINE_INVALID':
    case 'FINANCE_LINE_DUPLICATED':
    case 'FINANCE_SUPPLIER_MIXED':
      return { lines: message };
    case 'FINANCE_DICT_CODE_INVALID':
      return { typeCode: message };
    case 'FINANCE_PERSON_INVALID':
      return { handlerUserId: message };
    case 'FINANCE_PARTNER_INVALID':
      return { supplierId: message };
    case 'FILE_NOT_FOUND':
    case 'FILE_UNAVAILABLE':
      return { fileIds: message };
    default:
      return {};
  }
}
