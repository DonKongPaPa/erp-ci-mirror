import type { ApiClient } from '@nocobase/app-client';
import type { EntityPage } from '#components/erp/list-state';

export type WarehouseStatus = 'active' | 'inactive';

/** 一座仓库，与 R-020 的 `Warehouse` 逐列对应。编码是人填的短码，仓库不发号。 */
export interface Warehouse {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly status: WarehouseStatus;
  readonly note: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface WarehouseInput {
  readonly code: string;
  readonly name: string;
  readonly note?: string;
}

/** 编码不在里面：带了会被拒（`WAREHOUSE_CODE_IMMUTABLE`）。停用与启用也是它：`{ status }`。 */
export interface WarehouseUpdate {
  readonly name?: string;
  readonly status?: WarehouseStatus;
  readonly note?: string;
}

export interface WarehouseListQuery {
  readonly status?: WarehouseStatus;
  readonly q?: string;
  readonly page?: number;
  readonly pageSize?: number;
}

/** R-020 的仓库三个端点。端点直接回一座仓库或一页，没有 `{ data }` 外层。 */
export class WarehousesClient {
  constructor(private readonly api: ApiClient) {}

  list(query: WarehouseListQuery = {}): Promise<EntityPage<Warehouse>> {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== '') search.set(key, String(value));
    }
    return this.api.request<EntityPage<Warehouse>>({
      path: `warehouses?${search.toString()}`,
    });
  }

  get(id: string): Promise<Warehouse> {
    return this.api.request<Warehouse>({
      path: `warehouses/${encodeURIComponent(id)}`,
    });
  }

  create(input: WarehouseInput): Promise<Warehouse> {
    return this.api.request<Warehouse>({
      path: 'warehouses',
      method: 'POST',
      json: input,
    });
  }

  update(id: string, input: WarehouseUpdate): Promise<Warehouse> {
    return this.api.request<Warehouse>({
      path: `warehouses/${encodeURIComponent(id)}`,
      method: 'PATCH',
      json: input,
    });
  }
}
