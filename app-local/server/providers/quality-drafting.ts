import { knowledgeToken, type KnowledgeReader } from '@nocobase/app-plugin-knowledge/server/tokens';
import type { Knowledge } from '@nocobase/app-plugin-knowledge/server/tokens';
import type { AppPluginApplication } from '@nocobase/app-server/plugins';
import { loggingToken } from '@nocobase/app-server/logging';
import {
  type DatabaseConnection,
  type RepositoryOperations,
  type RepositoryPolicy,
  type RepositoryRecord,
} from '@nocobase/db';
import { ServiceProvider } from '@nocobase/service-provider';
import { createServiceToken, type ServiceToken } from '@nocobase/service-provider';
import { z } from 'zod';

import { redactRecipientAddresses } from '../../shared/redact-addresses.js';
import type { QualityConfig } from '../config/quality.js';
import { QUALITY_STANDARDS_SPACE } from './knowledge-access.js';
import {
  CATEGORY_OWNER,
  DEFECT_CATEGORIES,
  qualityScreeningToken,
  screenByRules,
  SEVERITIES,
  type DefectCategory,
  type ScreeningResult,
  type Severity,
} from './quality-screening.js';
import {
  ModelNotConfiguredError,
  qualityModelGatewayToken,
  type QualityModelGateway,
} from './quality-model-gateway.js';

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

/**
 * R-002：代填服务（规则版兜底、脱敏、相似案例、模型层）。
 *
 * `draft` 先出规则版，再按开关决定要不要问模型；模型那边的任何失败都不抛错，回落
 * 规则版并带上 `degraded` 与原因。`similarCases` 只在服务内部用（给提示词当上下文），
 * 没有任何 HTTP 端点返回它的结果。
 *
 * 模型版固定四步、顺序不变：脱敏；取上下文（知识库命中的段落、相似的已确认案例、
 * 类别与严重度的定义）；调 `generate`（`source` 写 `fqc.draft`，十五秒超时）；把回来
 * 的文本当 JSON 解析、再用 zod 逐字段校验。任何一步不合约都按「没成」处理。
 */

/** 十五秒：模型版一次调用的上限。框架的 `generate` 自己不等超时，由这里等。 */
export const DRAFT_TIMEOUT_MS = 15_000;
/** 模型版用的提示词版本，写进初筛表的 `promptVersion` 列。 */
export const DRAFT_PROMPT_VERSION = 'fqc-draft-1';
/** 复核线：与投递里规则版的那条线相同，模型版的结果也用它重算 `outcome`。 */
export const AUTO_CONFIDENCE_THRESHOLD = 0.5;

export type DraftEngine = 'rules' | 'model';
export type DraftDegradeReason =
  | 'model-disabled'
  | 'model-not-configured'
  | 'model-error'
  | 'timeout'
  | 'invalid-output';

/** `draft` 的返回，逐字段见设计（R-002 的「代填服务」一节）。 */
export interface DraftResult {
  readonly category: DefectCategory;
  readonly severity: Severity;
  readonly suggestedOwner: string;
  readonly summary: string;
  readonly confidence: number;
  readonly evidence: readonly string[];
  readonly engine: DraftEngine;
  readonly model: string | null;
  readonly promptVersion: string | null;
  readonly degraded: boolean;
  readonly degradeReason: DraftDegradeReason | null;
  readonly knowledgeRefs: readonly string[];
  readonly redacted: boolean;
}

/** 一条已确认的历史案例：类别与严重度取确认记录的最近一行，正文是脱敏后的。 */
export interface SimilarCase {
  readonly screeningId: string;
  readonly category: DefectCategory;
  readonly severity: Severity;
  readonly text: string;
}

/**
 * 读相似案例用的三个仓储，由调用方带读者的范围传进来（与 `stats` 同一个原则：
 * 服务自己不知道「调用方是谁」，也只会经这几个仓储查）。`null` 表示调用方没有读
 * 这三张表的范围，与「范围内没有案例」同形：不取案例，也不报错。
 */
export interface DraftSimilarCaseSources {
  readonly screenings: RepositoryOperations<RepositoryRecord> | null;
  readonly messages: RepositoryOperations<RepositoryRecord> | null;
  readonly reviews: RepositoryOperations<RepositoryRecord> | null;
}

export interface DraftInput {
  /** 一段反馈的原文。 */
  readonly text: string;
  /** 读知识库用的账号；没有读者时知识库那一段为空。 */
  readonly reader?: KnowledgeReader;
}

export interface DraftOptions {
  readonly signal?: AbortSignal;
  /** 相似案例的来源；缺省（或有一张读不到）时不取案例。 */
  readonly cases?: DraftSimilarCaseSources;
}

/** 一次失败的模型调用：只记原因、耗时与来源，不含正文。 */
export interface DraftFailureEvent {
  readonly source: 'fqc.draft';
  readonly reason: 'timeout' | 'model-error';
  readonly durationMs: number;
}

export interface QualityDraftingService {
  draft(input: DraftInput, options?: DraftOptions): Promise<DraftResult>;
  redact(text: string): { readonly text: string; readonly redacted: boolean };
  similarCases(
    text: string,
    options: {
      readonly limit: number;
      readonly sources?: DraftSimilarCaseSources;
    },
  ): Promise<readonly SimilarCase[]>;
}

/** 代填服务从应用里拿到的几样东西；都经闭包取，provider 在启动时绑、真正用时才解析。 */
export interface QualityDraftingDeps {
  /** `quality.drafting.modelEnabled`：默认关。 */
  readonly modelEnabled: () => boolean;
  /** 规则版的入口（`qualityScreeningToken` 的 `screen`）。 */
  readonly rules: (text: string) => ScreeningResult;
  readonly gateway: () => QualityModelGateway | null;
  readonly knowledge: () => Knowledge | null;
  /** 框架不给失败调用记账；超时与网关抛错由应用自己记一条。 */
  readonly logFailure?: (event: DraftFailureEvent) => void;
}

/**
 * 发给模型之前遮掉手机号、邮箱与座机号。纯函数，回遮罩后的文本与「有没有改动」。
 *
 * 规则只有 `shared/redact-addresses.ts` 那一份：通知记录页与这里共用，常见写法
 * （分隔符、全角、+86/86/0086 前缀、座机）都在那里补齐。
 */
export function redactText(text: string): {
  readonly text: string;
  readonly redacted: boolean;
} {
  const redacted = redactRecipientAddresses(text);
  return { text: redacted, redacted: redacted !== text };
}

const DEFECT_DEFINITIONS = [
  'appearance（外观）：划痕、刮伤、色差、脏污、毛刺、凹陷、喷漆、锈等表面问题。',
  'dimension（尺寸）：尺寸、超差、公差、装配不上、变形等。',
  'function（功能）：不工作、失灵、失效、短路、起火、冒烟、漏电、安全隐患等。',
  'packaging（包装）：包装、破损、纸箱、托盘、运输、物流、受潮等。',
  'material（材质）：材质、料不对、混料、成分、硬度、脆、开裂等。',
  'process（工艺）：工艺、焊接、装配、螺丝、漏装、错装、工序等。',
  'other（其他）：没有明确缺陷特征，需要人工判断。',
  '严重度从高到低：critical（安全隐患或完全不可用）、major（影响装配或功能）、',
  'minor（外观或轻微问题）、info（信息不足或仅作参考）。',
].join('\n');

const SYSTEM_PROMPT = [
  '你是质量缺陷初筛助手。只输出一个 JSON 对象，不要输出 JSON 之外的任何文字。',
  '对象的字段是：',
  '{"category": "...", "severity": "...", "summary": "...", "confidence": 0.0, "evidence": ["..."]}',
  'category 只能取 appearance、dimension、function、packaging、material、process、other 之一；',
  'severity 只能取 critical、major、minor、info 之一；summary 用一两句中文；',
  'confidence 是 0 到 1 的数；evidence 是字符串数组，每个元素是一条判断依据。',
  '摘要与依据只能来自本次提交的正文；不得复述相似案例或质量标准里的原文。',
  '缺陷类别与严重度的定义：',
  DEFECT_DEFINITIONS,
].join('\n');

const MODEL_OUTPUT = z.object({
  category: z.enum(DEFECT_CATEGORIES),
  severity: z.enum(SEVERITIES),
  summary: z.string().trim().min(1).max(2000),
  confidence: z.number().min(0).max(1),
  evidence: z.array(z.string().trim().min(1).max(500)).max(20),
});

const MODEL_OUTPUT_MAX_CHARS = 4000;
const KNOWLEDGE_HITS = 5;
const SIMILAR_CASES = 3;
const SIMILAR_CASE_REVIEWS = 200;
const SIMILAR_CASE_MESSAGES = 200;

class DraftTimeoutError extends Error {
  override readonly name = 'DraftTimeoutError';
}

/** 把进来的文本切成关键字：中文取二字片段，拉丁词取整词；重复的只要一次。 */
function termsOf(text: string): string[] {
  const words = text.toLowerCase().match(/[\u3400-\u9fff]+|[a-z0-9]+/gu) ?? [];
  const terms = new Set<string>();
  for (const word of words) {
    if (/^[\u3400-\u9fff]+$/u.test(word)) {
      if (word.length <= 2) {
        terms.add(word);
      } else {
        for (let index = 0; index + 2 <= word.length; index += 1) {
          terms.add(word.slice(index, index + 2));
        }
      }
    } else if (word.length >= 2) {
      terms.add(word);
    }
    if (terms.size >= 40) {
      break;
    }
  }
  return [...terms];
}

const isCategory = (value: unknown): value is DefectCategory =>
  (DEFECT_CATEGORIES as readonly unknown[]).includes(value);
const isSeverity = (value: unknown): value is Severity =>
  (SEVERITIES as readonly unknown[]).includes(value);

const dateText = (value: unknown): string => {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number') {
    return new Date(value).toISOString();
  }
  return '';
};

function parseModelOutput(text: string): z.infer<typeof MODEL_OUTPUT> | null {
  if (text.length > MODEL_OUTPUT_MAX_CHARS) {
    return null;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = MODEL_OUTPUT.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export function createQualityDraftingService(
  deps: QualityDraftingDeps,
): QualityDraftingService {
  const rulesDraft = (
    rules: ScreeningResult,
    overrides: Partial<DraftResult>,
  ): DraftResult => ({
    category: rules.category,
    severity: rules.severity,
    suggestedOwner: rules.suggestedOwner,
    summary: rules.summary,
    confidence: rules.confidence,
    evidence: rules.evidence,
    engine: 'rules',
    model: null,
    promptVersion: null,
    degraded: false,
    degradeReason: 'model-disabled',
    knowledgeRefs: [],
    redacted: false,
    ...overrides,
  });

  /** 知识库命中的段落与相似案例：只进提示词，不回到任何响应里。 */
  const contextOf = async (
    text: string,
    reader: KnowledgeReader | undefined,
    sources: DraftSimilarCaseSources | undefined,
  ): Promise<{
    readonly lines: readonly string[];
    readonly cases: readonly SimilarCase[];
    readonly refs: readonly string[];
  }> => {
    const lines: string[] = [];
    const refs: string[] = [];
    if (reader) {
      const knowledge = deps.knowledge();
      if (knowledge) {
        const hits = await knowledge.docs.searchMany(
          reader,
          [QUALITY_STANDARDS_SPACE],
          text,
          { limit: KNOWLEDGE_HITS },
        );
        for (const hit of hits) {
          lines.push(`- ${hit.title}：${hit.excerpt}`);
          refs.push(
            `kb:${hit.docId}#${hit.anchor ?? String(hit.lines[0] ?? 1)}`,
          );
        }
      }
    }
    const cases = await similarCasesOf(text, SIMILAR_CASES, sources);
    for (const item of cases) {
      refs.push(`case:${item.screeningId}`);
    }
    return { lines, cases, refs };
  };

  const similarCasesOf = async (
    text: string,
    limit: number,
    sources: DraftSimilarCaseSources | undefined,
  ): Promise<readonly SimilarCase[]> => {
    if (!sources || limit <= 0) {
      return [];
    }
    const { screenings: screeningRepo, messages: messageRepo, reviews: reviewRepo } =
      sources;
    if (!screeningRepo || !messageRepo || !reviewRepo) {
      // 有一张读不到就不取案例：半个案例比没有案例更容易误导模型。
      return [];
    }
    const terms = termsOf(redactText(text).text);
    if (terms.length === 0) {
      return [];
    }
    // 三个仓储都带着读者的范围：范围之外的行根本不会进来。
    const reviews = await reviewRepo.findMany({
      sort: {
        kind: 'sort',
        version: 1,
        items: [
          { kind: 'field', path: ['createdAt'], direction: 'desc' },
          { kind: 'field', path: ['id'], direction: 'desc' },
        ],
      },
      limit: SIMILAR_CASE_REVIEWS,
    });
    const latest = new Map<
      string,
      { category: string; severity: string; at: string }
    >();
    for (const review of reviews as unknown as {
      screeningId: string;
      category: string;
      severity: string;
      createdAt: unknown;
    }[]) {
      if (latest.has(review.screeningId)) {
        continue;
      }
      latest.set(review.screeningId, {
        category: review.category,
        severity: review.severity,
        at: dateText(review.createdAt),
      });
    }
    if (latest.size === 0) {
      return [];
    }
    // 初筛与消息也各取范围内最近的一批，按 id 关联：不拼上百个 OR 条件。
    const screenings = await screeningRepo.findMany({
      sort: {
        kind: 'sort',
        version: 1,
        items: [{ kind: 'field', path: ['createdAt'], direction: 'desc' }],
      },
      limit: SIMILAR_CASE_REVIEWS,
    });
    const candidates = (screenings as unknown as {
      id: string;
      messageId: unknown;
    }[]).filter((row) => latest.has(String(row.id)));
    if (candidates.length === 0) {
      return [];
    }
    const messages = await messageRepo.findMany({
      sort: {
        kind: 'sort',
        version: 1,
        items: [{ kind: 'field', path: ['receivedAt'], direction: 'desc' }],
      },
      limit: SIMILAR_CASE_MESSAGES,
    });
    const contentOf = new Map(
      (messages as unknown as { id: string; content: unknown }[]).map((row) => [
        String(row.id),
        typeof row.content === 'string' ? row.content : '',
      ]),
    );
    const scored: { item: SimilarCase; score: number; at: string }[] = [];
    for (const screening of candidates) {
      const review = latest.get(String(screening.id));
      const content = contentOf.get(
        typeof screening.messageId === 'string' ? screening.messageId : '',
      );
      if (!review || content === undefined) {
        continue;
      }
      if (!isCategory(review.category) || !isSeverity(review.severity)) {
        continue;
      }
      const body = redactText(content).text;
      const lowered = body.toLowerCase();
      const score = terms.reduce(
        (total, term) => (lowered.includes(term) ? total + 1 : total),
        0,
      );
      if (score === 0) {
        continue;
      }
      scored.push({
        item: {
          screeningId: String(screening.id),
          category: review.category,
          severity: review.severity,
          text: body,
        },
        score,
        at: review.at,
      });
    }
    scored.sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      return right.at.localeCompare(left.at);
    });
    return scored.slice(0, limit).map((entry) => entry.item);
  };

  return {
    redact: redactText,

    similarCases: (text, options) =>
      similarCasesOf(text, options.limit, options.sources),

    async draft(input, options = {}) {
      if (typeof input?.text !== 'string' || input.text.length === 0) {
        throw new TypeError('draft() needs a non-empty text.');
      }
      const rules = deps.rules(input.text);
      if (!deps.modelEnabled()) {
        // 开关关着：不碰网关、不发任何请求，连脱敏与上下文都不做。
        return rulesDraft(rules, {});
      }

      const startedAt = Date.now();
      const redaction = redactText(input.text);
      let refs: readonly string[] = [];
      // 十五秒盖住整条模型路径：取上下文、调网关、解析都算在里面。网关自己不等超时，
      // 所以到点由这里 abort，并把它当成 timeout。
      const controller = new AbortController();
      const forwardAbort = () => controller.abort();
      if (options.signal?.aborted) {
        forwardAbort();
      } else {
        options.signal?.addEventListener('abort', forwardAbort, { once: true });
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      let timedOut = false;
      const deadline = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          controller.abort();
          reject(new DraftTimeoutError());
        }, DRAFT_TIMEOUT_MS);
      });
      const work = (async () => {
        const gateway = deps.gateway();
        if (!gateway) {
          throw new ModelNotConfiguredError(
            'The drafting model gateway is not bound.',
          );
        }
        const context = await contextOf(
          redaction.text,
          input.reader,
          options.cases,
        );
        refs = context.refs;
        const promptSections = [`客户反馈（已脱敏）：\n${redaction.text}`];
        if (context.lines.length > 0) {
          promptSections.push(
            `质量标准（知识库命中的段落）：\n${context.lines.join('\n')}`,
          );
        }
        if (context.cases.length > 0) {
          promptSections.push(
            `相似的已确认案例：\n${context.cases
              .map(
                (item) =>
                  `- 类别：${item.category}；严重度：${item.severity}；正文：${item.text}`,
              )
              .join('\n')}`,
          );
        }
        const answer = await gateway.generate({
          system: SYSTEM_PROMPT,
          prompt: promptSections.join('\n\n'),
          source: 'fqc.draft',
          maxOutputTokens: 800,
          signal: controller.signal,
        });
        return { answer, parsed: parseModelOutput(answer.text) };
      })();
      // 被放弃的那一支之后拒绝时不要变成未处理的拒绝。
      work.catch(() => undefined);
      try {
        const { answer, parsed } = await Promise.race([work, deadline]);
        if (!parsed) {
          return rulesDraft(rules, {
            degraded: true,
            degradeReason: 'invalid-output',
            knowledgeRefs: refs,
            redacted: redaction.redacted,
          });
        }
        return {
          category: parsed.category,
          severity: parsed.severity,
          suggestedOwner: CATEGORY_OWNER[parsed.category],
          summary: parsed.summary,
          confidence: parsed.confidence,
          evidence: parsed.evidence,
          engine: 'model',
          model: answer.model,
          promptVersion: DRAFT_PROMPT_VERSION,
          degraded: false,
          degradeReason: null,
          knowledgeRefs: refs,
          redacted: redaction.redacted,
        };
      } catch (error) {
        const reason: DraftDegradeReason =
          timedOut || error instanceof DraftTimeoutError
            ? 'timeout'
            : error instanceof ModelNotConfiguredError
              ? 'model-not-configured'
              : 'model-error';
        // 框架在成功之后才记账；超时与网关抛错这两种由应用自己记一条（不含正文）。
        if (reason === 'timeout' || reason === 'model-error') {
          deps.logFailure?.({
            source: 'fqc.draft',
            reason,
            durationMs: Date.now() - startedAt,
          });
        }
        return rulesDraft(rules, {
          degraded: true,
          degradeReason: reason,
          knowledgeRefs: refs,
          redacted: redaction.redacted,
        });
      } finally {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', forwardAbort);
      }
    },
  };
}

/**
 * `datetime` 列的读回形态：主机本地墙钟、毫秒三位、不带时区。
 *
 * 与仓储写入时的归一化一致，也与列表端点读回来的文字一致；投递不回读，响应直接
 * 用这个形态，201 里的时间才与随后的读取相等（`Date` 经 JSON 会变成 UTC 的 `Z` 形态）。
 * 提交之后的那一笔模型升级也用它，响应里合并进去的 `updatedAt` 才与随后读到的相等。
 */
export function storedDateTime(value: Date): string {
  const pad = (part: number) => String(part).padStart(2, '0');
  return (
    `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}` +
    `T${pad(value.getHours())}:${pad(value.getMinutes())}:${pad(value.getSeconds())}.${String(
      value.getMilliseconds(),
    ).padStart(3, '0')}`
  );
}

/** 与投递里规则版相同的复核线：模型版的结果也用它重算 `outcome`。 */
export function screeningOutcome(confidence: number): 'auto' | 'needs-review' {
  return confidence >= AUTO_CONFIDENCE_THRESHOLD ? 'auto' : 'needs-review';
}

/**
 * 置信度写进 `decimal(5, 4)` 列（标度 4 见迁移 `202611220001_create_fqc_demo`）。投递
 * 不带读、不回读，201 由这次写入的值拼，所以这里按列的读回形态给文本：驱动以文本
 * 读回 numeric 的方言（Postgres）保留列的标度（`"0.7500"`），以数字读回的方言
 * （SQLite）按数字转文本（`"0.75"`）。两种形态都与列表端点随后读到的同一条逐字一致。
 */
export function confidenceText(confidence: number, dialect: string): string {
  return dialect === 'sqlite' ? String(confidence) : confidence.toFixed(4);
}

export const qualityDraftingToken: ServiceToken<QualityDraftingService> =
  createServiceToken<QualityDraftingService>('app/quality-drafting');

export default class QualityDraftingProvider extends ServiceProvider<AppPluginApplication> {
  readonly name = 'app.quality-drafting';

  override register(): void {
    this.app.container.singleton(qualityDraftingToken, () => this.service());
  }

  private service(): QualityDraftingService {
    const { container, config } = this.app;
    return createQualityDraftingService({
      modelEnabled: () =>
        config.get<QualityConfig>('quality')?.drafting?.modelEnabled === true,
      rules: (text) =>
        container.has(qualityScreeningToken)
          ? container.resolve(qualityScreeningToken).screen(text)
          : screenByRules(text),
      gateway: () =>
        container.has(qualityModelGatewayToken)
          ? container.resolve(qualityModelGatewayToken)
          : null,
      knowledge: () =>
        container.has(knowledgeToken)
          ? container.resolve(knowledgeToken)
          : null,
      logFailure: (event) => {
        if (!container.has(loggingToken)) {
          return;
        }
        container
          .resolve(loggingToken)
          .getLogger('quality-drafting')
          .warn(event, 'A drafting model call failed before it was recorded.');
      },
    });
  }
}

/**
 * 提交之后的模型升级：投递的事务已经提交，这里再出一份草稿，成了就在第二笔很短的
 * 事务里把初筛换成模型版；没成就只把出处（`degraded` / `degradeReason` /
 * `redacted`）记上，草稿的五列与 `modelName` 仍是事务里写的那份规则版。
 *
 * 几条硬约束：
 *
 * - **只改不读**：投递的授权不带读，所以写入用带谓词的 `updateMany`，不用
 *   `updateOne`（后者先按读策略取那一行）。
 * - **范围由调用方传**：`policy` 是投递决策里初筛表的那一份，服务不自己猜。
 * - **确认抢先就丢掉**：谓词带 `reviewId IS NULL`；确认已经把指针写上了，这条更新
 *   匹配不到行，模型的结论不要。
 * - **0 行不算成功**：`updateMany` 更新 0 行（确认抢先、或行已不在调用方的范围里）
 *   时返回 `written: false`，端点不把模型值拼进响应，并记一条日志。行里留下的出处
 *   是真实发生的事：没跑到模型就还是 `null`，绝不写成 `model-disabled`。
 * - 返回实际写进库的那几个值；端点用它拼 201，响应与随后从列表读到的同一条逐字段
 *   一致。
 */
export interface DraftUpgradeResult {
  readonly written: boolean;
  readonly values: RepositoryRecord | null;
}

export async function upgradeScreeningDraft(options: {
  readonly connection: DatabaseConnection;
  readonly policy: RepositoryPolicy;
  readonly screeningId: string;
  readonly text: string;
  readonly reader?: KnowledgeReader;
  readonly cases?: DraftSimilarCaseSources;
  readonly drafting: QualityDraftingService;
}): Promise<DraftUpgradeResult> {
  const draft = await options.drafting.draft(
    {
      text: options.text,
      ...(options.reader === undefined ? {} : { reader: options.reader }),
    },
    options.cases === undefined ? {} : { cases: options.cases },
  );
  const updatedAt = storedDateTime(new Date());
  const values: RepositoryRecord =
    draft.engine === 'model'
      ? {
          category: draft.category,
          severity: draft.severity,
          suggestedOwner: draft.suggestedOwner,
          summary: draft.summary,
          confidence: confidenceText(draft.confidence, options.connection.dialect),
          evidence: draft.evidence,
          modelName: draft.model ?? 'rule-baseline',
          engine: 'model',
          promptVersion: draft.promptVersion,
          degraded: false,
          degradeReason: null,
          knowledgeRefs: draft.knowledgeRefs,
          redacted: draft.redacted,
          outcome: screeningOutcome(draft.confidence),
          updatedAt,
        }
      : {
          // 开关关着（model-disabled）与模型没成（其余原因）都只落出处四列：
          // 草稿的五列与 `modelName` 仍是事务里写的那份规则版。
          degraded: draft.degraded,
          degradeReason: draft.degradeReason,
          knowledgeRefs: draft.knowledgeRefs,
          redacted: draft.redacted,
          updatedAt,
        };
  return options.connection.transaction(async (transaction) => {
    const updated = await transaction
      .repository('fqcScreenings')
      .withPolicy(options.policy)
      .updateMany({
        filter: (filter) =>
          filter.and([
            filter.string('id').eq(options.screeningId),
            // 还没有人确认过这一行：确认抢先了，模型的结论就丢掉。
            filter.string('reviewId').empty(),
          ]),
        values,
      });
    return { written: updated.updatedCount === 1, values };
  });
}
