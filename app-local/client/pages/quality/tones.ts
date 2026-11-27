export type Tone = 'neutral' | 'info' | 'warning' | 'success';

/** 严重度的颜色只有两档：重的是警示，轻的是中性，其余一律信息色。 */
export function severityTone(severity: string | null): Tone {
  switch (severity) {
    case 'critical':
      return 'warning';
    case 'major':
      return 'warning';
    case 'minor':
      return 'neutral';
    default:
      return 'info';
  }
}

/**
 * 初筛取值的颜色。旧取值 `auto` 的分支已删（R-003 的迁移把存量 `auto` 改成了
 * `suggested`，投递也不再写 `auto`）；`suggested` 与确认后的 `reviewed` 同用信息色。
 */
export function outcomeTone(outcome: string): Tone {
  if (outcome === 'needs-review') return 'warning';
  if (outcome === 'reviewed' || outcome === 'suggested') return 'info';
  return 'neutral';
}
