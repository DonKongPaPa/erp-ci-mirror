import { ApiClientError } from '@nocobase/app-client';

import type { FieldErrors } from '#components/erp/form-dialog';
import { serverMessage, type Translate } from '#components/erp/messages';

import type {
  CreateEntryBody,
  Entry,
  UpdateEntryBody,
} from './client.js';

/** 税率才填 rate；项目才填起止日期与描述。其余类型带上这些键服务端会回 422。 */
export const usesRate = (dictType: string): boolean => dictType === 'tax_rate';
export const usesProjectFields = (dictType: string): boolean =>
  dictType === 'project';

/** 可填可不填的文本：空的就是 `null`（编辑时清空要用 null，不是空串）。 */
const optional = (text: string): string | null => {
  const value = text.trim();
  return value ? value : null;
};

const lengthOf = (text: string): number => [...text].length;

export const NAME_MAX = 128;
export const CODE_MAX = 64;
export const DESCRIPTION_MAX = 4000;

export interface EntryFormValues {
  readonly code: string;
  readonly name: string;
  /** 字符串，空表示没有值；提交时才转成数字或 null。 */
  readonly rate: string;
  readonly startDate: string;
  readonly endDate: string;
  readonly description: string;
  readonly isDefault: boolean;
  readonly sort: string;
}

export const EMPTY_ENTRY_FORM: EntryFormValues = {
  code: '',
  name: '',
  rate: '',
  startDate: '',
  endDate: '',
  description: '',
  isDefault: false,
  sort: '0',
};

export const entryFormOf = (entry: Entry): EntryFormValues => ({
  code: entry.code,
  name: entry.name,
  rate: entry.rate === null ? '' : String(entry.rate),
  startDate: entry.startDate ?? '',
  endDate: entry.endDate ?? '',
  description: entry.description ?? '',
  isDefault: entry.isDefault,
  sort: String(entry.sort),
});

/** 数字字段：空的是 undefined（新建不带键）/ null（编辑清空），不合规返回 undefined。 */
export function parseRate(text: string): number | undefined | null {
  const value = text.trim();
  if (!value) return undefined;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 && number <= 100
    ? number
    : undefined;
}

export function parseSort(text: string): number | undefined {
  const value = text.trim();
  if (!value) return 0;
  if (!/^\d{1,9}$/u.test(value)) return undefined;
  return Number(value);
}

/** 新建的请求体：只带适用的键，不拿空值占位（服务端本来就不回没有的动作列）。 */
export function entryCreateInput(
  values: EntryFormValues,
  dictType: string,
): CreateEntryBody {
  const rate = usesRate(dictType) ? parseRate(values.rate) : undefined;
  return {
    dictType,
    code: values.code.trim(),
    name: values.name.trim(),
    ...(rate === undefined || rate === null ? {} : { rate }),
    ...(usesProjectFields(dictType) && values.startDate
      ? { startDate: values.startDate }
      : {}),
    ...(usesProjectFields(dictType) && values.endDate
      ? { endDate: values.endDate }
      : {}),
    ...(usesProjectFields(dictType) && values.description.trim()
      ? { description: values.description.trim() }
      : {}),
    ...(values.isDefault ? { isDefault: true } : {}),
    ...((parseSort(values.sort) ?? 0) !== 0
      ? { sort: parseSort(values.sort) }
      : {}),
  };
}

/** 编辑的请求体：清空传 null；码与类型不带（服务端会拒），停用启用走单独的 status。 */
export function entryUpdateInput(
  values: EntryFormValues,
  dictType: string,
): UpdateEntryBody {
  const rate = usesRate(dictType) ? parseRate(values.rate) : undefined;
  return {
    name: values.name.trim(),
    ...(usesRate(dictType)
      ? { rate: rate === undefined ? null : rate }
      : {}),
    ...(usesProjectFields(dictType)
      ? { startDate: optional(values.startDate) }
      : {}),
    ...(usesProjectFields(dictType)
      ? { endDate: optional(values.endDate) }
      : {}),
    ...(usesProjectFields(dictType)
      ? { description: optional(values.description) }
      : {}),
    isDefault: values.isDefault,
    sort: parseSort(values.sort) ?? 0,
  };
}

const DATE = /^\d{4}-\d{2}-\d{2}$/u;

/** 提交时才校验：码、名称必填；税率的数、项目的日期、排序各有范围。 */
export function validateEntry(
  values: EntryFormValues,
  dictType: string,
  t: Translate,
): FieldErrors {
  const errors: Record<string, string | undefined> = {};
  const code = values.code.trim();
  if (!code) errors.code = t('erp.form.required');
  else if (lengthOf(code) > CODE_MAX || !/^[A-Za-z0-9_-]+$/u.test(code))
    errors.code = t('bizDict.errors.invalidCode');
  if (!values.name.trim()) errors.name = t('erp.form.required');
  else if (lengthOf(values.name.trim()) > NAME_MAX)
    errors.name = t('bizDict.errors.invalidName', { max: NAME_MAX });
  if (usesRate(dictType) && values.rate.trim() && parseRate(values.rate) === undefined)
    errors.rate = t('bizDict.errors.invalidRate');
  if (usesProjectFields(dictType)) {
    if (values.startDate && !DATE.test(values.startDate))
      errors.startDate = t('bizDict.errors.invalidDate');
    if (values.endDate && !DATE.test(values.endDate))
      errors.endDate = t('bizDict.errors.invalidDate');
    if (
      values.startDate && values.endDate &&
      DATE.test(values.startDate) && DATE.test(values.endDate) &&
      values.endDate < values.startDate
    )
      errors.endDate = t('bizDict.errors.invalidPeriod');
    if (lengthOf(values.description) > DESCRIPTION_MAX)
      errors.description = t('bizDict.errors.invalidDescription', {
        max: DESCRIPTION_MAX,
      });
  }
  if (parseSort(values.sort) === undefined)
    errors.sort = t('bizDict.errors.invalidSort');
  return errors;
}

/** 服务端的规则码落到哪一项下面；提示用服务端翻好的那句话。 */
export function entryFieldErrors(error: unknown): FieldErrors {
  if (!(error instanceof ApiClientError)) return {};
  switch (error.reason) {
    case 'DICT_CODE_TAKEN':
      return { code: serverMessage(error) };
    case 'DICT_VALUE_INVALID':
      return { rate: serverMessage(error) };
    default:
      return {};
  }
}
