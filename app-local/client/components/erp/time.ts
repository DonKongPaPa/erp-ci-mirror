const TIME = /^(\d{1,2}):(\d{2})$/u;

/** 零点起的分钟数 → 「时:分」。 */
export function formatMinute(minute: number): string {
  const wrapped = ((Math.trunc(minute) % 1440) + 1440) % 1440;
  const hour = String(Math.floor(wrapped / 60)).padStart(2, '0');
  const minuteOfHour = String(wrapped % 60).padStart(2, '0');
  return `${hour}:${minuteOfHour}`;
}

/** 「时:分」→ 零点起的分钟数；写得不合规（没有冒号、时超过 23、分超过 59）返回 `undefined`。 */
export function parseTime(text: string): number | undefined {
  const match = TIME.exec(text.trim());
  if (!match) return undefined;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return undefined;
  return hour * 60 + minute;
}

/** 下班早于上班就是跨天。 */
export function isCrossMidnight(
  startMinute: number,
  endMinute: number,
): boolean {
  return endMinute < startMinute;
}

/** 时间段：「08:00 – 17:00」。 */
export function formatRange(startMinute: number, endMinute: number): string {
  return `${formatMinute(startMinute)} – ${formatMinute(endMinute)}`;
}

/** 整数（如排序）；写得不合规返回 `undefined`。 */
export function parseInteger(text: string): number | undefined {
  if (!/^-?\d+$/u.test(text.trim())) return undefined;
  const value = Number(text.trim());
  return Number.isSafeInteger(value) ? value : undefined;
}
