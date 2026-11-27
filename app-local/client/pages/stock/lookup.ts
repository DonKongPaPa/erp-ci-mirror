import { useApiClient } from '@nocobase/app-client';
import { useCallback, useEffect, useMemo, useState } from 'react';

import type { EntityPage } from '#components/erp/list-state';

import type { Warehouse } from '../warehouses/client.js';

/** R-019 的业务资源：读要 items.view。 */
export const ITEMS_RESOURCE = { type: 'composite', id: 'items' } as const;

/**
 * 现存量、流水、单据明细的行里只有 `itemId`、`warehouseId`（《基座ERP前端设计》第六节第 2 条）。
 * 页面另取物料与仓库两个列表来对名字；每个列表按 100 条一页往下翻，最多 10 页。
 * 没有读的权限时不发请求，页面照实显示标识。
 */
export interface ItemSummary {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly spec: string | null;
  readonly itemType: string;
  readonly categoryCode: string | null;
  readonly unitCode: string;
  readonly status: 'active' | 'inactive';
}

const PAGE_SIZE = 100;
const MAX_PAGES = 10;
const EMPTY: readonly never[] = [];

interface Loaded<T> {
  readonly path: string;
  readonly rows?: readonly T[];
  readonly failed?: boolean;
}

function useAll<T>(path: string, enabled: boolean): Loaded<T> {
  const api = useApiClient();
  const [state, setState] = useState<Loaded<T>>({ path });
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    const run = async (): Promise<void> => {
      const rows: T[] = [];
      try {
        for (let page = 1; page <= MAX_PAGES; page += 1) {
          const query = new URLSearchParams({
            page: String(page),
            pageSize: String(PAGE_SIZE),
          });
          const result = await api.request<EntityPage<T>>({
            path: `${path}?${query.toString()}`,
            signal: controller.signal,
          });
          rows.push(...result.items);
          if (rows.length >= result.total || result.items.length === 0)
            break;
        }
        if (!controller.signal.aborted) setState({ path, rows });
      } catch {
        if (!controller.signal.aborted) setState({ path, failed: true });
      }
    };
    void run();
    return () => controller.abort();
  }, [api, path, enabled]);
  return enabled && state.path === path ? state : { path };
}

/** 物料在下拉里的文字：编码加名称。 */
export const itemLabel = (item: ItemSummary): string =>
  `${item.code} ${item.name}`;

const loading = <T,>(list: Loaded<T>, enabled: boolean): boolean =>
  enabled && list.rows === undefined && !list.failed;

export function useInventoryLookup({
  items,
  warehouses,
}: {
  /** 有 items.view 才取物料。 */
  readonly items: boolean;
  /** 有 inventory.warehouseView 才取仓库。 */
  readonly warehouses: boolean;
}) {
  const itemList = useAll<ItemSummary>('items', items);
  const warehouseList = useAll<Warehouse>('warehouses', warehouses);
  const itemRows = itemList.rows;
  const warehouseRows = warehouseList.rows;
  const itemMap = useMemo(
    () => new Map((itemRows ?? EMPTY).map((row) => [row.id, row] as const)),
    [itemRows],
  );
  const warehouseMap = useMemo(
    () =>
      new Map(
        (warehouseRows ?? EMPTY).map((row) => [row.id, row] as const),
      ),
    [warehouseRows],
  );
  const item = useCallback((id: string) => itemMap.get(id), [itemMap]);
  const warehouse = useCallback(
    (id: string) => warehouseMap.get(id),
    [warehouseMap],
  );
  const pending =
    loading(itemList, items) || loading(warehouseList, warehouses);
  const denied = Boolean(itemList.failed || warehouseList.failed);
  const itemsAll = itemRows ?? EMPTY;
  const warehousesAll = warehouseRows ?? EMPTY;
  return useMemo(
    () => ({
      /** 取到的全部物料（含已停用的，老单据还要对出名字）。 */
      items: itemsAll,
      /** 取到的全部仓库。 */
      warehouses: warehousesAll,
      item,
      warehouse,
      /** 还在对名字：这会儿先不画行，免得先闪一下标识。 */
      pending,
      /** 有一个列表没读下来（没有权限或请求失败）。 */
      denied,
    }),
    [itemsAll, warehousesAll, item, warehouse, pending, denied],
  );
}
