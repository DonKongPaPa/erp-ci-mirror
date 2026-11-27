import { ApiClientError } from '@nocobase/app-client';

export type Translate = (
  key: string,
  options?: Record<string, unknown>,
) => string;

/** 标准错误体 `{ error: { … } }` 里的一层；不是这个形状就返回 `undefined`。 */
function errorBody(error: ApiClientError): Record<string, unknown> | undefined {
  const payload = error.payload;
  const body =
    payload && typeof payload === 'object'
      ? (payload as { error?: unknown }).error
      : undefined;
  return body && typeof body === 'object'
    ? (body as Record<string, unknown>)
    : undefined;
}

/**
 * 服务端翻好的那句话（`error.localizedMessage.message`），没有就 `error.message`。
 * 设计文档 2.8：被拒时先显示它，不自己拼。
 */
export function serverMessage(error: unknown): string | undefined {
  if (!(error instanceof ApiClientError)) return undefined;
  const localized = (
    errorBody(error)?.localizedMessage as { message?: unknown } | undefined
  )?.message;
  if (typeof localized === 'string' && localized.trim()) return localized;
  return error.message.trim() || undefined;
}

const STATUS_KEYS: Readonly<Record<number, string>> = {
  400: 'erp.errors.invalid',
  401: 'erp.errors.session',
  403: 'erp.errors.denied',
  404: 'erp.errors.notFound',
  409: 'erp.errors.conflict',
  422: 'erp.errors.invalid',
};

/**
 * 一次写操作失败的提示：服务端那句话在前；没有时按状态码给一句；
 * 请求根本没发出去（网络断开）单独一句，不把英文原话端给用户。
 */
export function errorText(error: unknown, t: Translate): string {
  const server = serverMessage(error);
  if (server) return server;
  if (error instanceof ApiClientError) {
    if (Object.hasOwn(STATUS_KEYS, error.status))
      return t(STATUS_KEYS[error.status]);
    return t('erp.errors.generic', {
      reason: error.reason ?? String(error.status),
    });
  }
  return t('erp.errors.network');
}
