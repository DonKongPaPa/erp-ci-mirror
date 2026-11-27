import { ApiClientError } from '@nocobase/app-client';

import type { FieldErrors } from '#components/erp/form-dialog';
import { serverMessage, type Translate } from '#components/erp/messages';

import type { Warehouse, WarehouseInput } from './client.js';

/** 仓库表单的值：编码、名称、备注都是文本。 */
export interface WarehouseFormValues {
  readonly code: string;
  readonly name: string;
  readonly note: string;
}

/** 短码的写法（R-020 `WAREHOUSE_INVALID`）：1–32 位大写字母、数字、连字符、下划线，以字母或数字开头。 */
export const WAREHOUSE_CODE = /^[A-Z0-9][A-Z0-9_-]{0,31}$/u;

export const EMPTY_WAREHOUSE_FORM: WarehouseFormValues = {
  code: '',
  name: '',
  note: '',
};

/** 编辑：原样带出这一座。 */
export const formOf = (warehouse: Warehouse): WarehouseFormValues => ({
  code: warehouse.code,
  name: warehouse.name,
  note: warehouse.note,
});

/** 表单的值 → 请求体（新建）。调用前一定先过 `validateWarehouseForm`。 */
export const inputOf = (values: WarehouseFormValues): WarehouseInput => ({
  code: values.code.trim(),
  name: values.name.trim(),
  note: values.note.trim(),
});

/**
 * 提交时才校验，规则与 R-020 一致：短码的写法、名称 1–128 个字符、备注最多 500 个字符。
 * 错误标在对应的那一项下面。编辑时编码不可改，不校验它。
 */
export function validateWarehouseForm(
  values: WarehouseFormValues,
  t: Translate,
  withCode: boolean,
): FieldErrors {
  const errors: Record<string, string | undefined> = {};
  const required = t('erp.form.required');
  if (withCode) {
    const code = values.code.trim();
    if (!code) errors.code = required;
    else if (!WAREHOUSE_CODE.test(code)) errors.code = t('warehouses.errors.invalidCode');
  }
  const name = values.name.trim();
  if (!name) errors.name = required;
  else if ([...name].length > 128) errors.name = t('warehouses.errors.invalidName');
  if ([...values.note.trim()].length > 500) errors.note = t('warehouses.errors.noteTooLong');
  return errors;
}

/** 服务端的规则码落到哪一项下面：短码重复就把光标放到短码上。提示用服务端翻好的那句话。 */
export function warehouseFieldErrors(error: unknown): FieldErrors {
  if (!(error instanceof ApiClientError)) return {};
  switch (error.reason) {
    case 'WAREHOUSE_CODE_EXISTS':
    case 'WAREHOUSE_INVALID':
      return { code: serverMessage(error) };
    default:
      return {};
  }
}
