/** 只用到 t(key, options) 这一形，避免把框架的类型绑进这个小模块。 */
type Translator = (key: string, options?: Record<string, unknown>) => string;

/** 业务动作的复合资源 id，和服务端 `server/approvals-resources.ts` 一致。 */
export const APPROVAL_RESOURCE = { type: 'composite', id: 'approval' } as const;

export const MINE_SCOPES = ['active', 'completed', 'all'] as const;
export const TASK_SCOPES = ['pending', 'done'] as const;

export function statusTone(status: string): 'neutral' | 'info' | 'warning' | 'success' {
  if (status === 'approved') return 'success';
  if (status === 'rejected' || status === 'aborted') return 'warning';
  if (status === 'submitted' || status === 'processing' || status === 'pending' || status === 'assigned')
    return 'info';
  return 'neutral';
}

export function formatTime(value: string | null, locale: string): string {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(locale, {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

/** 快照里的值只按类型渲染，不解析业务含义。 */
export function snapshotText(value: unknown): string {
  if (value === null || value === undefined || value === '') return '-';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(snapshotText).join(', ');
  try {
    return JSON.stringify(value) ?? '-';
  } catch {
    return '-';
  }
}

export function statusLabel(t: Translator, status: string): string {
  return t(`approvals.status.${status}`, { defaultValue: status });
}

export function recordStatusLabel(t: Translator, status: string): string {
  return t(`approvals.recordStatus.${status}`, { defaultValue: status });
}

export function originLabel(t: Translator, origin: string): string {
  return t(`approvals.origin.${origin}`, { defaultValue: origin });
}
