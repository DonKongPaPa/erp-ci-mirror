/** 两个 API 密钥页面共用的显示规则。 */

export interface ApiKeyTimestamps {
  readonly enabled: boolean;
  readonly expiresAt: string | null;
}

export type ApiKeyStatus = 'active' | 'disabled' | 'expired';

/** 密钥行的状态：停用优先于过期；没有过期时间就是永不过期。 */
export function apiKeyStatus(
  key: ApiKeyTimestamps,
  now = Date.now(),
): ApiKeyStatus {
  if (!key.enabled) return 'disabled';
  if (key.expiresAt && Date.parse(key.expiresAt) <= now) return 'expired';
  return 'active';
}

/**
 * 一个时间点的本地显示。时间缺失时返回 `null`，由调用方给「从未使用」「永不过期」
 * 之类的词条；非法的字符串原样返回，方便看出服务端给了什么。
 */
export function formatTimestamp(value: string | null, language: string) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(language, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}
