import { ApiClientError } from '@nocobase/app-client';

import type { FieldErrors } from '#components/erp/form-dialog';
import { type Translate } from '#components/erp/messages';
import { TABLE_URL_KEYS } from '#hooks/use-table-url-state';

import type { StockDoc, StockLineInput } from './client.js';

/** 列表记在地址栏里的键：从单据回到列表时原样带着（搜索、状态、创建时间、分页）。 */
export const STOCK_DOC_LIST_KEYS = [
  'q',
  'status',
  'from',
  'to',
  ...TABLE_URL_KEYS,
] as const;

/** 明细一行的表单值：数量是文本，提交前换成数。 */
export interface LineFormValues {
  /** 这一行的键：已保存的行用明细 id，新加的行现编一个。 */
  readonly key: string;
  readonly itemId: string;
  readonly warehouseId: string;
  readonly batchNo: string;
  readonly qty: string;
}

export interface DocFormValues {
  readonly reason: StockDoc['reason'];
  readonly remark: string;
  readonly lines: readonly LineFormValues[];
}

let sequence = 0;

export const emptyLine = (): LineFormValues => ({
  key: `new-${(sequence += 1)}`,
  itemId: '',
  warehouseId: '',
  batchNo: '',
  qty: '',
});

/** 手工新建：一行空明细，类型默认是不带来源的那一种。 */
export const emptyForm = (reason: StockDoc['reason']): DocFormValues => ({
  reason,
  remark: '',
  lines: [emptyLine()],
});

/** 编辑：原样带出这一张。 */
export const formOf = (doc: StockDoc): DocFormValues => ({
  reason: doc.reason,
  remark: doc.remark,
  lines: doc.lines.map((line) => ({
    key: line.id,
    itemId: line.itemId,
    warehouseId: line.warehouseId,
    batchNo: line.batchNo,
    qty: String(line.qty),
  })),
});

/** 数量的写法：大于 0，小数最多四位；写得不合规返回 `undefined`。 */
export function parseQty(text: string): number | undefined {
  const value = text.trim();
  if (!/^\d+(\.\d{1,4})?$/u.test(value)) return undefined;
  const number = Number(value);
  return number > 0 ? number : undefined;
}

/** 建单与改草稿共用的那几项：类型、备注、整份明细。 */
export interface DocInput {
  readonly reason: StockDoc['reason'];
  readonly remark: string;
  readonly lines: readonly StockLineInput[];
}

/** 表单的值 → 请求体里改得了的那几项。调用前一定先过 `validateDocForm`。 */
export function inputOf(values: DocFormValues): DocInput {
  return {
    reason: values.reason,
    remark: values.remark.trim(),
    lines: values.lines.map(
      (line): StockLineInput => ({
        itemId: line.itemId,
        warehouseId: line.warehouseId,
        batchNo: line.batchNo.trim(),
        qty: parseQty(line.qty) ?? 0,
      }),
    ),
  };
}

const MAX = {
  remark: 1000,
  batchNo: 64,
} as const;

/**
 * 提交时才校验，规则与 R-020 一致：至少一行明细；每一行的物料、仓库、数量必填，数量大于 0 且
 * 小数最多四位，批号最多 64 个字符，备注最多 1000 个字符。错误标在对应的那一项下面，
 * 明细的错误键是 `line.<第几行>.<哪一项>`。
 */
export function validateDocForm(values: DocFormValues, t: Translate): FieldErrors {
  const errors: Record<string, string | undefined> = {};
  const required = t('erp.form.required');
  if ([...values.remark.trim()].length > MAX.remark)
    errors.remark = t('stockDocs.errors.remarkTooLong');
  if (values.lines.length === 0) errors.lines = t('stockDocs.errors.requiredLine');
  values.lines.forEach((line, index) => {
    const prefix = `line.${index}.`;
    if (!line.itemId) errors[`${prefix}itemId`] = required;
    if (!line.warehouseId) errors[`${prefix}warehouseId`] = required;
    if (!line.qty.trim()) errors[`${prefix}qty`] = required;
    else if (parseQty(line.qty) === undefined)
      errors[`${prefix}qty`] = t('stockDocs.errors.invalidQty');
    if ([...line.batchNo.trim()].length > MAX.batchNo)
      errors[`${prefix}batchNo`] = t('stockDocs.errors.batchTooLong');
  });
  return errors;
}

/** 这张单是不是已经不是草稿（别处刚过账或作废）：这时把这一页重新读一遍。 */
export const isNotDraft = (error: unknown): boolean =>
  error instanceof ApiClientError && error.reason === 'STOCK_DOC_NOT_DRAFT';
