import { useRecord } from '#components/erp/record';

import type { Transfer } from './client.js';

/** 读一张调拨单：被盖住时不取数，关掉子页时重新取一次；没有读权限时不发请求。 */
export function useTransfer(id: string, enabled = true) {
  return useRecord<Transfer>(
    id ? `transfers/${encodeURIComponent(id)}` : '',
    enabled,
  );
}
