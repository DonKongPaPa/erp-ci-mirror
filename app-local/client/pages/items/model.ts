import { ApiClientError, createUuid } from '@nocobase/app-client';

import type { FieldErrors } from '#components/erp/form-dialog';
import { serverMessage, type Translate } from '#components/erp/messages';

import type {
  Category,
  CreateCategoryInput,
  CreateItemInput,
  CreateUnitInput,
  ItemType,
  Item,
  Unit,
  UpdateCategoryInput,
  UpdateItemInput,
  UpdateUnitInput,
} from './client.js';
import { dictionaryOptions, type ItemDictionaries } from './dictionaries.js';
import type { FormOption } from './form-parts.js';

/** 上级分类下拉框里「根分类」的值：契约收的是 `parentId: null`。 */
export const NO_PARENT = '__none__';

/**
 * 上级分类的选项：在用的根分类（第一版只有一层），不含自己；当前的上级不在里面（已停用）时也留下它，
 * 免得下拉框对不上当前值。
 */
export function parentOptions(
  dictionaries: ItemDictionaries,
  self: string | undefined,
  current: string,
  t: Translate,
): FormOption[] {
  // 选项的值是上级分类的 id（契约的 parentId），不是编码。
  const parents: FormOption[] = dictionaries.categories
    .filter(
      (entry) =>
        entry.id !== self &&
        (entry.id === current ||
          (entry.parentId === null && entry.status === 'active')),
    )
    .map((entry) => ({
      value: entry.id,
      label: dictionaryOptions([entry], t)[0].label,
    }));
  // 当前的上级不在字典里（超过第一页）时也留下它，看得见当前值。
  if (current && !parents.some((option) => option.value === current))
    parents.push({ value: current, label: current });
  return [
    { value: NO_PARENT, label: t('items.categories.noParent') },
    ...parents,
  ];
}

/** 可填可不填的文本：去掉首尾空白，空的就是 `null`。 */
export const optional = (text: string): string | null => {
  const value = text.trim();
  return value ? value : null;
};

/** 长度上限与服务端一致（R-019 的请求体）：超了服务端回 400，这里在提交时就标出来。 */
export const ITEM_NAME_MAX = 128;
export const DICTIONARY_NAME_MAX = 64;
export const UNIT_CODE_MAX = 16;
export const CATEGORY_CODE_MAX = 32;
export const SPEC_MAX = 128;
export const LEGACY_CODE_MAX = 64;
export const NOTE_MAX = 2000;

const lengthOf = (text: string): number => [...text].length;

export const itemTypeLabel = (type: ItemType, t: Translate): string =>
  type === 'material'
    ? t('items.itemType.material')
    : t('items.itemType.product');

/** 提示里怎么叫这一条：物料，或产品。 */
export const itemNoun = (type: ItemType, t: Translate): string =>
  type === 'material' ? t('items.noun.material') : t('items.noun.product');

/* ---------- 物料 ---------- */

export interface ItemFormValues {
  readonly name: string;
  readonly itemType: ItemType;
  readonly spec: string;
  /** 空串表示没有分类。 */
  readonly categoryCode: string;
  readonly unitCode: string;
  readonly legacyCode: string;
  readonly note: string;
}

export const EMPTY_ITEM_FORM: ItemFormValues = {
  name: '',
  itemType: 'material',
  spec: '',
  categoryCode: '',
  unitCode: '',
  legacyCode: '',
  note: '',
};

export const itemFormOf = (item: Item): ItemFormValues => ({
  name: item.name,
  itemType: item.itemType,
  spec: item.spec ?? '',
  categoryCode: item.categoryCode ?? '',
  unitCode: item.unitCode,
  legacyCode: item.legacyCode ?? '',
  note: item.note ?? '',
});

/** 表单的值 → 请求体，新建与编辑同一个形状（编码不在里面）。调用前一定先过 `validateItem`。 */
export function itemInput(
  values: ItemFormValues,
): CreateItemInput & UpdateItemInput {
  return {
    name: values.name.trim(),
    itemType: values.itemType,
    unitCode: values.unitCode,
    spec: optional(values.spec),
    categoryCode: optional(values.categoryCode),
    legacyCode: optional(values.legacyCode),
    note: optional(values.note),
  };
}

/** 提交时才校验：名称、基本单位必填，各文本不超长。错误标在对应的那一项下面。 */
export function validateItem(
  values: ItemFormValues,
  t: Translate,
): FieldErrors {
  const errors: Record<string, string | undefined> = {};
  const name = values.name.trim();
  if (!name) errors.name = t('erp.form.required');
  else if (lengthOf(name) > ITEM_NAME_MAX)
    errors.name = t('items.errors.invalidName', { max: ITEM_NAME_MAX });
  if (!values.unitCode) errors.unitCode = t('erp.form.required');
  const limit = (text: string, max: number): string | undefined =>
    lengthOf(text.trim()) > max
      ? t('items.errors.tooLong', { max })
      : undefined;
  return {
    ...errors,
    spec: limit(values.spec, SPEC_MAX),
    legacyCode: limit(values.legacyCode, LEGACY_CODE_MAX),
    note: limit(values.note, NOTE_MAX),
  };
}

/** 服务端的规则码落到哪一项下面；提示用服务端翻好的那句话。 */
export function itemFieldErrors(error: unknown): FieldErrors {
  if (!(error instanceof ApiClientError)) return {};
  switch (error.reason) {
    case 'UNIT_INACTIVE':
      return { unitCode: serverMessage(error) };
    case 'CATEGORY_INACTIVE':
      return { categoryCode: serverMessage(error) };
    default:
      return {};
  }
}

/* ---------- 计量单位 ---------- */

export interface UnitFormValues {
  readonly code: string;
  readonly name: string;
  /** 整数的字符串；空的就是 0。 */
  readonly decimals: string;
}

export const EMPTY_UNIT_FORM: UnitFormValues = {
  code: '',
  name: '',
  decimals: '0',
};

export const unitFormOf = (unit: Unit): UnitFormValues => ({
  code: unit.code,
  name: unit.name,
  decimals: String(unit.decimals),
});

/** 小数位：0–10 的整数，不填按 0；写得不合规返回 `undefined`。 */
export function parseDecimals(text: string): number | undefined {
  const value = text.trim();
  if (!value) return 0;
  if (!/^\d{1,2}$/u.test(value)) return undefined;
  const number = Number(value);
  return number <= 10 ? number : undefined;
}

export function validateUnit(
  values: UnitFormValues,
  t: Translate,
  withCode: boolean,
): FieldErrors {
  const errors: Record<string, string | undefined> = {};
  if (withCode) {
    const code = values.code.trim();
    if (!code) errors.code = t('erp.form.required');
    else if (lengthOf(code) > UNIT_CODE_MAX)
      errors.code = t('items.units.errors.invalidCode', { max: UNIT_CODE_MAX });
  }
  const name = values.name.trim();
  if (!name) errors.name = t('erp.form.required');
  else if (lengthOf(name) > DICTIONARY_NAME_MAX)
    errors.name = t('items.units.errors.invalidName', {
      max: DICTIONARY_NAME_MAX,
    });
  if (parseDecimals(values.decimals) === undefined)
    errors.decimals = t('items.units.errors.invalidDecimals');
  return errors;
}

export function unitCreateInput(values: UnitFormValues): CreateUnitInput {
  return {
    code: values.code.trim(),
    name: values.name.trim(),
    decimals: parseDecimals(values.decimals) ?? 0,
  };
}

export function unitUpdateInput(values: UnitFormValues): UpdateUnitInput {
  return {
    name: values.name.trim(),
    decimals: parseDecimals(values.decimals) ?? 0,
  };
}

export function unitFieldErrors(error: unknown): FieldErrors {
  if (!(error instanceof ApiClientError)) return {};
  switch (error.reason) {
    case 'UNIT_CODE_TAKEN':
      // 编码重复：光标落到编码上。
      return { code: serverMessage(error) };
    default:
      return {};
  }
}

/* ---------- 物料分类 ---------- */

export interface CategoryFormValues {
  readonly code: string;
  readonly name: string;
  /** 上级分类的 id；空串表示根分类。 */
  readonly parentId: string;
}

export const EMPTY_CATEGORY_FORM: CategoryFormValues = {
  code: '',
  name: '',
  parentId: '',
};

export const categoryFormOf = (category: Category): CategoryFormValues => ({
  code: category.code,
  name: category.name,
  parentId: category.parentId ?? '',
});

export function validateCategory(
  values: CategoryFormValues,
  t: Translate,
  withCode: boolean,
): FieldErrors {
  const errors: Record<string, string | undefined> = {};
  if (withCode) {
    const code = values.code.trim();
    if (!code) errors.code = t('erp.form.required');
    else if (lengthOf(code) > CATEGORY_CODE_MAX)
      errors.code = t('items.categories.errors.invalidCode', {
        max: CATEGORY_CODE_MAX,
      });
  }
  const name = values.name.trim();
  if (!name) errors.name = t('erp.form.required');
  else if (lengthOf(name) > DICTIONARY_NAME_MAX)
    errors.name = t('items.categories.errors.invalidName', {
      max: DICTIONARY_NAME_MAX,
    });
  return errors;
}

/** 新建：`id` 由调用方生成（契约要前端给 UUID），`parentId: null` 表示根。 */
export function categoryCreateInput(
  values: CategoryFormValues,
  id: string,
): CreateCategoryInput {
  return {
    id,
    code: values.code.trim(),
    name: values.name.trim(),
    parentId: values.parentId || null,
  };
}

export function categoryUpdateInput(
  values: CategoryFormValues,
): UpdateCategoryInput {
  return { name: values.name.trim(), parentId: values.parentId || null };
}

export function categoryFieldErrors(error: unknown): FieldErrors {
  if (!(error instanceof ApiClientError)) return {};
  switch (error.reason) {
    case 'CATEGORY_CODE_TAKEN':
      return { code: serverMessage(error) };
    case 'CATEGORY_INVALID_PARENT':
      return { parentId: serverMessage(error) };
    default:
      return {};
  }
}

/**
 * 生成一条记录的 id（契约要前端给物料分类的 UUID）。用框架现成的 `createUuid`：
 * 它走 `getRandomValues`，内网 http（非安全上下文）下也拿得到同样形状的 v4。
 */
export function randomId(): string {
  return createUuid();
}
