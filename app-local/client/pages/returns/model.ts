import { ApiClientError } from '@nocobase/app-client';

import type { FieldErrors } from '#components/erp/form-dialog';
import { errorText, type Translate } from '#components/erp/messages';

import type {
  CreateReturnInput,
  ReturnDoc,
  ReturnLineInput,
  ReturnSourceType,
} from './client.js';

/** 明细一行的表单值：来源行数量与尚可退数量只读，用户只填退货数量与备注。 */
export interface LineDraft {
  readonly key: string;
  readonly sourceLineId: string;
  readonly itemId: string;
  readonly itemLabel: string;
  readonly warehouseId: string;
  readonly batchNo: string;
  /** 来源行数量快照，只回显。 */
  readonly qty: number;
  /** 服务端给的尚可退数量，页面不自行推算。 */
  readonly remainQty: number;
  readonly returnQty: string;
  readonly note: string;
}

export interface ReturnFormValues {
  readonly sourceType: ReturnSourceType;
  readonly sourceId: string;
  readonly sourceLabel: string;
  readonly handlerUserId: string;
  readonly remark: string;
  readonly fileIds: readonly string[];
  readonly lines: readonly LineDraft[];
}

export function emptyReturnForm(): ReturnFormValues {
  return {
    sourceType: 'stock_doc',
    sourceId: '',
    sourceLabel: '',
    handlerUserId: '',
    remark: '',
    fileIds: [],
    lines: [],
  };
}

export function returnFormOf(doc: ReturnDoc): ReturnFormValues {
  return {
    sourceType: doc.sourceType,
    sourceId: doc.sourceId,
    sourceLabel: doc.docNo,
    handlerUserId: doc.handler?.userId ?? '',
    remark: doc.remark,
    fileIds: (doc.files ?? []).map((file) => file.id),
    lines: doc.lines.map((line) => ({
      key: line.id,
      sourceLineId: line.sourceLineId ?? '',
      itemId: line.itemId,
      itemLabel: `${line.item.code} ${line.item.name}`,
      warehouseId: line.warehouseId,
      batchNo: line.batchNo,
      qty: line.qty,
      remainQty: line.remainQty,
      returnQty: String(line.returnQty),
      note: line.note ?? '',
    })),
  };
}

/** 解析退货数量：大于 0，小数最多四位。 */
export function parseQty(text: string): number | undefined {
  const value = (text ?? '').trim();
  if (!/^\d+(\.\d{1,4})?$/u.test(value)) return undefined;
  const number = Number(value);
  return number > 0 ? number : undefined;
}

const MAX = { remark: 1000, note: 500 } as const;

/** 提交时才校验：选了来源、至少一行、每行退货数量为正且不超过尚可退数量。 */
export function validateReturnForm(
  values: ReturnFormValues,
  t: Translate,
): FieldErrors {
  const errors: Record<string, string | undefined> = {};
  const required = t('erp.form.required');
  if (!values.sourceId) errors.sourceId = required;
  if ([...values.remark.trim()].length > MAX.remark)
    errors.remark = t('returns.errors.remarkTooLong');
  if (values.lines.length === 0) errors.lines = t('returns.errors.linesRequired');
  for (const line of values.lines) {
    if (!line.sourceLineId) errors[`source-${line.key}`] = required;
    if (!line.warehouseId) errors[`warehouse-${line.key}`] = required;
    if (!line.returnQty.trim()) errors[`return-${line.key}`] = required;
    else {
      const qty = parseQty(line.returnQty);
      if (qty === undefined) errors[`return-${line.key}`] = t('returns.errors.qtyInvalid');
      else if (qty > line.remainQty)
        errors[`return-${line.key}`] = t('returns.errors.qtyExceed');
    }
    if ([...(line.note ?? '').trim()].length > MAX.note)
      errors[`note-${line.key}`] = t('returns.errors.noteTooLong');
  }
  return errors;
}

function optionalText(value: string | undefined): string | undefined {
  const trimmed = (value ?? '').trim();
  return trimmed ? trimmed : undefined;
}

/** 表单值 → 请求体；只送服务端接受的键，数量换成 number。 */
export function returnInputOf(values: ReturnFormValues): CreateReturnInput {
  const lines: ReturnLineInput[] = values.lines.map((line) => ({
    sourceLineId: line.sourceLineId,
    returnQty: parseQty(line.returnQty) ?? 0,
    ...(optionalText(line.warehouseId) ? { warehouseId: line.warehouseId.trim() } : {}),
    ...(optionalText(line.note) ? { note: line.note.trim() } : {}),
  }));
  return {
    sourceType: values.sourceType,
    sourceId: values.sourceId,
    ...(optionalText(values.handlerUserId)
      ? { handlerUserId: values.handlerUserId.trim() }
      : {}),
    remark: values.remark.trim(),
    fileIds: [...values.fileIds],
    lines,
  };
}

/** 新建才送来源两字段；编辑草稿时端点不接受它们。 */
export function createInputOf(values: ReturnFormValues): CreateReturnInput {
  return returnInputOf(values);
}

/** 服务端拒绝过上限时，把规则码翻成页面上的一句话；未知的错误仍走框架文案。 */
const RULE_HINTS: Readonly<Record<string, string>> = {
  RETURN_QTY_EXCEED: 'returns.errors.qtyExceed',
  RETURN_NOT_DRAFT: 'returns.errors.returnNotDraft',
  RETURN_SOURCE_INVALID: 'returns.errors.sourceInvalid',
  RETURN_PARTNER_MIXED: 'returns.errors.partnerMixed',
  STOCK_INSUFFICIENT: 'returns.errors.insufficient',
  STOCK_PERSON_INVALID: 'returns.errors.personInvalid',
  WAREHOUSE_INACTIVE: 'returns.errors.warehouseInactive',
  WAREHOUSE_NOT_FOUND: 'returns.errors.warehouseNotFound',
  ITEM_INACTIVE: 'returns.errors.itemInactive',
  ITEM_NOT_FOUND: 'returns.errors.itemNotFound',
  EMPTY_UPDATE: 'returns.errors.emptyUpdate',
};

export function errorHint(error: unknown, t: Translate): string {
  if (error instanceof ApiClientError && error.reason !== undefined) {
    const key = RULE_HINTS[error.reason];
    if (key !== undefined) return t(key);
  }
  return errorText(error, t);
}

/** 单据在别处被过账或作废：页面重新读一遍。 */
export const isNotDraft = (error: unknown): boolean =>
  error instanceof ApiClientError && error.reason === 'RETURN_NOT_DRAFT';
