import { ApiClientError } from '@nocobase/app-client';

import type { FieldErrors } from '#components/erp/form-dialog';
import { serverMessage, type Translate } from '#components/erp/messages';

import {
  parseDate,
  parseDecimal,
  today,
} from '../orders/model.js';
import type {
  CreateRequestInput,
  LineInput,
  PurchaseRequest,
} from './client.js';

/**
 * 请购单表单的纯逻辑。金额、预计金额与表尾合计都由服务端算，这里只收原始输入、
 * 校验必填项，不推断价格也不自己加总。
 */

export interface LineDraft {
  readonly key: string;
  readonly itemId: string;
  readonly qty: string;
  readonly expectedPrice: string;
}

export interface RequestFormValues {
  readonly requestDate: string;
  readonly departmentId: string;
  readonly requesterUserId: string;
  readonly projectCode: string;
  readonly customText1: string;
  readonly customText2: string;
  readonly description: string;
  readonly fileIds: readonly string[];
  readonly lines: readonly LineDraft[];
}

export function emptyRequestForm(): RequestFormValues {
  return {
    requestDate: today(),
    departmentId: '',
    requesterUserId: '',
    projectCode: '',
    customText1: '',
    customText2: '',
    description: '',
    fileIds: [],
    lines: [],
  };
}

export function newLine(): LineDraft {
  return {
    key: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    itemId: '',
    qty: '',
    expectedPrice: '',
  };
}

export function requestFormOf(request: PurchaseRequest): RequestFormValues {
  return {
    requestDate: request.requestDate,
    departmentId: request.department.id,
    requesterUserId: request.requester.userId,
    projectCode: request.projectCode ?? '',
    customText1: request.customText1 ?? '',
    customText2: request.customText2 ?? '',
    description: request.description,
    fileIds: request.files.map((file) => file.id),
    lines: request.lines.map((line, index) => ({
      key: `line-${index}-${line.id}`,
      itemId: line.itemId,
      qty: String(line.qty),
      expectedPrice: line.expectedPrice === null ? '' : String(line.expectedPrice),
    })),
  };
}

export function validateRequestForm(
  values: RequestFormValues,
  t: Translate,
): FieldErrors {
  const errors: Record<string, string | undefined> = {};
  if (!values.departmentId)
    errors.departmentId = t('purchaseRequests.errors.departmentRequired');
  if (!values.requesterUserId)
    errors.requesterUserId = t('purchaseRequests.errors.requesterRequired');
  if (!values.requestDate.trim())
    errors.requestDate = t('purchaseRequests.errors.dateRequired');
  else if (!parseDate(values.requestDate))
    errors.requestDate = t('purchaseRequests.errors.dateInvalid');
  if (values.lines.length === 0)
    errors.lines = t('purchaseRequests.errors.linesRequired');
  const uses = new Map<string, number>();
  for (const line of values.lines)
    uses.set(line.itemId, (uses.get(line.itemId) ?? 0) + 1);
  for (const line of values.lines) {
    if (!line.itemId)
      errors[`item-${line.key}`] = t('purchaseRequests.errors.itemRequired');
    else if ((uses.get(line.itemId) ?? 0) > 1)
      errors[`item-${line.key}`] = t('purchaseRequests.errors.itemDuplicated');
    if (!line.qty.trim())
      errors[`qty-${line.key}`] = t('purchaseRequests.errors.qtyRequired');
    else {
      const qty = parseDecimal(line.qty);
      if (qty === undefined || qty <= 0)
        errors[`qty-${line.key}`] = t('purchaseRequests.errors.qtyInvalid');
    }
    if (line.expectedPrice.trim()) {
      const price = parseDecimal(line.expectedPrice);
      if (price === undefined)
        errors[`expectedPrice-${line.key}`] = t(
          'purchaseRequests.errors.priceInvalid',
        );
    }
  }
  return errors;
}

function text(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

/** 发给端点的形状：明细行只送原始输入，金额与合计交给服务端。 */
export function requestInputOf(values: RequestFormValues): {
  readonly header: CreateRequestInput;
  readonly lines: readonly LineInput[];
} {
  const header: CreateRequestInput = {
    requestDate: values.requestDate.trim(),
    departmentId: values.departmentId,
    requesterUserId: values.requesterUserId,
    description: values.description.trim(),
    fileIds: [...values.fileIds],
    ...(text(values.projectCode) ? { projectCode: text(values.projectCode) } : {}),
    ...(text(values.customText1)
      ? { customText1: text(values.customText1) }
      : {}),
    ...(text(values.customText2)
      ? { customText2: text(values.customText2) }
      : {}),
  };
  const lines = values.lines.map((line) => ({
    itemId: line.itemId,
    qty: Number(line.qty),
    ...(line.expectedPrice.trim()
      ? { expectedPrice: Number(line.expectedPrice) }
      : {}),
  }));
  return { header, lines };
}

/** 服务端的规则码落到哪一项下面；提示用服务端翻好的那句话。 */
export function requestFieldErrors(error: unknown): FieldErrors {
  if (!(error instanceof ApiClientError)) return {};
  const message = serverMessage(error);
  switch (error.reason) {
    case 'DEPARTMENT_NOT_FOUND':
    case 'DEPARTMENT_INACTIVE':
      return { departmentId: message };
    case 'PURCHASE_REQUEST_PERSON_INVALID':
      return { requesterUserId: message };
    case 'PURCHASE_REQUEST_DICT_CODE_INVALID':
      return { projectCode: message };
    case 'ITEM_NOT_FOUND':
    case 'ITEM_INACTIVE':
    case 'PURCHASE_REQUEST_LINE_INVALID':
      return { lines: message };
    case 'FILE_NOT_FOUND':
    case 'FILE_UNAVAILABLE':
    case 'FILE_TOO_MANY':
      return { fileIds: message };
    default:
      return {};
  }
}
