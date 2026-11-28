import { useCallback, useEffect, useState } from 'react';

import type { ReturnDoc } from './client.js';
import type { ReturnsClient } from './client.js';

/** 详情页读一张退货单。授权未落定或 id 为空时不发请求，避免越权读出内容。 */
export function useReturnDoc(
  client: ReturnsClient,
  id: string,
  enabled: boolean,
): {
  readonly data: ReturnDoc | undefined;
  readonly error: unknown;
  readonly loading: boolean;
  readonly reload: () => void;
} {
  const [data, setData] = useState<ReturnDoc>();
  const [error, setError] = useState<unknown>();
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion((value) => value + 1), []);
  const loading = enabled && Boolean(id) && data === undefined && error === undefined;

  useEffect(() => {
    if (!enabled || !id) return;
    const controller = new AbortController();
    let active = true;
    void (async () => {
      try {
        const doc = await client.detail(id);
        if (active && !controller.signal.aborted) {
          setData(doc);
          setError(undefined);
        }
      } catch (cause) {
        if (active && !controller.signal.aborted) setError(cause);
      }
    })();
    return () => {
      active = false;
      controller.abort();
    };
  }, [client, id, enabled, version]);

  return { data, error, loading, reload };
}
