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

/** 服务端翻好的那句话（`error.localizedMessage.message`），没有就没有。 */
function localizedMessage(error: ApiClientError): string | undefined {
  const localized = (
    errorBody(error)?.localizedMessage as { message?: unknown } | undefined
  )?.message;
  return typeof localized === 'string' && localized.trim() ? localized : undefined;
}

/**
 * 表单字段用的那句话：服务端翻好的在前，没有就 `error.message`。
 * 设计文档 2.8：被拒时先显示它，不自己拼。
 */
export function serverMessage(error: unknown): string | undefined {
  if (!(error instanceof ApiClientError)) return undefined;
  return localizedMessage(error) ?? (error.message.trim() || undefined);
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
  if (error instanceof ApiClientError) {
    const localized = localizedMessage(error);
    if (localized) return localized;
    // 403/404 的服务端 `message` 是框架的英文授权码与 "The requested record was not found."；
    // 没有文案时不端给用户，改说用户看得懂的一句话。字段级校验仍走 serverMessage。
    if (error.status === 403) return t('erp.errors.denied');
    if (error.status === 404) return t('erp.errors.notFound');
  }
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
