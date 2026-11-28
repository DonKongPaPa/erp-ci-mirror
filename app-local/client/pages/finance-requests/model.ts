import { ApiClientError } from '@nocobase/app-client';

import type { FieldErrors } from '#components/erp/form-dialog';
import { serverMessage, type Translate } from '#components/erp/messages';

import { parseDate, parseDecimal, today } from '../orders/model.js';
import type {
  CreateFinanceRequestInput,
  FinanceRequest,
  RequestDocType,
  UpdateFinanceRequestInput,
} from './client.js';

/**
 * 请款 / 报销表单的纯逻辑。一单一金额、一段事由，没有明细行；金额只收原始输入并校验
 * 正数与两位小数，类型、项目只回码，附件整组提交。经办人留空时端点默认登录人。
 */

export interface RequestFormValues {
  readonly docType: string;
  readonly requestDate: string;
  readonly expenseTypeCode: string;
  readonly amount: string;
  readonly reason: string;
  readonly handlerUserId: string;
  readonly projectCode: string;
  readonly fileIds: readonly string[];
}

export function emptyRequestForm(): RequestFormValues {
  return {
    docType: '',
    requestDate: today(),
    expenseTypeCode: '',
    amount: '',
    reason: '',
    handlerUserId: '',
    projectCode: '',
    fileIds: [],
  };
}

export function requestFormOf(request: FinanceRequest): RequestFormValues {
  return {
    docType: request.docType,
    requestDate: request.requestDate,
    expenseTypeCode: request.expenseTypeCode ?? '',
    amount: String(request.amount),
    reason: request.reason,
    handlerUserId: request.handler.userId,
    projectCode: request.projectCode ?? '',
    fileIds: request.files.map((file) => file.id),
  };
}

export function validateRequestForm(
  values: RequestFormValues,
  t: Translate,
): FieldErrors {
  const errors: Record<string, string | undefined> = {};
  if (
    values.docType !== 'payment_request' &&
    values.docType !== 'expense_claim'
  )
    errors.docType = t('financeRequestDocs.errors.docTypeRequired');
  if (!values.requestDate.trim())
    errors.requestDate = t('financeRequestDocs.errors.dateRequired');
  else if (!parseDate(values.requestDate))
    errors.requestDate = t('financeRequestDocs.errors.dateInvalid');
  const amount = values.amount.trim()
    ? parseDecimal(values.amount.trim())
    : undefined;
  if (
    amount === undefined ||
    amount <= 0 ||
    Math.round(amount * 100) !== amount * 100
  )
    errors.amount = t('financeRequestDocs.errors.amountInvalid');
  return errors;
}

function text(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

/** 建单请求体：类型必选，经办人留空时不带该键，交给服务端默认登录人。 */
export function createInputOf(
  values: RequestFormValues,
): CreateFinanceRequestInput {
  return {
    docType: values.docType as RequestDocType,
    requestDate: values.requestDate.trim(),
    amount: Number(values.amount),
    reason: values.reason.trim(),
    fileIds: [...values.fileIds],
    ...(text(values.expenseTypeCode)
      ? { expenseTypeCode: text(values.expenseTypeCode) }
      : {}),
    ...(text(values.handlerUserId)
      ? { handlerUserId: text(values.handlerUserId) }
      : {}),
    ...(text(values.projectCode) ? { projectCode: text(values.projectCode) } : {}),
  };
}

/** 改单请求体：PATCH 不收 docType；可空的码在清空时送 null，让服务端解绑。 */
export function updateInputOf(
  values: RequestFormValues,
): UpdateFinanceRequestInput {
  return {
    requestDate: values.requestDate.trim(),
    amount: Number(values.amount),
    reason: values.reason.trim(),
    fileIds: [...values.fileIds],
    expenseTypeCode: text(values.expenseTypeCode) ?? null,
    projectCode: text(values.projectCode) ?? null,
    ...(text(values.handlerUserId)
      ? { handlerUserId: text(values.handlerUserId) }
      : {}),
  };
}

/** 服务端的规则码落到哪一项下面；提示用服务端翻好的那句话。 */
export function requestFieldErrors(error: unknown): FieldErrors {
  if (!(error instanceof ApiClientError)) return {};
  const message = serverMessage(error);
  switch (error.reason) {
    case 'FINANCE_REQUEST_AMOUNT_INVALID':
      return { amount: message };
    case 'FINANCE_REQUEST_PERSON_INVALID':
      return { handlerUserId: message };
    case 'FINANCE_REQUEST_DICT_CODE_INVALID':
      // 服务端不在 reason 里区分两个字典，两个码都标出来，让填表人自己看是哪一项。
      return { expenseTypeCode: message, projectCode: message };
    case 'FILE_NOT_FOUND':
    case 'FILE_UNAVAILABLE':
    case 'FILE_TOO_MANY':
      return { fileIds: message };
    default:
      return {};
  }
}
