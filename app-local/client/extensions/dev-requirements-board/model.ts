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
  return item.blockingDetail ? `${item.blocking} · ${item.blockingDetail}` : item.blocking;
}
