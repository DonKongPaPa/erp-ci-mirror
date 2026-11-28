/**
 * R-083 待确认事项的视图模型：从端点响应里切组、按主题分组、把选项整理成磁贴。
 * 只读响应 + 提交答复，不改清单；状态由主会话的脚本写（见 `scripts/dev/confirmations.mjs`）。
 */

export type ConfirmationGroup =
  | 'pending'
  | 'awaiting'
  | 'answered'
  | 'processed';
export type ConfirmationStatus = 'landed' | 'followup' | 'withdrawn';

/** 「自己写」按这个固定的选项值提交，自写内容进备注（服务端校验单选必须落在 options 里）。 */
export const OTHER = '其他';
/** 填空题的「按默认提交」磁贴在草稿里的值；提交时换成下面两条。 */
export const TAKE_DEFAULT = '__take_default__';
export const DEFAULT_NOTE = '按默认';
const SENTENCE_END = /[。！？;；\n]/u;

/** 「当前默认」的第一句（到第一个句末标点为止），给「按默认提交」当副标题。 */
export function firstSentence(text: string): string {
  const match = SENTENCE_END.exec(text);
  const head = match ? text.slice(0, match.index) : text.trim();
  return head.length === 0 ? text.trim() : head + (match ? match[0] : '');
}

/** 清单里默认项的标记，如「不解耦（默认）」；磁贴上换成小标，文字里不再重复。 */
const DEFAULT_MARK = /[（(]\s*默认\s*[)）]/u;

export interface ConfirmationAnswer {
  readonly id: string;
  readonly answer: string;
  readonly note: string;
  readonly at: string;
}

export interface ProcessedConfirmation {
  readonly id: string;
  readonly status: ConfirmationStatus;
  readonly ref: string;
  readonly at: string;
  readonly note: string;
}

/** 一次补充请求：note 可空；answeredAt 为 null 表示主会话还没写说明。 */
export interface Clarification {
  readonly note: string;
  readonly at: string;
  readonly answeredAt: string | null;
}

/** 主会话写进清单的一条说明；text 是纯文本，页面不渲染 HTML。 */
export interface Explanation {
  readonly at: string;
  readonly asked: string;
  readonly text: string;
}

export interface ConfirmationItem {
  readonly id: string;
  readonly topic: string;
  readonly question: string;
  readonly default: string;
  readonly options?: readonly string[];
  readonly source: string;
  readonly closed?: boolean;
  readonly latestAnswer: ConfirmationAnswer | null;
  readonly processed: ProcessedConfirmation | null;
  readonly group: ConfirmationGroup;
  readonly clarifications: readonly Clarification[];
  readonly explanations: readonly Explanation[];
}

export interface ConfirmationSnapshot {
  readonly generatedAt: string;
  readonly counts: {
    readonly pending: number;
    readonly answered: number;
    readonly processed: number;
  };
  readonly questions: readonly ConfirmationItem[];
}

export interface TopicGroup {
  readonly topic: string;
  readonly items: readonly ConfirmationItem[];
}

/** 一块选项磁贴。`value` 是提交与校验用的原值，`label` 是磁贴上显示的文字。 */
export interface Choice {
  readonly value: string;
  readonly label: string;
  readonly isDefault: boolean;
  readonly isOther: boolean;
  /** 填空题的「按默认提交」：不打字，按当前默认答复。 */
  readonly isTakeDefault: boolean;
}

export type TopicTone = 'info' | 'neutral' | 'warning' | 'success';

/** 一道题的草稿：单选是选中的选项值，「自己写」的自写内容进 note；填空直接写进 answer。 */
export interface Draft {
  readonly answer: string;
  readonly note: string;
}

export const emptyDraft: Draft = { answer: '', note: '' };

/** 「自己写」要有自写内容才算答了；「按默认提交」与选了选项都算答了。 */
export function isAnswered(draft: Draft): boolean {
  if (draft.answer === OTHER) return draft.note.trim().length > 0;
  if (draft.answer === TAKE_DEFAULT) return true;
  return draft.answer.trim().length > 0;
}

/**
 * 草稿变成提交的正文，存储格式不变：
 *   单选题的「自己写」→ answer 仍是固定的「其他」选项值，自写内容进 note；填空题的「自己写」→ 文字就是 answer；
 *   「按默认提交」→ answer 是这道题的当前默认全文，note 记「按默认」；
 *   其余 → answer 原样，note 为空。
 */
export function answerPayload(
  item: ConfirmationItem,
  draft: Draft,
): { answer: string; note: string } {
  // 填空题的「自己写」：文字本身就是答复，不借「其他」这个值。
  if (draft.answer === OTHER && item.options === undefined)
    return { answer: draft.note.trim(), note: '' };
  if (draft.answer === OTHER) return { answer: OTHER, note: draft.note.trim() };
  if (draft.answer === TAKE_DEFAULT)
    return { answer: item.default, note: DEFAULT_NOTE };
  return { answer: draft.answer, note: draft.note };
}

/** 端点已按主题、编号排好序；这里只切组，保持它的次序。 */
export function inGroup(
  snapshot: ConfirmationSnapshot | null,
  group: ConfirmationGroup,
): readonly ConfirmationItem[] {
  return (snapshot?.questions ?? []).filter((item) => item.group === group);
}

export function byTopic(
  items: readonly ConfirmationItem[],
): readonly TopicGroup[] {
  const groups = new Map<string, ConfirmationItem[]>();
  for (const item of items) {
    const list = groups.get(item.topic) ?? [];
    list.push(item);
    groups.set(item.topic, list);
  }
  return [...groups].map(([topic, list]) => ({ topic, items: list }));
}

/**
 * 单选题的磁贴：清单的 options 去重后各一块；清单没列「其他」时页面在最后补一块。
 * 清单自己带了「其他」时不再补 —— 以前两块同值的单选会一起显示成选中。
 * 默认项：优先认清单里带「（默认）」标记的那块；一块都没标时，认文字被写进「当前默认」里的第一块。
 * 清单没有 options 的填空题给两块：「按默认提交」（1）与「自己写」（2），同样不用打字。
 * 最多九块，数字键 1–9 才对得上；超过九个的选项是清单的问题，这里原样列出。
 */
export function choicesOf(item: ConfirmationItem): readonly Choice[] {
  const choices: Choice[] = [];
  let marked = false;
  for (const raw of item.options ?? []) {
    const label = raw.replace(DEFAULT_MARK, '').trim() || raw;
    if (choices.some((choice) => choice.value === raw)) continue;
    const isDefault = DEFAULT_MARK.test(raw) && !marked;
    if (isDefault) marked = true;
    choices.push({
      value: raw,
      label,
      isDefault,
      isOther: raw === OTHER,
      isTakeDefault: false,
    });
  }
  if (item.options === undefined) {
    choices.push({
      value: TAKE_DEFAULT,
      label: TAKE_DEFAULT,
      isDefault: false,
      isOther: false,
      isTakeDefault: true,
    });
  }
  if (!marked) {
    const fallback = choices.find(
      (choice) =>
        !choice.isOther &&
        choice.label.length > 0 &&
        item.default.includes(choice.label),
    );
    if (fallback)
      choices[choices.indexOf(fallback)] = { ...fallback, isDefault: true };
  }
  if (choices.length === 0 || !choices.some((choice) => choice.isOther)) {
    choices.push({
      value: OTHER,
      label: OTHER,
      isDefault: false,
      isOther: true,
      isTakeDefault: false,
    });
  }
  return choices;
}

/** 已答 = 有过答复的（已答复待处理 + 已处理）；没答的按默认做。 */
export function answeredCount(snapshot: ConfirmationSnapshot | null): number {
  return snapshot ? snapshot.counts.answered + snapshot.counts.processed : 0;
}

export interface TopicCount {
  readonly topic: string;
  readonly total: number;
  readonly answered: number;
}

/** 每个主题的总数与已答数，按总数从多到少；出现在 questions 里的主题都算。 */
export function topicCounts(
  snapshot: ConfirmationSnapshot | null,
): readonly TopicCount[] {
  const map = new Map<string, TopicCount>();
  for (const item of snapshot?.questions ?? []) {
    const entry = map.get(item.topic) ?? {
      topic: item.topic,
      total: 0,
      answered: 0,
    };
    map.set(item.topic, {
      topic: item.topic,
      total: entry.total + 1,
      answered: entry.answered + (item.group === 'pending' ? 0 : 1),
    });
  }
  return [...map.values()].sort(
    (left, right) =>
      right.total - left.total || left.topic.localeCompare(right.topic),
  );
}

/** 「等补充」只在页头单列一块，不进快照的 counts（那三块仍是待确认/已答复/已处理）。 */
export function awaitingCount(snapshot: ConfirmationSnapshot | null): number {
  return (snapshot?.questions ?? []).filter(
    (item) => item.group === 'awaiting',
  ).length;
}

export function hasExplanation(item: ConfirmationItem): boolean {
  return item.explanations.length > 0;
}

/** 拿到说明的题回到「待确认」后排在最前；其余保持清单次序。 */
export function explainedFirst(
  items: readonly ConfirmationItem[],
): readonly ConfirmationItem[] {
  const first: ConfirmationItem[] = [];
  const rest: ConfirmationItem[] = [];
  for (const item of items) {
    if (item.group === 'pending' && hasExplanation(item)) first.push(item);
    else rest.push(item);
  }
  return [...first, ...rest];
}

/** 说明正文的一块：普通段落按空行分段，以「- 」开头的连续行收成一个列表。 */
export type ExplanationBlock =
  | { readonly kind: 'paragraph'; readonly text: string }
  | { readonly kind: 'list'; readonly items: readonly string[] };

export function explanationBlocks(text: string): readonly ExplanationBlock[] {
  const blocks: ExplanationBlock[] = [];
  let paragraph: string[] = [];
  let list: string[] = [];
  const flushParagraph = (): void => {
    if (paragraph.length > 0) {
      blocks.push({ kind: 'paragraph', text: paragraph.join('\n') });
      paragraph = [];
    }
  };
  const flushList = (): void => {
    if (list.length > 0) {
      blocks.push({ kind: 'list', items: [...list] });
      list = [];
    }
  };
  for (const line of text.split(/\r?\n/u)) {
    if (line.trim().length === 0) {
      flushList();
      flushParagraph();
      continue;
    }
    if (line.startsWith('- ')) {
      flushParagraph();
      list.push(line.slice(2));
    } else {
      flushList();
      paragraph.push(line);
    }
  }
  flushList();
  flushParagraph();
  return blocks;
}

/** 主题的固定色：由名字算出，同一个主题每次都是同一色。只用 StatusBadge 的四种语义色。 */
export function toneOf(topic: string): TopicTone {
  let sum = 0;
  for (const char of topic) sum += char.codePointAt(0) ?? 0;
  const tones: readonly TopicTone[] = ['info', 'success', 'warning', 'neutral'];
  return tones[sum % tones.length] ?? 'neutral';
}
