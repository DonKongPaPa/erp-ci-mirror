import { ApiClientError } from '@nocobase/app-client';

import type { FieldErrors } from '#components/erp/form-dialog';
import { errorText, serverMessage, type Translate } from '#components/erp/messages';

import { parseDate, today } from '../orders/model.js';
import type { DocRecord, ReconRecord } from './client.js';
import type { DocKind, ReconKind } from './kinds.js';

/** 金额：大于 0，最多两位小数。 */
const MONEY = /^\d+(\.\d{1,2})?$/u;
function money(text: string): number | undefined {
  const value = text.trim();
  if (!MONEY.test(value)) return undefined;
  const number = Number(value);
  return number > 0 ? number : undefined;
}

function text(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

let sequence = 0;
export interface DocLineDraft {
  readonly key: string;
  readonly salesOrderId: string;
  readonly receivableReconId: string;
  readonly amount: string;
  readonly note: string;
}
export const emptyLine = (): DocLineDraft => ({
  key: `new-${(sequence += 1)}`,
  salesOrderId: '', receivableReconId: '', amount: '', note: '',
});

export interface DocFormValues {
  readonly date: string;
  readonly typeCode: string;
  readonly fundAccountCode: string;
  readonly payerName: string;
  readonly invoiceToName: string;
  readonly invoiceNo: string;
  readonly customerId: string;
  readonly bindMode: 'sales_order' | 'receivable_recon' | 'none';
  readonly amount: string;
  readonly lines: readonly DocLineDraft[];
  readonly projectCode: string;
  readonly handlerUserId: string;
  readonly remark: string;
  readonly fileIds: readonly string[];
}

export function emptyDocForm(): DocFormValues {
  return {
    date: today(), typeCode: '', fundAccountCode: '', payerName: '',
    invoiceToName: '', invoiceNo: '', customerId: '', bindMode: 'sales_order',
    amount: '', lines: [emptyLine()], projectCode: '', handlerUserId: '',
    remark: '', fileIds: [],
  };
}

export function docFormOf(record: DocRecord): DocFormValues {
  return {
    date: record.date,
    typeCode: record.incomeTypeCode ?? record.invoiceTypeCode ?? '',
    fundAccountCode: record.fundAccountCode ?? '',
    payerName: record.payerName ?? '',
    invoiceToName: record.invoiceToName ?? '',
    invoiceNo: record.invoiceNo ?? '',
    customerId: record.customerId ?? '',
    bindMode: record.bindMode,
    amount: record.bindMode === 'none' ? String(record.totalAmount) : '',
    lines: record.lines.map((line) => ({
      key: line.id,
      salesOrderId: line.salesOrderId ?? '',
      receivableReconId: line.receivableReconId ?? '',
      amount: String(line.amount),
      note: line.note ?? '',
    })),
    projectCode: record.projectCode ?? '',
    handlerUserId: record.handler?.userId ?? '',
    remark: record.remark,
    fileIds: (record.files ?? []).map((file) => file.id),
  };
}

export function validateDoc(values: DocFormValues, t: Translate): FieldErrors {
  const errors: Record<string, string | undefined> = {};
  if (!values.date.trim()) errors.date = t('reconciliation.errors.dateRequired');
  else if (!parseDate(values.date)) errors.date = t('reconciliation.errors.dateInvalid');
  if (values.bindMode === 'none') {
    if (money(values.amount) === undefined) errors.amount = t('reconciliation.errors.amountInvalid');
    return errors;
  }
  if (values.lines.length === 0) errors.lines = t('reconciliation.errors.linesRequired');
  const used = new Set<string>();
  values.lines.forEach((line, index) => {
    const prefix = `line.${index}.`;
    const id = values.bindMode === 'sales_order' ? line.salesOrderId : line.receivableReconId;
    if (!id) errors[`${prefix}id`] = t('reconciliation.errors.upstreamRequired');
    else if (used.has(id)) errors[`${prefix}id`] = t('reconciliation.errors.upstreamDuplicated');
    used.add(id);
    if (money(line.amount) === undefined) errors[`${prefix}amount`] = t('reconciliation.errors.amountInvalid');
  });
  return errors;
}

/** 发给端点的请求体；`register` 时一步登记。 */
export function docInputOf(values: DocFormValues, kind: DocKind, register = false): Record<string, unknown> {
  return {
    [kind.dateField]: values.date.trim(),
    [kind.typeField]: values.typeCode,
    bindMode: values.bindMode,
    ...(values.bindMode === 'none'
      ? { amount: money(values.amount) ?? 0 }
      : {
          lines: values.lines.map((line) => ({
            ...(values.bindMode === 'sales_order'
              ? { salesOrderId: line.salesOrderId }
              : { receivableReconId: line.receivableReconId }),
            amount: money(line.amount) ?? 0,
            ...(text(line.note) ? { note: text(line.note) } : {}),
          })),
        }),
    ...(values.bindMode === 'sales_order' && values.customerId
      ? { customerId: values.customerId }
      : {}),
    ...(kind.id === 'income' && values.fundAccountCode
      ? { fundAccountCode: values.fundAccountCode }
      : {}),
    ...(kind.id === 'income' && values.payerName ? { payerName: values.payerName } : {}),
    ...(kind.id === 'saleInvoice' && values.invoiceToName
      ? { invoiceToName: values.invoiceToName }
      : {}),
    ...(kind.id === 'saleInvoice' && values.invoiceNo ? { invoiceNo: values.invoiceNo } : {}),
    ...(text(values.projectCode) ? { projectCode: text(values.projectCode) } : {}),
    ...(text(values.handlerUserId) ? { handlerUserId: text(values.handlerUserId) } : {}),
    ...(text(values.remark) ? { remark: text(values.remark) } : {}),
    ...(values.fileIds.length > 0 ? { fileIds: [...values.fileIds] } : {}),
    ...(register ? { confirm: true } : {}),
  };
}

export function docFieldErrors(error: unknown): FieldErrors {
  if (!(error instanceof ApiClientError)) return {};
  const message = serverMessage(error);
  switch (error.reason) {
    case 'FINANCE_LINE_INVALID':
    case 'FINANCE_LINE_DUPLICATED':
    case 'FINANCE_RECON_NOT_OPEN':
    case 'FINANCE_CUSTOMER_MIXED':
      return { lines: message };
    case 'FINANCE_DICT_CODE_INVALID':
      return { typeCode: message };
    case 'FINANCE_PERSON_INVALID':
      return { handlerUserId: message };
    case 'FINANCE_PARTNER_INVALID':
      return { customerId: message };
    case 'FILE_NOT_FOUND':
    case 'FILE_UNAVAILABLE':
      return { fileIds: message };
    default:
      return {};
  }
}

/** 服务端英文规则码不露给用户：按 reason 翻成页面看得懂的一句话。 */
const FINANCE_ERROR_HINTS: Readonly<Record<string, string>> = {
  FINANCE_NOT_FOUND: 'reconciliation.errors.notFound',
  FINANCE_DOC_NOT_FOUND: 'reconciliation.errors.notFound',
  FINANCE_RECON_NOT_FOUND: 'reconciliation.errors.notFound',
  RECON_NOT_FOUND: 'reconciliation.errors.notFound',
  FINANCE_NOT_DRAFT: 'reconciliation.errors.notDraft',
  RECON_NOT_DRAFT: 'reconciliation.errors.notDraft',
};

export function financeErrorText(error: unknown, t: Translate): string {
  if (error instanceof ApiClientError && error.reason !== undefined) {
    const key = FINANCE_ERROR_HINTS[error.reason];
    if (key !== undefined) return t(key);
    if (/^(FINANCE|RECON)_/u.test(error.reason)) return t('reconciliation.errors.generic');
  }
  return errorText(error, t);
}

export interface ReconFormValues {
  readonly reconDate: string;
  readonly expectedPayDate: string;
  readonly periodAmount: string;
  readonly partnerId: string;
  readonly contactName: string;
  readonly phone: string;
  readonly invoiceTypeCode: string;
  readonly sourceIds: readonly string[];
  readonly handlerUserId: string;
  readonly projectCode: string;
  readonly remark: string;
  readonly fileIds: readonly string[];
}

export function emptyReconForm(): ReconFormValues {
  return {
    reconDate: today(), expectedPayDate: '', periodAmount: '', partnerId: '',
    contactName: '', phone: '', invoiceTypeCode: '', sourceIds: [],
    handlerUserId: '', projectCode: '', remark: '', fileIds: [],
  };
}

export function reconFormOf(record: ReconRecord, kind: ReconKind): ReconFormValues {
  return {
    reconDate: record.reconDate,
    expectedPayDate: record.expectedPayDate ?? '',
    periodAmount: String(record.periodAmount),
    partnerId: (kind.partnerKey === 'customerId' ? record.customer : record.supplier)?.id ?? '',
    contactName: record.contactName ?? '',
    phone: record.phone ?? '',
    invoiceTypeCode: record.invoiceTypeCode ?? '',
    sourceIds: record.snapshotLines.map((line) => line.sourceDocId),
    handlerUserId: record.handler?.userId ?? '',
    projectCode: record.projectCode ?? '',
    remark: record.remark,
    fileIds: (record.files ?? []).map((file) => file.id),
  };
}

export function validateRecon(values: ReconFormValues, t: Translate): FieldErrors {
  const errors: Record<string, string | undefined> = {};
  if (!values.reconDate.trim()) errors.reconDate = t('reconciliation.errors.dateRequired');
  else if (!parseDate(values.reconDate)) errors.reconDate = t('reconciliation.errors.dateInvalid');
  if (!values.partnerId) errors.partnerId = t('reconciliation.errors.partnerRequired');
  if (money(values.periodAmount) === undefined)
    errors.periodAmount = t('reconciliation.errors.amountInvalid');
  if (values.sourceIds.length === 0) errors.sourceIds = t('reconciliation.errors.sourceRequired');
  return errors;
}

export function reconInputOf(values: ReconFormValues, kind: ReconKind): Record<string, unknown> {
  return {
    reconDate: values.reconDate.trim(),
    periodAmount: money(values.periodAmount) ?? 0,
    [kind.partnerKey]: values.partnerId,
    [kind.sourceIdsKey]: [...values.sourceIds],
    ...(values.expectedPayDate ? { expectedPayDate: values.expectedPayDate } : {}),
    ...(text(values.contactName) ? { contactName: text(values.contactName) } : {}),
    ...(text(values.phone) ? { phone: text(values.phone) } : {}),
    ...(kind.typeDict === 'invoice_type' && values.invoiceTypeCode
      ? { invoiceTypeCode: values.invoiceTypeCode }
      : {}),
    ...(text(values.projectCode) ? { projectCode: text(values.projectCode) } : {}),
    ...(text(values.handlerUserId) ? { handlerUserId: text(values.handlerUserId) } : {}),
    ...(text(values.remark) ? { remark: text(values.remark) } : {}),
    ...(values.fileIds.length > 0 ? { fileIds: [...values.fileIds] } : {}),
  };
}

export function reconFieldErrors(error: unknown): FieldErrors {
  if (!(error instanceof ApiClientError)) return {};
  const message = serverMessage(error);
  switch (error.reason) {
    case 'RECON_EMPTY':
    case 'RECON_SOURCE_INVALID':
    case 'FINANCE_LINE_DUPLICATED':
      return { sourceIds: message };
    case 'FINANCE_DICT_CODE_INVALID':
      return { invoiceTypeCode: message };
    case 'FINANCE_PERSON_INVALID':
      return { handlerUserId: message };
    case 'FINANCE_PARTNER_INVALID':
      return { partnerId: message };
    case 'FILE_NOT_FOUND':
    case 'FILE_UNAVAILABLE':
      return { fileIds: message };
    default:
      return {};
  }
}
