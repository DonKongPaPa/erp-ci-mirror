/**
 * 浏览器会话里的打印痕迹。
 *
 * `print-mark` 的响应是「点打印」这一刻的事实；详情接口目前不回打印三列，
 * 所以把这一次的回执按单号记在本标签页的 sessionStorage 里：回到详情还能看到
 * 次数与最后打印人，关掉标签页就散了，不像用户偏好那样跨会话留着。
 * 只记姓名，不记邮箱、手机号。
 */
export interface PrintTrace {
  readonly printCount: number;
  readonly lastPrintedAt: string;
  readonly lastPrintedBy: string;
  readonly lastPrintedByName: string;
}

const prefix = 'nocobase.doc-print.trace:';

export function rememberPrintTrace(docNo: string, trace: PrintTrace): void {
  try {
    sessionStorage.setItem(`${prefix}${docNo}`, JSON.stringify(trace));
  } catch {
    // 隐私模式下存储不可用：本次打印视图里的数字仍然会更新。
  }
}

export function readPrintTrace(docNo: string | undefined): PrintTrace | undefined {
  if (!docNo) return undefined;
  try {
    const raw = sessionStorage.getItem(`${prefix}${docNo}`);
    if (raw === null) return undefined;
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object') return undefined;
    const candidate = parsed as Record<string, unknown>;
    return typeof candidate.printCount === 'number' &&
      typeof candidate.lastPrintedBy === 'string' &&
      typeof candidate.lastPrintedByName === 'string' &&
      typeof candidate.lastPrintedAt === 'string'
      ? (candidate as unknown as PrintTrace)
      : undefined;
  } catch {
    return undefined;
  }
}
