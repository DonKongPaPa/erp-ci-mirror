/**
 * R-083 性能诊断：记录每张问题卡的渲染次数，供单测证明「打字只重渲染当前卡」。
 *
 * 只是一次 Map 写入，生产构建里成本可忽略；要在测试里量「渲染次数」必须有它 ——
 * DOM 快照相同不代表 React 没重渲染，靠 MutationObserver 量不到真正的重复计算。
 * `resetCardRenderCounts` / `cardRenderCount` 只给测试用。
 */
const counts = new Map<string, number>();

export function noteCardRender(id: string): void {
  counts.set(id, (counts.get(id) ?? 0) + 1);
}

export function cardRenderCount(id: string): number {
  return counts.get(id) ?? 0;
}

export function resetCardRenderCounts(): void {
  counts.clear();
}
