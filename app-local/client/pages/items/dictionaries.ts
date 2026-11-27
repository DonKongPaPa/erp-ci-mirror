import type { Translate } from '#components/erp/messages';
import type { EntityPage } from '#components/erp/list-state';
import { useListData } from '#hooks/use-list-data';

import type { Category, ItemStatus, Unit } from './client.js';

/**
 * 字典只取第一页：端点的 `pageSize` 上限是 100，超过的单位与分类在这里对不出名字，
 * 页面退到只显示编码。
 */
const FIRST_PAGE = 'page=1&pageSize=100';

export interface ItemDictionaries {
  readonly units: readonly Unit[];
  readonly categories: readonly Category[];
}

/**
 * 计量单位与物料分类两本字典：列表里把编码换成名字，表单与筛选的选项也从这里出。
 * 不带 `status`，在用的、停用的都取，停用的记录才对得出名字；只给有 `items.view` 的人取。
 * 返回的形状与 `RecordRoute` 要的一致：读到之前 `data` 是 `undefined`。
 */
export function useItemDictionaries(enabled: boolean, pending = false) {
  const active = enabled && !pending;
  const units = useListData<EntityPage<Unit>>(`units?${FIRST_PAGE}`, {
    active,
  });
  const categories = useListData<EntityPage<Category>>(
    `item-categories?${FIRST_PAGE}`,
    { active },
  );
  const data: ItemDictionaries | undefined =
    units.data !== undefined && categories.data !== undefined
      ? { units: units.data.items, categories: categories.data.items }
      : undefined;
  return {
    data,
    error: units.error ?? categories.error,
    loading: units.loading || categories.loading,
    reload: () => {
      units.reload();
      categories.reload();
    },
  };
}

/** 列表里的单位：显示名称，字典里对不出时只剩编码。 */
export function unitName(
  dictionaries: ItemDictionaries | undefined,
  code: string,
): string {
  return dictionaries?.units.find((entry) => entry.code === code)?.name ?? code;
}

/** 列表里的分类：显示名称；没有分类（`null`）返回 `null`，由格子画「—」。 */
export function categoryName(
  dictionaries: ItemDictionaries | undefined,
  code: string | null,
): string | null {
  if (code === null) return null;
  return (
    dictionaries?.categories.find((entry) => entry.code === code)?.name ?? code
  );
}

/**
 * 上级分类：显示名称；字典里对不出时显示 id 本身，不画成「没有上级」。
 */
export function parentName(
  dictionaries: ItemDictionaries | undefined,
  parentId: string | null,
): string | null {
  if (parentId === null) return null;
  return (
    dictionaries?.categories.find((entry) => entry.id === parentId)?.name ??
    parentId
  );
}

export interface DictionaryOption {
  readonly value: string;
  readonly label: string;
}

/** 「名称（编码）」；字典里对不出名字时只剩编码。 */
export function codedLabel(
  dictionaries: ItemDictionaries | undefined,
  kind: 'units' | 'categories',
  code: string,
  t: Translate,
): string {
  const name =
    kind === 'units'
      ? unitName(dictionaries, code)
      : categoryName(dictionaries, code);
  return name === null || name === code
    ? code
    : t('items.withCode', { name, code });
}

/** 抽屉与下拉框里的单位：「名称（编码）」。 */
export function unitLabel(
  dictionaries: ItemDictionaries | undefined,
  code: string,
  t: Translate,
): string {
  return codedLabel(dictionaries, 'units', code, t);
}

/** 抽屉里的分类；没有分类（`null`）返回 `null`，由详情画「—」。 */
export function categoryLabel(
  dictionaries: ItemDictionaries | undefined,
  code: string | null,
  t: Translate,
): string | null {
  return code === null ? null : codedLabel(dictionaries, 'categories', code, t);
}

/**
 * 一本字典整页当选项（下拉框与筛选用）：编码当值，已停用的在后面标明。
 * 调用方自己挑在用的；当前值已停用时也要留下它，免得下拉框对不上当前值。
 */
export function dictionaryOptions(
  entries: readonly {
    readonly code: string;
    readonly name: string;
    readonly status: ItemStatus;
  }[],
  t: Translate,
): DictionaryOption[] {
  return entries.map((entry) => ({
    value: entry.code,
    label:
      entry.status === 'active'
        ? t('items.withCode', { name: entry.name, code: entry.code })
        : t('items.form.inactiveOption', {
            label: t('items.withCode', { name: entry.name, code: entry.code }),
          }),
  }));
}
