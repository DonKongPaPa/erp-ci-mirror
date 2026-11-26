import { ServiceProvider } from '@nocobase/service-provider';
import type { AppPluginApplication } from '@nocobase/app-server/plugins';
import { createServiceToken, type ServiceToken } from '@nocobase/service-provider';

/** 质量缺陷分类：与客户微信群反馈的常见类型对应。 */
export const DEFECT_CATEGORIES = [
  'appearance',
  'dimension',
  'function',
  'packaging',
  'material',
  'process',
  'other',
] as const;

export type DefectCategory = (typeof DEFECT_CATEGORIES)[number];

export const SEVERITIES = ['critical', 'major', 'minor', 'info'] as const;
export type Severity = (typeof SEVERITIES)[number];

/** 分类到责任部门的默认映射；正式实现应由配置或数据表提供。 */
export const CATEGORY_OWNER: Readonly<Record<DefectCategory, string>> = {
  appearance: 'quality-appearance',
  dimension: 'quality-dimension',
  function: 'engineering',
  packaging: 'logistics',
  material: 'supply-chain',
  process: 'production',
  other: 'quality-general',
};

export interface ScreeningResult {
  readonly category: DefectCategory;
  readonly severity: Severity;
  readonly suggestedOwner: string;
  readonly summary: string;
  readonly confidence: number;
  readonly evidence: readonly string[];
}

/**
 * 规则版初筛，作为 AI 不可用时的降级路径，也作为演示中可重复的基线。
 *
 * 设计要点：AI 初筛必须是「可降级」的。模型服务不可用时工单不能丢，
 * 应由规则兜底并标记为低置信度，交人工复核。
 */
const KEYWORDS: ReadonlyArray<{
  category: DefectCategory;
  severity: Severity;
  words: readonly string[];
}> = [
  {
    category: 'function',
    severity: 'critical',
    words: ['不工作', '失灵', '失效', '无法启动', '短路', '起火', '冒烟', '漏电', '安全隐患'],
  },
  {
    category: 'dimension',
    severity: 'major',
    words: ['尺寸', '超差', '公差', '装配不上', '装不进', 'mm', '毫米', '偏差', '变形'],
  },
  {
    category: 'appearance',
    severity: 'minor',
    words: ['划痕', '刮伤', '色差', '脏污', '毛刺', '凹陷', '喷漆', '外观', '锈'],
  },
  {
    category: 'packaging',
    severity: 'minor',
    words: ['包装', '破损', '纸箱', '托盘', '运输', '物流', '受潮'],
  },
  {
    category: 'material',
    severity: 'major',
    words: ['材质', '料不对', '混料', '成分', '硬度', '脆', '开裂'],
  },
  {
    category: 'process',
    severity: 'major',
    words: ['工艺', '焊接', '装配', '螺丝', '漏装', '错装', '工序'],
  },
];

export function screenByRules(content: string): ScreeningResult {
  const text = content.toLowerCase();
  const matched: string[] = [];
  let category: DefectCategory = 'other';
  let severity: Severity = 'info';

  for (const rule of KEYWORDS) {
    const hits = rule.words.filter((word) => text.includes(word.toLowerCase()));
    if (hits.length === 0) {
      continue;
    }
    matched.push(...hits);
    // 严重度取最高：critical > major > minor > info。
    const order = SEVERITIES.indexOf(rule.severity);
    if (order < SEVERITIES.indexOf(severity)) {
      severity = rule.severity;
    }
    if (category === 'other') {
      category = rule.category;
    }
  }

  return {
    category,
    severity,
    suggestedOwner: CATEGORY_OWNER[category],
    summary: matched.length
      ? `命中关键词：${matched.slice(0, 5).join('、')}`
      : '未识别到明确缺陷特征，需人工判断',
    // 规则命中越多，置信度越高，但上限 0.75，避免规则结果被误当作模型结论。
    confidence: Math.min(0.35 + matched.length * 0.1, 0.75),
    evidence: matched.slice(0, 8),
  };
}

/**
 * 暴露给应用其他部分与 agent 的初筛能力。
 *
 * 这里只是规则版入口。模型层不在这里：R-002 的代填服务（`quality-drafting.ts` 的
 * `draft`）用它出规则版兜底，再按 `quality.drafting.modelEnabled` 决定要不要问模型；
 * 投递的那一行草稿也仍由这里先写出来。
 */
export class QualityScreeningService {
  screen(content: string): ScreeningResult {
    return screenByRules(content);
  }

  get categories(): readonly DefectCategory[] {
    return DEFECT_CATEGORIES;
  }
}

export const qualityScreeningToken: ServiceToken<QualityScreeningService> =
  createServiceToken<QualityScreeningService>('app/quality-screening');

export default class QualityScreeningProvider extends ServiceProvider<AppPluginApplication> {
  readonly name = 'app.quality-screening';

  override register(): void {
    this.app.container.singleton(qualityScreeningToken, () => {
      return new QualityScreeningService();
    });
  }
}
