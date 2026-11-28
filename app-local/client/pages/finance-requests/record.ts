import { useRecord } from '#components/erp/record';

import type { FinanceRequest } from './client.js';

/** 读一张请款 / 报销单：被盖住时不取数，关掉子页时重新取一次；没有读权限时不发请求。 */
export function useFinanceRequest(id: string, enabled = true) {
  return useRecord<FinanceRequest>(
    id ? `finance-requests/${encodeURIComponent(id)}` : '',
    enabled,
  );
}
