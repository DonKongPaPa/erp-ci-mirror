import type { ApiClient } from '@nocobase/app-client';
import type { EntityPage } from '#components/erp/list-state';

/** 一条班次，与 R-025 的 `Shift` 逐列对应。跨天、休息时长由前端从起止算，响应里没有。 */
export interface Shift {
  readonly id: string;
  readonly title: string;
  readonly startMinute: number;
  readonly endMinute: number;
  readonly breakStartMinute: number | null;
  readonly breakEndMinute: number | null;
  readonly active: boolean;
  readonly sortOrder: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ShiftInput {
  readonly id: string;
  readonly title: string;
  readonly startMinute: number;
  readonly endMinute: number;
  readonly breakStartMinute?: number;
  readonly breakEndMinute?: number;
  readonly sortOrder?: number;
}

/** R-025 的六个端点。端点直接回一条班次或一页，没有 `{ data }` 外层。 */
export class ShiftsClient {
  constructor(private readonly api: ApiClient) {}

  list(query: {
    page?: number;
    pageSize?: number;
    includeInactive?: boolean;
  }): Promise<EntityPage<Shift>> {
    const search = new URLSearchParams();
    if (query.page !== undefined) search.set('page', String(query.page));
    if (query.pageSize !== undefined)
      search.set('pageSize', String(query.pageSize));
    if (query.includeInactive) search.set('includeInactive', 'true');
    return this.api.request<EntityPage<Shift>>({
      path: `shifts?${search.toString()}`,
    });
  }

  get(id: string): Promise<Shift> {
    return this.api.request<Shift>({
      path: `shifts/${encodeURIComponent(id)}`,
    });
  }

  create(input: ShiftInput): Promise<Shift> {
    return this.api.request<Shift>({
      path: 'shifts',
      method: 'POST',
      json: input,
    });
  }

  /** 只有名称与排序能改；带了编码或时间服务端会拒（`SHIFT_FIELD_IMMUTABLE`）。 */
  update(
    id: string,
    input: { title?: string; sortOrder?: number },
  ): Promise<Shift> {
    return this.api.request<Shift>({
      path: `shifts/${encodeURIComponent(id)}`,
      method: 'PATCH',
      json: input,
    });
  }

  deactivate(id: string): Promise<Shift> {
    return this.api.request<Shift>({
      path: `shifts/${encodeURIComponent(id)}/deactivate`,
      method: 'POST',
    });
  }

  activate(id: string): Promise<Shift> {
    return this.api.request<Shift>({
      path: `shifts/${encodeURIComponent(id)}/activate`,
      method: 'POST',
    });
  }
}
