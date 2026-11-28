import { useRecord } from '#components/erp/record';

import type { InspectionOrder } from './client.js';

/** 读一张检验单：被盖住时不取数，关掉子页时重新取一次；没有读权限时不发请求。 */
export function useInspection(id: string, enabled = true) {
  return useRecord<InspectionOrder>(
    id ? `inspections/${encodeURIComponent(id)}` : '',
    enabled,
  );
}
