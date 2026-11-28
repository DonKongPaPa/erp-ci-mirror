/**
 * R-083 待确认事项的读与算：纯函数，不读文件、不碰数据库，便于按验收标准逐条测。
 *
 * 唯一的问题是入库的清单，答复与处理状态在不入库的 state.json。这里只进开发环境
 * （见 `server/embedded.ts`），部署产物没有这个文件（R-073）。
 */

export type ConfirmationStatus = 'landed' | 'followup' | 'withdrawn';
export type ConfirmationGroup =
  | 'pending'
  | 'awaiting'
  | 'answered'
  | 'processed';
export type AnswerErrorReason = 'UNKNOWN_ID' | 'EMPTY' | 'TOO_LONG' | 'NOT_IN_OPTIONS';
export type ProcessErrorReason = 'UNKNOWN_ID' | 'INVALID_STATUS' | 'MISSING_REF' | 'MISSING_NOTE';
export type ClarificationErrorReason = 'UNKNOWN_ID' | 'TOO_LONG';

export interface ConfirmationQuestion {
  readonly id: string;
  readonly topic: string;
  readonly question: string;
  readonly default: string;
  readonly options?: readonly string[];
  readonly source: string;
  readonly closed?: boolean;
  /** 主会话在文档轮用 `confirmations.mjs explain` 写入；一条问题可有多条，按写入先后排。 */
  readonly explanations?: readonly ConfirmationExplanation[];
}

/** 主会话查清后写进问题清单的一条说明（入库文件，由脚本维护）。 */
export interface ConfirmationExplanation {
  readonly at: string;
  readonly asked: string;
  readonly text: string;
}

/** 用户的一次补充说明请求，存在不入库的 state.json；解释到来后补 answeredAt。 */
export interface ConfirmationClarification {
  readonly id: string;
  readonly note: string;
  readonly at: string;
  readonly answeredAt?: string;
}

/** 端点带回的一条请求历史：去掉 id（它已在问题条目上），answeredAt 统一成可空。 */
export interface ViewClarification {
  readonly note: string;
  readonly at: string;
  readonly answeredAt: string | null;
}

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

export interface ConfirmationState {
  readonly answers: readonly ConfirmationAnswer[];
  readonly processed: Readonly<Record<string, ProcessedConfirmation>>;
  /** 只追加；老状态文件没有这个字段，读的时候按空处理。 */
  readonly clarifications?: readonly ConfirmationClarification[];
}

export interface ConfirmationItem extends ConfirmationQuestion {
  readonly latestAnswer: ConfirmationAnswer | null;
  readonly processed: ProcessedConfirmation | null;
  readonly group: ConfirmationGroup;
  readonly clarifications: readonly ViewClarification[];
  readonly explanations: readonly ConfirmationExplanation[];
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

export const CONFIRMATION_STATUSES: readonly ConfirmationStatus[] = [
  'landed',
  'followup',
  'withdrawn',
];
const MAX_ANSWER_LENGTH = 2000;
const QUESTION_ID = /^[A-Za-z0-9]+-\d{2}$/u;

export class InvalidConfirmationList extends Error {
  constructor(detail: string) {
    super(`问题清单不可用：${detail}`);
    this.name = 'InvalidConfirmationList';
  }
}

export class InvalidConfirmationAnswer extends Error {
  constructor(readonly reason: AnswerErrorReason) {
    super(`答复无效：${reason}`);
    this.name = 'InvalidConfirmationAnswer';
  }
}

export class InvalidConfirmationProcess extends Error {
  constructor(readonly reason: ProcessErrorReason) {
    super(`处理状态无效：${reason}`);
    this.name = 'InvalidConfirmationProcess';
  }
}

export class InvalidConfirmationClarification extends Error {
  constructor(readonly reason: ClarificationErrorReason) {
    super(`补充说明请求无效：${reason}`);
    this.name = 'InvalidConfirmationClarification';
  }
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every(nonEmptyString);
}

function asExplanation(value: unknown): ConfirmationExplanation | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const item = value as Record<string, unknown>;
  if (
    !nonEmptyString(item.at) ||
    !nonEmptyString(item.asked) ||
    typeof item.text !== 'string'
  ) {
    return undefined;
  }
  return { at: item.at, asked: item.asked, text: item.text };
}

/** 清单必须是对象数组、`id` 不重复且字段齐全；一处坏就整块不认，不静默跳过。 */
export function parseQuestionList(raw: string): readonly ConfirmationQuestion[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new InvalidConfirmationList('不是合法的 JSON。');
  }
  if (!Array.isArray(parsed)) throw new InvalidConfirmationList('顶层不是数组。');
  const ids = new Set<string>();
  return parsed.map((entry: unknown, index: number) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new InvalidConfirmationList(`第 ${index + 1} 条不是对象。`);
    }
    const item = entry as Record<string, unknown>;
    if (!nonEmptyString(item.id) || !QUESTION_ID.test(item.id)) {
      throw new InvalidConfirmationList(`第 ${index + 1} 条的 id 不合格式。`);
    }
    if (ids.has(item.id)) {
      throw new InvalidConfirmationList(`id 重复：${item.id}。`);
    }
    ids.add(item.id);
    if (
      !nonEmptyString(item.topic) ||
      !nonEmptyString(item.question) ||
      !nonEmptyString(item.default) ||
      !nonEmptyString(item.source)
    ) {
      throw new InvalidConfirmationList(`${item.id} 缺 topic/question/default/source。`);
    }
    if (item.options !== undefined && !isStringArray(item.options)) {
      throw new InvalidConfirmationList(`${item.id} 的 options 不是非空字符串数组。`);
    }
    if (item.closed !== undefined && typeof item.closed !== 'boolean') {
      throw new InvalidConfirmationList(`${item.id} 的 closed 不是布尔值。`);
    }
    let explanations: readonly ConfirmationExplanation[] | undefined;
    if (item.explanations !== undefined) {
      if (
        !Array.isArray(item.explanations) ||
        item.explanations.some((entry) => asExplanation(entry) === undefined)
      ) {
        throw new InvalidConfirmationList(`${item.id} 的 explanations 格式不对。`);
      }
      explanations = item.explanations.map(
        (entry) => asExplanation(entry) as ConfirmationExplanation,
      );
    }
    return {
      id: item.id,
      topic: item.topic,
      question: item.question,
      default: item.default,
      source: item.source,
      ...(item.options !== undefined ? { options: item.options } : {}),
      ...(item.closed !== undefined ? { closed: item.closed } : {}),
      ...(explanations !== undefined ? { explanations } : {}),
    };
  });
}

export function emptyConfirmationState(): ConfirmationState {
  return { answers: [], processed: {} };
}

function asAnswer(value: unknown): ConfirmationAnswer | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const item = value as Record<string, unknown>;
  if (!nonEmptyString(item.id) || !nonEmptyString(item.answer) || !nonEmptyString(item.at)) {
    return undefined;
  }
  return {
    id: item.id,
    answer: item.answer,
    note: typeof item.note === 'string' ? item.note : '',
    at: item.at,
  };
}

function asProcessed(value: unknown): ProcessedConfirmation | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const item = value as Record<string, unknown>;
  if (
    !nonEmptyString(item.id) ||
    !nonEmptyString(item.ref) ||
    !nonEmptyString(item.at) ||
    !nonEmptyString(item.note) ||
    !CONFIRMATION_STATUSES.includes(item.status as ConfirmationStatus)
  ) {
    return undefined;
  }
  return {
    id: item.id,
    status: item.status as ConfirmationStatus,
    ref: item.ref,
    at: item.at,
    note: item.note,
  };
}

function asClarification(value: unknown): ConfirmationClarification | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const item = value as Record<string, unknown>;
  if (
    !nonEmptyString(item.id) ||
    !nonEmptyString(item.note) ||
    !nonEmptyString(item.at)
  ) {
    return undefined;
  }
  return {
    id: item.id,
    note: item.note,
    at: item.at,
    ...(typeof item.answeredAt === 'string' && item.answeredAt.length > 0
      ? { answeredAt: item.answeredAt }
      : {}),
  };
}

/** 状态文件读坏了就按空起步：它只是本机状态，丢一条坏记录不该让整页打不开。 */
export function normalizeConfirmationState(value: unknown): ConfirmationState {
  if (typeof value !== 'object' || value === null) return emptyConfirmationState();
  const item = value as Record<string, unknown>;
  const answers = Array.isArray(item.answers)
    ? item.answers.flatMap((answer) => {
        const valid = asAnswer(answer);
        return valid ? [valid] : [];
      })
    : [];
  const processed: Record<string, ProcessedConfirmation> = {};
  if (typeof item.processed === 'object' && item.processed !== null) {
    for (const [id, value] of Object.entries(item.processed)) {
      const valid = asProcessed(value);
      if (valid?.id === id) processed[id] = valid;
    }
  }
  // 老状态文件没有 clarifications：不补一个空字段，保持它读出来还是原来的形状。
  const clarifications = Array.isArray(item.clarifications)
    ? item.clarifications.flatMap((entry) => {
        const valid = asClarification(entry);
        return valid ? [valid] : [];
      })
    : undefined;
  return {
    answers,
    processed,
    ...(clarifications !== undefined ? { clarifications } : {}),
  };
}

export function parseStateFile(raw: string): ConfirmationState {
  try {
    return normalizeConfirmationState(JSON.parse(raw));
  } catch {
    return emptyConfirmationState();
  }
}

export function latestAnswer(
  state: ConfirmationState,
  id: string,
): ConfirmationAnswer | null {
  for (let index = state.answers.length - 1; index >= 0; index -= 1) {
    if (state.answers[index]?.id === id) return state.answers[index] ?? null;
  }
  return null;
}

/** 数组只追加，最后一条就是最近一次请求。 */
export function latestClarification(
  state: ConfirmationState,
  id: string,
): ConfirmationClarification | null {
  const all = state.clarifications ?? [];
  for (let index = all.length - 1; index >= 0; index -= 1) {
    if (all[index]?.id === id) return all[index] ?? null;
  }
  return null;
}

/** 「等补充」= 最近一次请求还没有 answeredAt；说明到来后由脚本补上。 */
export function isAwaitingClarification(
  state: ConfirmationState,
  id: string,
): boolean {
  const latest = latestClarification(state, id);
  return latest !== null && latest.answeredAt === undefined;
}

/** note 可空；非空时 1 到 2000 字。 */
export function clarificationError(note: string): ClarificationErrorReason | null {
  if (typeof note !== 'string') return 'TOO_LONG';
  return note.length > MAX_ANSWER_LENGTH ? 'TOO_LONG' : null;
}

/** 只追加一条请求；新请求没有 answeredAt，因此这条问题进入「等补充」。 */
export function appendClarification(
  state: ConfirmationState,
  id: string,
  note: string,
  at: string,
): ConfirmationState {
  return {
    ...state,
    clarifications: [
      ...(state.clarifications ?? []),
      { id, note, at },
    ],
  };
}

/** 主会话写完说明后，把这条问题所有未答的请求标上同一时刻。 */
export function markClarificationsAnswered(
  state: ConfirmationState,
  id: string,
  at: string,
): ConfirmationState {
  return {
    ...state,
    clarifications: (state.clarifications ?? []).map((entry) =>
      entry.id === id && entry.answeredAt === undefined
        ? { ...entry, answeredAt: at }
        : entry,
    ),
  };
}

/** 已处理优先于已答复；关掉且没答复的不进任何一组；最近一次请求没答的进「等补充」。 */
export function groupFor(
  question: ConfirmationQuestion,
  state: ConfirmationState,
): ConfirmationGroup | null {
  if (state.processed[question.id] !== undefined) return 'processed';
  if (latestAnswer(state, question.id) !== null) return 'answered';
  if (question.closed === true) return null;
  if (isAwaitingClarification(state, question.id)) return 'awaiting';
  return 'pending';
}

/** 单选必须落在 options 里（含页面追加的「其他」）；填空去空白后 1 到 2000 字。 */
export function answerError(
  question: ConfirmationQuestion,
  answer: string,
): AnswerErrorReason | null {
  if (typeof answer !== 'string' || answer.trim().length === 0) return 'EMPTY';
  if (question.options !== undefined) {
    return question.options.includes(answer) ? null : 'NOT_IN_OPTIONS';
  }
  return answer.trim().length > MAX_ANSWER_LENGTH ? 'TOO_LONG' : null;
}

/** 追加一条，历史都留；同一条多次答复以最后一条为准。 */
export function appendAnswer(
  state: ConfirmationState,
  id: string,
  answer: string,
  note: string,
  at: string,
): ConfirmationState {
  return {
    answers: [...state.answers, { id, answer, note, at }],
    processed: state.processed,
  };
}

export function markProcessed(
  state: ConfirmationState,
  id: string,
  status: ConfirmationStatus,
  ref: string,
  note: string,
  at: string,
): ConfirmationState {
  if (!CONFIRMATION_STATUSES.includes(status)) {
    throw new InvalidConfirmationProcess('INVALID_STATUS');
  }
  if (ref.trim().length === 0) throw new InvalidConfirmationProcess('MISSING_REF');
  if (note.trim().length === 0) throw new InvalidConfirmationProcess('MISSING_NOTE');
  return {
    answers: state.answers,
    processed: {
      ...state.processed,
      [id]: { id, status, ref, at, note },
    },
  };
}

/** 按主题分组前先按主题、编号排序，页面只管顺序切组。 */
export function buildSnapshot(
  questions: readonly ConfirmationQuestion[],
  state: ConfirmationState,
  generatedAt: string = new Date().toISOString(),
): ConfirmationSnapshot {
  const items: ConfirmationItem[] = questions
    .filter((question) => groupFor(question, state) !== null)
    .map((question) => ({
      ...question,
      latestAnswer: latestAnswer(state, question.id),
      processed: state.processed[question.id] ?? null,
      group: groupFor(question, state) as ConfirmationGroup,
      // 数组即时间升序（只追加），页面据此把「新的在上」倒过来显示。
      clarifications: (state.clarifications ?? [])
        .filter((entry) => entry.id === question.id)
        .map((entry) => ({
          note: entry.note,
          at: entry.at,
          answeredAt: entry.answeredAt ?? null,
        })),
      explanations: question.explanations ?? [],
    }))
    .sort(
      (left, right) =>
        left.topic.localeCompare(right.topic) || left.id.localeCompare(right.id),
    );
  const count = (group: ConfirmationGroup): number =>
    items.filter((item) => item.group === group).length;
  return {
    generatedAt,
    counts: {
      pending: count('pending'),
      answered: count('answered'),
      processed: count('processed'),
    },
    questions: items,
  };
}

/** 主会话脚本用：已答复还没处理，按编号排。 */
export function pendingAnswers(
  questions: readonly ConfirmationQuestion[],
  state: ConfirmationState,
): readonly ConfirmationItem[] {
  return buildSnapshot(questions, state)
    .questions.filter((item) => item.group === 'answered')
    .sort((left, right) => left.id.localeCompare(right.id));
}
