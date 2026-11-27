import type { ApiClient } from '@nocobase/app-client';
import type { EntityPage } from '#components/erp/list-state';

/** R-072 首批九个类型；标签文字由 `/biz-dict/types` 给，这里只用来校验地址栏里的类型。 */
export const DICT_TYPES = [
  'project',
  'settlement',
  'supplier_group',
  'customer_group',
  'income_type',
  'expense_type',
  'invoice_type',
  'tax_rate',
  'fund_account',
] as const;

export type EntryStatus = 'active' | 'inactive';

/** 一条字典取值，与 R-072 的 `Entry` 逐列对应；建单人标识服务端不回。 */
export interface Entry {
  readonly id: string;
  readonly dictType: string;
  readonly code: string;
  readonly name: string;
  readonly rate: number | null;
  readonly startDate: string | null;
  readonly endDate: string | null;
  readonly description: string | null;
  readonly isDefault: boolean;
  readonly sort: number;
  readonly status: EntryStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface DictTypeItem {
  readonly dictType: string;
  readonly label: string;
}

export interface EntryListQuery {
  readonly dictType: string;
  readonly status?: EntryStatus;
  readonly q?: string;
  readonly page?: number;
  readonly pageSize?: number;
}

/** 码与类型建成后不可改，`id` 与时间戳由服务端写。额外列只给适用的类型。 */
export interface CreateEntryBody {
  readonly dictType: string;
  readonly code: string;
  readonly name: string;
  readonly rate?: number;
  readonly startDate?: string;
  readonly endDate?: string;
  readonly description?: string;
  readonly isDefault?: boolean;
  readonly sort?: number;
}

export interface UpdateEntryBody {
  readonly name?: string;
  readonly rate?: number | null;
  readonly startDate?: string | null;
  readonly endDate?: string | null;
  readonly description?: string | null;
  readonly isDefault?: boolean;
  readonly sort?: number;
  readonly status?: EntryStatus;
}

function searchOf(query: object): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== '') search.set(key, String(value));
  }
  return search.toString();
}

/** R-072 的五个字典端点：类型、列表、建、改、整组排序。没有删除，停任用 PATCH status。 */
export class BizDictClient {
  constructor(private readonly api: ApiClient) {}

  types(): Promise<{ items: readonly DictTypeItem[] }> {
    return this.api.request<{ items: readonly DictTypeItem[] }>({
      path: 'biz-dict/types',
    });
  }

  list(query: EntryListQuery): Promise<EntityPage<Entry>> {
    return this.api.request<EntityPage<Entry>>({
      path: `biz-dict/entries?${searchOf(query)}`,
    });
  }

  create(input: CreateEntryBody): Promise<Entry> {
    return this.api.request<Entry>({
      path: 'biz-dict/entries',
      method: 'POST',
      json: input,
    });
  }

  update(id: string, input: UpdateEntryBody): Promise<Entry> {
    return this.api.request<Entry>({
      path: `biz-dict/entries/${encodeURIComponent(id)}`,
      method: 'PATCH',
      json: input,
    });
  }

  /** 按给定顺序重写 sort；只用在用的行，请求体不夹带别的键。 */
  reorder(
    dictType: string,
    ids: readonly string[],
  ): Promise<{ items: readonly Entry[] }> {
    return this.api.request<{ items: readonly Entry[] }>({
      path: 'biz-dict/entries/reorder',
      method: 'POST',
      json: { dictType, ids: [...ids] },
    });
  }
}
