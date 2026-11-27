/** 七个缺陷类别与四档严重度：与服务端 `DEFECT_CATEGORIES` / `SEVERITIES` 同一组取值。 */
export const CATEGORIES = [
  'appearance',
  'dimension',
  'function',
  'packaging',
  'material',
  'process',
  'other',
] as const;

export type Category = (typeof CATEGORIES)[number];

export const SEVERITIES = ['critical', 'major', 'minor', 'info'] as const;

export type Severity = (typeof SEVERITIES)[number];

/**
 * 五个流转的转移名：与服务端 lifecycle 定义的转移一一对应，动作名照抄服务端，
 * 客户端不自造别名。按钮显隐只看服务端算好的 `canTransition`。
 */
export const TRANSITIONS = ['accept', 'resolve', 'close', 'reopen', 'reassign'] as const;

export type TransitionName = (typeof TRANSITIONS)[number];

/** 防御式收窄：列表里的 `canTransition` 只认这五个名字，其余的忽略。 */
export function transitionNames(values: unknown): readonly TransitionName[] {
  if (!Array.isArray(values)) return [];
  return values.filter((value): value is TransitionName =>
    (TRANSITIONS as readonly string[]).includes(value as string),
  );
}
