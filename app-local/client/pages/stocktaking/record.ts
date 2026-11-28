import { useRecord } from '#components/erp/record';

import type { Stocktaking } from './client.js';

/** 读一张盘点单：被盖住时不取数，关掉子页时重新取一次；没有读权限时不发请求。 */
export function useStocktaking(id: string, enabled = true) {
  return useRecord<Stocktaking>(
    id ? `stocktakings/${encodeURIComponent(id)}` : '',
    enabled,
  );
}
