import { useMemo } from 'react';

import { useRecord } from '#components/erp/record';

import { toOrder, type OrderResponse } from './client.js';
import type { OrderKindDef } from './kinds.js';

/**
 * 读一张订单（详情、编辑前先读最新数据、生成出入库单的对话框）。
 * 共用的 `useRecord` 读回来的是端点的形状，这里换成页面共用的 `Order`；其余行为不变：
 * 被盖住时不去取，关掉时重新取一次；`enabled` 为 `false`（没有读的权限、或还没有 id）时不发请求。
 */
export function useOrder(def: OrderKindDef, id: string, enabled = true) {
  const request = useRecord<OrderResponse>(
    id ? `${def.api}/${encodeURIComponent(id)}` : '',
    enabled,
  );
  const raw = request.data;
  const data = useMemo(
    () => (raw === undefined ? undefined : toOrder(def, raw)),
    [def, raw],
  );
  return { ...request, data };
}
