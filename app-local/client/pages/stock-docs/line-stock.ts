import { useApiClient } from '@nocobase/app-client';
import { useEffect, useMemo, useState } from 'react';

import type { EntityPage } from '#components/erp/list-state';

import type { Balance } from '../stock/client.js';

const SEPARATOR = '\u0000';
/** 现存量一个物料在一个仓库里的组合不会多，一页 100 条够用。 */
const PAGE_SIZE = 100;

/** 「物料|仓库|批号」→ 现存量。 */
export type LineStock = Readonly<Record<string, number>>;

export const stockKey = (
  line: { readonly itemId: string; readonly warehouseId: string; readonly batchNo: string },
): string => [line.itemId, line.warehouseId, line.batchNo].join(SEPARATOR);

/**
 * 出库草稿每一行旁边的现存量（《基座ERP前端设计》2.4；契约的行里没有现存量，页面按行查）。
 * 同一个「物料 + 仓库」只查一次，批号在结果里挑。`lines` 变了（改了数量、换了仓库）就重新查。
 */
export function useLineStock(
  lines: readonly {
    readonly itemId: string;
    readonly warehouseId: string;
    readonly batchNo: string;
  }[],
  enabled: boolean,
): { readonly key: string; readonly stock?: LineStock } {
  const api = useApiClient();
  // 「物料 + 仓库」去重后拼成一个串：内容不变时串不变，不会因为别处重渲染再去查一遍。
  const key = useMemo(
    () =>
      [
        ...new Set(
          lines
            .filter((line) => line.itemId && line.warehouseId)
            .map((line) => [line.itemId, line.warehouseId].join(SEPARATOR)),
        ),
      ].join('\u0001'),
    [lines],
  );
  const [result, setResult] = useState<{
    readonly key: string;
    readonly stock: LineStock;
  }>();
  useEffect(() => {
    if (!enabled || key === '') return;
    const pairs = key.split('\u0001');
    const controller = new AbortController();
    const read = async (
      pair: string,
    ): Promise<readonly (readonly [string, number])[]> => {
      const [itemId, warehouseId] = pair.split(SEPARATOR);
      const query = new URLSearchParams({
        itemId: itemId ?? '',
        warehouseId: warehouseId ?? '',
        page: '1',
        pageSize: String(PAGE_SIZE),
      });
      const page = await api.request<EntityPage<Balance>>({
        path: `stock/balances?${query.toString()}`,
        signal: controller.signal,
      });
      return page.items.map(
        (balance) => [stockKey(balance), balance.qty] as const,
      );
    };
    void Promise.all(pairs.map(read)).then(
      (groups) => {
        if (!controller.signal.aborted)
          setResult({ key, stock: Object.fromEntries(groups.flat()) });
      },
      () => {
        // 现存量没读下来：不挡住查看，只是先不显示；过账时以服务端的判断为准。
      },
    );
    return () => controller.abort();
  }, [api, key, enabled]);
  return result?.key === key ? result : { key };
}
