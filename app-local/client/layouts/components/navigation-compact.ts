import { useState } from 'react';

import {
  routeKey,
  type RouteNavigationItem,
} from '../../routing/route-navigation.js';

/**
 * R-085 紧凑态：菜单全部展开的高度超过可用高度时，各组默认收起，只展开当前页所在的组。
 * 测量由调用方给出（真实布局用视口高度加行数估算，组件测试给夹具高度），判定本身是纯函数。
 */
export interface NavigationMeasurement {
  /** 侧栏内容容器的真实可用高度（已扣掉品牌区与页脚）。 */
  readonly availableHeight: number;
  /** 菜单全部展开时需要的高度（像素）。 */
  readonly expandedHeight: number;
  /** 当前实际内容的 scrollHeight；紧凑态已生效时用来判断是否还要继续收。 */
  readonly contentHeight?: number;
}

export const COMPACT_STORAGE_KEY = 'nocobase:navigation:compact';

export function isCompactNavigation(measurement: NavigationMeasurement): boolean {
  return measurement.expandedHeight > measurement.availableHeight;
}

/** 紧凑态下当前组展开后仍放不下：把还能收的这一组也收起，不能让页脚遮住文字。 */
export function needsDeeperCollapse(measurement: NavigationMeasurement): boolean {
  return (
    measurement.contentHeight !== undefined &&
    measurement.contentHeight > measurement.availableHeight
  );
}

/** shadcn 侧栏的行高固定；按行数估算展开高度，不量 DOM，首帧就能决定用不用紧凑态。 */
export function estimateExpandedHeight(
  items: readonly RouteNavigationItem[],
  rowHeight = 36,
  labelHeight = 32,
): number {
  let rows = 0;
  let labels = 0;
  const visit = (item: RouteNavigationItem, top: boolean): void => {
    if (item.route.componentLoader) rows += 1;
    if (top && item.children.length > 0 && !item.route.componentLoader) {
      labels += 1;
    }
    for (const child of item.children) visit(child, false);
  };
  for (const item of items) visit(item, true);
  return rows * rowHeight + labels * labelHeight;
}

/**
 * 可用高度优先取侧栏内容容器的 clientHeight（尺寸由 shadcn 的 SidebarContent 决定，已扣掉品牌与页脚）；
 * 只有组件测试或首帧还没有容器时，才退回视口高度减去预留区。
 */
export function readNavigationMeasurement(
  items: readonly RouteNavigationItem[],
  container?: Element | null,
  viewportHeight?: number,
): NavigationMeasurement {
  const height = viewportHeight ?? globalThis.innerHeight ?? 768;
  return {
    availableHeight: container?.clientHeight || Math.max(240, height - 168),
    expandedHeight: estimateExpandedHeight(items),
    ...(container ? { contentHeight: container.scrollHeight } : {}),
  };
}

/** 当前页所在的一级组；紧凑态下它默认展开。 */
export function currentGroupKey(
  items: readonly RouteNavigationItem[],
  selectedKey: string | undefined,
): string | undefined {
  if (!selectedKey) return undefined;
  const contains = (item: RouteNavigationItem): boolean =>
    routeKey(item.route) === selectedKey ||
    item.children.some((child) => contains(child));
  const group = items.find(
    (item) => item.children.length > 0 && contains(item),
  );
  return group ? routeKey(group.route) : undefined;
}

interface StoredChoice {
  readonly expandedKey: string | null;
}

function readChoice(): StoredChoice | undefined {
  try {
    const text = localStorage.getItem(COMPACT_STORAGE_KEY);
    if (!text) return undefined;
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object') return undefined;
    const key = (parsed as { expandedKey?: unknown }).expandedKey;
    if (key === null) return { expandedKey: null };
    return typeof key === 'string' ? { expandedKey: key } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 手动展开或收起的组记在本机；没有手动选择时跟随当前页。
 * 「恢复默认」删掉手动选择，重新跟随当前页。
 */
export function useCompactNavigation({
  compact,
  collapsedAll = false,
  items,
  selectedKey,
}: {
  readonly compact: boolean;
  /** 紧凑态仍放不下时，连当前组也不自动展开。 */
  readonly collapsedAll?: boolean;
  readonly items: readonly RouteNavigationItem[];
  readonly selectedKey: string | undefined;
}) {
  const [choice, setChoice] = useState<StoredChoice | undefined>(readChoice);

  const setExpanded = (key: string, open: boolean): void => {
    const next: StoredChoice = { expandedKey: open ? key : null };
    setChoice(next);
    try {
      localStorage.setItem(COMPACT_STORAGE_KEY, JSON.stringify(next));
    } catch {
      // 本机存储不可用时，本次会话里仍然生效。
    }
  };

  const reset = (): void => {
    setChoice(undefined);
    try {
      localStorage.removeItem(COMPACT_STORAGE_KEY);
    } catch {
      // 同上。
    }
  };

  const expandedKey =
    compact && !collapsedAll
      ? choice
        ? choice.expandedKey
        : currentGroupKey(items, selectedKey) ?? null
      : null;

  return { compact, expandedKey, setExpanded, reset };
}
