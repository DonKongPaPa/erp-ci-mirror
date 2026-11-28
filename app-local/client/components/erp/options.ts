/**
 * 单据表单共用的下拉来源（R-072）：业务字典取值、人员选项、部门选项。
 * 两个选项端点都是收窄过的：人员只回标识、姓名、部门标识与部门名称，
 * 不按邮箱、手机号、工号匹配，也不回这些列。调用方按 `bizDict.view` / `bizOptions.view`
 * 判断有没有资格取数，这里只负责取数与拼成选项。
 */
import { useApiClient } from '@nocobase/app-client';
import { useCallback, useEffect, useState } from 'react';

import type { EntityPage } from '#components/erp/list-state';

/** 下拉的一项。`disabled` 只让旧的停用取值仍显示得出名字。 */
export interface OptionChoice {
  readonly value: string;
  readonly label: string;
  readonly disabled?: boolean;
}

export interface OptionPage<T> {
  readonly items: readonly T[] | undefined;
  readonly error: unknown;
  readonly loading: boolean;
  readonly reload: () => void;
}

const PAGE_SIZE = 100;
/**
 * `person-options` 的 pageSize 上限是 20（R-072 的接口契约）。按 100 请求会 400，
 * 于是所有选人的下拉都取不到数；这里按端点上限分页。
 */
const PERSON_PAGE_SIZE = 20;
const MAX_PAGES = 10;

/** 把一个列表端点按页读完；`enabled` 为假时不发请求。 */
export function useOptionPage<T>(
  path: string,
  enabled: boolean,
  pageSize = PAGE_SIZE,
): OptionPage<T> {
  const api = useApiClient();
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState<{
    path: string;
    data?: T[];
    error?: unknown;
  }>({ path: '' });

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    const collected: T[] = [];
    const load = async (): Promise<void> => {
      const separator = path.includes('?') ? '&' : '?';
      for (let page = 1; page <= MAX_PAGES; page += 1) {
        const chunk = await api.request<EntityPage<T>>({
          path: `${path}${separator}page=${page}&pageSize=${pageSize}`,
          signal: controller.signal,
        });
        collected.push(...chunk.items);
        if (chunk.items.length === 0 || collected.length >= chunk.total) break;
      }
      if (!controller.signal.aborted) setResult({ path, data: collected });
    };
    void load().catch((error: unknown) => {
      if (!controller.signal.aborted) setResult({ path, error });
    });
    return () => controller.abort();
  }, [api, path, enabled, revision, pageSize]);

  const reload = useCallback(() => setRevision((value) => value + 1), []);
  const current = result.path === path;
  const data = current ? result.data : undefined;
  const error = current ? result.error : undefined;
  return {
    items: data,
    error,
    loading: enabled && data === undefined && error === undefined,
    reload,
  };
}

/** R-072 的字典取值；页面只用在用的，已停用且被老单据引用的由调用方补成不可选项。 */
export interface DictEntry {
  readonly id: string;
  readonly dictType: string;
  readonly code: string;
  readonly name: string;
  readonly rate: number | null;
  readonly isDefault: boolean;
  readonly sort: number;
}

export function useDictEntries(
  dictType: string,
  enabled: boolean,
): OptionPage<DictEntry> {
  return useOptionPage<DictEntry>(
    `biz-dict/entries?dictType=${encodeURIComponent(dictType)}&status=active`,
    enabled,
  );
}

/** 字典下拉：接口按 sort、code 升序，默认项在最前（R-072 的「设常用」）。 */
export function dictChoices(
  entries: readonly DictEntry[] | undefined,
): OptionChoice[] {
  return [...(entries ?? [])]
    .sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.sort - b.sort)
    .map((entry) => ({ value: entry.code, label: entry.name }));
}

/** 默认税率：有「设常用」的取它，否则取 sort 最小的一条（R-072 不变量 2）。 */
export function defaultDictCode(entries: readonly DictEntry[] | undefined): string {
  const sorted = [...(entries ?? [])].sort(
    (a, b) => Number(b.isDefault) - Number(a.isDefault) || a.sort - b.sort,
  );
  return sorted[0]?.code ?? '';
}

export interface PersonOption {
  readonly userId: string;
  readonly name: string;
  readonly departmentId: string | null;
  readonly departmentName: string | null;
}

export function usePersonOptions(enabled: boolean): OptionPage<PersonOption> {
  return useOptionPage<PersonOption>('person-options', enabled, PERSON_PAGE_SIZE);
}

export function personChoices(
  people: readonly PersonOption[] | undefined,
): OptionChoice[] {
  return (people ?? []).map((person) => ({
    value: person.userId,
    label: person.name,
  }));
}

/**
 * 单据详情已经带出的人/往来单位摘要，用它补下拉里缺的项。
 *
 * 选项端点只回在职员工、在用供应商；老单据引用的标识可能已经停用，或者暂时取不到选项。
 * 这时 Select 没有对应项就会把裸标识画给用户；把详情里的姓名/名称补成不可选项，
 * 人能看到是谁，又不会把一个停用对象当成新的可选项。
 */
export function withKnownChoices(
  choices: readonly OptionChoice[],
  known: readonly (OptionChoice | null | undefined)[],
): OptionChoice[] {
  const present = new Set(choices.map((choice) => choice.value));
  const extras = known.filter(
    (choice): choice is OptionChoice =>
      choice !== null && choice !== undefined && choice.value !== '' && !present.has(choice.value),
  );
  return [...choices, ...extras.map((choice) => ({ ...choice, disabled: true }))];
}

/** 详情里的 `handler` / `taker` 摘要转成一个补项。 */
export function personChoiceFrom(
  person: { readonly userId: string; readonly name: string } | null | undefined,
): OptionChoice | undefined {
  return person === null || person === undefined
    ? undefined
    : { value: person.userId, label: person.name };
}

/** 详情里的往来单位摘要转成一个补项；`code` 有值时和下拉的写法一致。 */
export function partnerChoiceFrom(
  partner:
    | { readonly id: string; readonly name: string; readonly code?: string | null }
    | null
    | undefined,
): OptionChoice | undefined {
  return partner === null || partner === undefined
    ? undefined
    : {
        value: partner.id,
        label: partner.code ? `${partner.code} ${partner.name}` : partner.name,
      };
}

export interface DepartmentOption {
  readonly id: string;
  readonly name: string;
}

export function useDepartmentOptions(
  enabled: boolean,
): OptionPage<DepartmentOption> {
  return useOptionPage<DepartmentOption>('department-options', enabled);
}

export function departmentChoices(
  departments: readonly DepartmentOption[] | undefined,
): OptionChoice[] {
  return (departments ?? []).map((one) => ({
    value: one.id,
    label: one.name,
  }));
}
