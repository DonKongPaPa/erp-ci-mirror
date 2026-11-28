/**
 * R-082 看板的视图模型：从端点响应里算状态列、权重标签与「建议次序」。
 * 只读，不回写需求池；调次序由人看完板后告诉主会话。
 */

export const STATUS_COLUMNS = [
  '待评估',
  '可行性已确认',
  '需业务决策',
  '方案已定',
  '实现中',
  '待验收',
  '已实现',
] as const;

export type BoardStatus = (typeof STATUS_COLUMNS)[number] | (string & {});

export interface FollowUpEntry {
  readonly at: string;
  readonly text: string;
}

export interface BoardItem {
  readonly id: string;
  readonly name: string;
  readonly category: string;
  readonly status: BoardStatus;
  readonly weight: string;
  readonly hardDeps: readonly string[];
  readonly softDeps: readonly string[];
  readonly note: string;
  readonly lastEntry: FollowUpEntry | null;
  /** 这一条的全部跟进记录，按时间升序；没有就是空数组。 */
  readonly entries: readonly FollowUpEntry[];
  readonly blocking: string;
  readonly blockingDetail: string;
}

export interface BoardSnapshot {
  readonly generatedAt: string;
  readonly totals: {
    readonly pool: number;
    readonly parsed: number;
    readonly skipped: number;
  };
  readonly requirements: readonly BoardItem[];
}

/** 权重次序：P0 到 P4，最后是「无」。看板上「无」不显示标签。 */
const WEIGHT_RANK: Readonly<Record<string, number>> = {
  P0: 0,
  P1: 1,
  P2: 2,
  P3: 3,
  P4: 4,
  无: 5,
};

export interface SuggestedOrder {
  readonly inProgress: readonly BoardItem[];
  readonly ready: readonly BoardItem[];
  readonly blocked: readonly BoardItem[];
}

/**
 * 先列在途，再列可开工，同组按权重（P0 到 P4）再按编号；等依赖的另成一组。
 * 已完成与待设计的不进建议次序 —— 前者不用做，后者还没过设计门。
 */
export function suggestedOrder(items: readonly BoardItem[]): SuggestedOrder {
  const byWeightThenId = (left: BoardItem, right: BoardItem): number =>
    (WEIGHT_RANK[left.weight] ?? 5) - (WEIGHT_RANK[right.weight] ?? 5) ||
    left.id.localeCompare(right.id);
  const pick = (blocking: string): readonly BoardItem[] =>
    items.filter((item) => item.blocking === blocking).sort(byWeightThenId);
  return {
    inProgress: pick('在途'),
    ready: pick('可开工'),
    blocked: pick('等依赖'),
  };
}

/** 卡片上「卡在哪」：六种 blocking 里只有两种带细节。 */
export function blockingLabel(item: BoardItem): string {
  return item.blockingDetail
    ? `${item.blocking} · ${item.blockingDetail}`
    : item.blocking;
}

/** 卡片摘要的上限（字）。超过就在最近的逗号或顿号处截断。 */
const SUMMARY_LIMIT = 60;

/** 开头的时间不进摘要：`2026-11-27T03:15:44+08:00`、`2026-11-27 13:30`，带不带方括号都认。 */
const LEADING_TIME =
  /^[\s[(（]*\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?)?(?:[Zz]|[+-]\d{2}:?\d{2})?[\])）]?\s*/u;
/** 一句的结束：中文句号、叹号、问号，以及半角的同类。 */
const SENTENCE_END = /[。！？!?]/u;

function collapse(text: string): string {
  return text.replaceAll(/\s+/gu, ' ').trim();
}

/** 正文的第一句（到第一个句号）；没有句末标点的整段算一句。 */
function firstSentence(text: string): string {
  const cleaned = collapse(text.replace(LEADING_TIME, ''));
  const end = cleaned.search(SENTENCE_END);
  if (end < 0) return cleaned;
  return cleaned.slice(0, end + 1);
}

function shorten(sentence: string): string {
  if (sentence.length <= SUMMARY_LIMIT) return sentence;
  const head = sentence.slice(0, SUMMARY_LIMIT);
  const pause = Math.max(
    head.lastIndexOf('，'),
    head.lastIndexOf('、'),
    head.lastIndexOf(','),
  );
  return `${pause < 0 ? head : head.slice(0, pause + 1)}…`;
}

/**
 * 卡片上那一句话：最近一条跟进的第一句；没有跟进取 `note` 的第一句；都没有给空串，
 * 由页面显示「暂无记录」。只看字数不看像素，所以这里不限两行 —— 两行由样式截。
 */
export function cardSummary(
  item: Pick<BoardItem, 'lastEntry' | 'note'>,
): string {
  const source = item.lastEntry?.text || item.note;
  return source ? shorten(firstSentence(source)) : '';
}

const MOMENT =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::\d{2})?(?:\.\d+)?(?:[Zz]|[+-]\d{2}:?\d{2})?$/u;

function parts(at: string): RegExpExecArray | null {
  return MOMENT.exec(at.trim());
}

/** 卡片上的短时间：`11-27 03:15`。写的是记录里的本地时刻，不换时区；不是这种写法的原样给出。 */
export function shortTime(at: string): string {
  const match = parts(at);
  return match ? `${match[2]}-${match[3]} ${match[4]}:${match[5]}` : at;
}

/** 抽屉里的时间：`2026-11-27 03:15`。 */
export function longTime(at: string): string {
  const match = parts(at);
  return match
    ? `${match[1]}-${match[2]}-${match[3]} ${match[4]}:${match[5]}`
    : at;
}
