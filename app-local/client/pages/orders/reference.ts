import { useApiClient } from '@nocobase/app-client';
import { useCallback, useEffect, useState } from 'react';

import type { EntityPage } from '#components/erp/list-state';

/**
 * 订单页面要用的三份档案：物料（R-019）、往来单位（R-014）、仓库（R-020）。
 * 订单的明细行只有 `itemId`，表头自带往来单位摘要；选物料、选仓库、对物料的名字都要另取列表。
 */

/** 一条物料，与 R-019 的 `Item` 对应；建单人标识不取。 */
export interface Item {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly spec: string | null;
  readonly itemType: 'material' | 'product';
  readonly categoryCode: string | null;
  readonly unitCode: string;
  readonly status: 'active' | 'inactive';
}

/** 往来单位列表行里页面用得到的三列。 */
export interface PartnerOption {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly status: 'active' | 'inactive';
}

export interface WarehouseOption {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly status: 'active' | 'inactive';
}

/** 下拉选择的一个选项。 */
export interface Choice {
  readonly value: string;
  readonly label: string;
  readonly disabled?: boolean;
}

/** 选物料用的选项：「编码 名称」；停用的物料列出来但选不了（编辑时已有的行要显示名字）。 */
export function itemChoices(
  items: readonly Item[],
  inactiveLabel: string,
): Choice[] {
  return items.map((item) => ({
    value: item.id,
    label:
      `${item.code} ${item.name}` +
      (item.status === 'active' ? '' : ` (${inactiveLabel})`),
    disabled: item.status !== 'active',
  }));
}

const PAGE_SIZE = 100;
/** 最多读十页（一千条）：再多就只对得上前面这些的名字，记在合并请求的「MVP 后再修」里。 */
const MAX_PAGES = 10;

export interface ReferencePage<T> {
  /** 还没读到或是读失败时是 `undefined`。 */
  readonly items: readonly T[] | undefined;
  readonly error: unknown;
  readonly loading: boolean;
  readonly reload: () => void;
}

/**
 * 把一个列表端点按页读完。`enabled` 为 `false`（没有读的权限）时不发请求。
 * 端点没有「按 id 取一批」的参数，只能整份读回来在页面上对名字。
 */
export function useReferencePage<T>(
  path: string,
  enabled: boolean,
): ReferencePage<T> {
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
          path: `${path}${separator}page=${page}&pageSize=${PAGE_SIZE}`,
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
  }, [api, path, enabled, revision]);

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
