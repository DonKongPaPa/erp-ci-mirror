import type { RepositoryOperations, RepositoryRecord } from '@nocobase/db';

/**
 * R-002 的代填效果：草稿与人工确认的对照。
 *
 * 只是纯计算，不碰模型、不碰知识库。`stats(screenings, reviews, { from, to })` 的两个
 * 参数是仓储，不是连接：端点把自己带范围的仓储传进来，服务只会经这两个仓储查。
 * 范围落在初筛的 `createdAt` 上：这段时间里出的草稿，与人对它们的最近一次确认。
 *
 * 返回只有汇总的数字，没有任何消息正文、发件人姓名与联系方式。
 */

/** 区间的两端；两端都在。 */
export interface DraftingStatsRange {
  readonly from: Date;
  readonly to: Date;
}

export interface DraftingStats {
  readonly total: number;
  readonly engines: { readonly rules: number; readonly model: number };
  readonly degradeReasons: {
    readonly 'model-disabled': number;
    readonly 'model-not-configured': number;
    readonly 'model-error': number;
    readonly timeout: number;
    readonly 'invalid-output': number;
  };
  readonly redacted: number;
  /** 有确认记录的草稿条数：类别/严重度的一致数只在这部分里算。 */
  readonly confirmed: number;
  readonly agreement: {
    readonly category: {
      readonly matched: number;
      readonly mismatched: number;
    };
    readonly severity: {
      readonly matched: number;
      readonly mismatched: number;
    };
  };
}

const DEGRADE_REASONS = [
  'model-disabled',
  'model-not-configured',
  'model-error',
  'timeout',
  'invalid-output',
] as const;

interface ScreeningStatsRow {
  readonly id: string;
  readonly category: string | null;
  readonly severity: string | null;
  readonly engine: string;
  readonly degradeReason: string | null;
  readonly redacted: unknown;
}

interface ReviewStatsRow {
  readonly id: string;
  readonly screeningId: string;
  readonly category: string;
  readonly severity: string;
  readonly createdAt: string;
}

const asFlag = (value: unknown): boolean =>
  value === true || value === 1 || value === '1' || value === 'true';

/**
 * 统计一批草稿与它们的确认记录。
 *
 * 类别与严重度的比对以这张表最近一行为准：同一份草稿确认过多次时，只有最新那一行
 * 参与对照。没有确认记录的草稿计入引擎、回落原因与脱敏的条数，但不计入一致/不一致。
 */
export async function computeDraftingStats(
  screenings: RepositoryOperations<RepositoryRecord>,
  // 确认记录表的读被范围折成 false 时，端点传 null：没有一条能读的确认记录，
  // 与「确认记录为空」同形，不该让整张统计卡返回 403。
  reviews: RepositoryOperations<RepositoryRecord> | null,
  range: DraftingStatsRange,
): Promise<DraftingStats> {
  const screeningRows = (await screenings.findMany({
    filter: (filter) =>
      filter.date('createdAt').between([range.from, range.to]),
  })) as unknown as ScreeningStatsRow[];

  const screeningIds = new Set(screeningRows.map((row) => row.id));
  // 一次读回范围内可能用到的确认记录：调用方的范围已经绑在仓储上，范围之外的行不进来。
  // 排序把最新的放在前面，每份草稿取第一行。
  const reviewRows =
    reviews === null
      ? []
      : ((await reviews.findMany({
          sort: {
            kind: 'sort',
            version: 1,
            items: [
              { kind: 'field', path: ['createdAt'], direction: 'desc' },
              { kind: 'field', path: ['id'], direction: 'desc' },
            ],
          },
        })) as unknown as ReviewStatsRow[]);

  const latestByScreening = new Map<string, ReviewStatsRow>();
  for (const review of reviewRows) {
    if (!screeningIds.has(review.screeningId)) {
      continue;
    }
    if (!latestByScreening.has(review.screeningId)) {
      latestByScreening.set(review.screeningId, review);
    }
  }

  const engines = { rules: 0, model: 0 };
  const degradeReasons: Record<(typeof DEGRADE_REASONS)[number], number> = {
    'model-disabled': 0,
    'model-not-configured': 0,
    'model-error': 0,
    timeout: 0,
    'invalid-output': 0,
  };
  let redacted = 0;
  const category = { matched: 0, mismatched: 0 };
  const severity = { matched: 0, mismatched: 0 };

  for (const screening of screeningRows) {
    if (screening.engine === 'model') {
      engines.model += 1;
    } else {
      // 只有两种引擎；未知的值按规则版计，宁可算错引擎也不悄悄丢掉一行。
      engines.rules += 1;
    }
    if (
      screening.degradeReason !== null &&
      (DEGRADE_REASONS as readonly string[]).includes(screening.degradeReason)
    ) {
      degradeReasons[
        screening.degradeReason as (typeof DEGRADE_REASONS)[number]
      ] += 1;
    }
    if (asFlag(screening.redacted)) {
      redacted += 1;
    }
    const review = latestByScreening.get(screening.id);
    if (!review) {
      continue;
    }
    if (review.category === screening.category) {
      category.matched += 1;
    } else {
      category.mismatched += 1;
    }
    if (review.severity === screening.severity) {
      severity.matched += 1;
    } else {
      severity.mismatched += 1;
    }
  }

  return {
    total: screeningRows.length,
    engines,
    degradeReasons,
    redacted,
    confirmed: latestByScreening.size,
    agreement: { category, severity },
  };
}
