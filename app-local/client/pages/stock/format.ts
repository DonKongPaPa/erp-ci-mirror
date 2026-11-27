/** 单据与流水的时刻：年月日时分。解析不了就原样显示，不让坏数据把页面打崩。 */
export function formatDateTime(value: string, locale: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

/** 数量：小数最多四位（契约里 qty 是 decimal(18,4)），没有小数就不补零。 */
export function formatQty(value: number, locale: string): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 4 }).format(
    value,
  );
}

const DAY = /^\d{4}-\d{2}-\d{2}$/u;

function localDate(text: string): Date | undefined {
  if (!DAY.test(text)) return undefined;
  const [year, month, day] = text.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/** 日期输入框的值（`2026-11-01`）→ 这一天零点的 ISO 串，给端点的 `from`。 */
export function startOfDay(text: string): string {
  return localDate(text)?.toISOString() ?? '';
}

/** 日期输入框的值 → 这一天最后一毫秒的 ISO 串，给端点的 `to`（端点含端点）。 */
export function endOfDay(text: string): string {
  const date = localDate(text);
  return date ? new Date(date.getTime() + 86_400_000 - 1).toISOString() : '';
}

/** 端点参数里的 ISO 串 → 日期输入框的值；不是 ISO 串就当没有。 */
export function dateInputValue(iso: string): string {
  const date = new Date(iso);
  if (!iso || Number.isNaN(date.getTime())) return '';
  const pad = (part: number): string => String(part).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
