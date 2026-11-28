/**
 * R-087 测试反馈的读与算：纯函数，不读文件、不碰数据库，便于按验收标准逐条测。
 *
 * 登记表在仓库里、反馈与截图在本机 `.local/feedback/`（不入库）。这里只进开发环境
 * （见 `server/embedded.ts`），部署产物没有这个文件（R-073）。
 */

export type FeedbackStatus =
  | 'new'
  | 'accepted'
  | 'fixed'
  | 'wontfix'
  | 'duplicate';
export type FeedbackKind =
  | 'display'
  | 'flow'
  | 'data'
  | 'missing'
  | 'copy'
  | 'other';
export type FeedbackErrorReason =
  | 'UNKNOWN_ID'
  | 'TEXT_TOO_SHORT'
  | 'INVALID_TARGET'
  | 'INVALID_KIND'
  | 'INVALID_STATUS'
  | 'MISSING_REF'
  | 'MISSING_NOTE'
  | 'ATTACHMENT_NOT_FOUND';

export const FEEDBACK_STATUSES: readonly FeedbackStatus[] = [
  'new',
  'accepted',
  'fixed',
  'wontfix',
  'duplicate',
];
export const FEEDBACK_KINDS: readonly FeedbackKind[] = [
  'display',
  'flow',
  'data',
  'missing',
  'copy',
  'other',
];
const MIN_TEXT_LENGTH = 4;
const FEEDBACK_ID = /^FB-\d{3,}$/u;
const REGISTRY_ID = /^[A-Za-z0-9._-]+$/u;

export interface PageTarget {
  readonly kind: 'page';
  readonly route: string;
}
export interface ElementTarget {
  readonly kind: 'element';
  readonly text: string;
  readonly locator: string;
  readonly source?: string;
}
export interface RegistryTarget {
  readonly kind: 'registry';
  readonly registryId: string;
}
export type FeedbackTarget = PageTarget | ElementTarget | RegistryTarget;

export interface FeedbackNote {
  readonly text: string;
  readonly at: string;
}

export interface FeedbackItem {
  readonly id: string;
  readonly at: string;
  readonly route: string;
  readonly target: FeedbackTarget;
  readonly text: string;
  readonly kinds: readonly FeedbackKind[];
  readonly severe: boolean;
  readonly screenshot: string | null;
  readonly status: FeedbackStatus;
  readonly ref: string;
  readonly note: string;
  readonly notes: readonly FeedbackNote[];
  readonly updatedAt: string;
}

export interface RegistryRow {
  readonly id: string;
  readonly module: string;
  readonly page: string;
  readonly feature: string;
  readonly route?: string;
  readonly source: string;
  readonly status: string;
  readonly betaAt: string;
}

export interface FeedbackState {
  readonly items: readonly FeedbackItem[];
  readonly seen: Readonly<Record<string, string>>;
}

export interface FeedbackSnapshot {
  readonly generatedAt: string;
  readonly items: readonly FeedbackItem[];
  readonly registry: readonly RegistryRow[];
  readonly seen: Readonly<Record<string, string>>;
  readonly counts: Readonly<Record<FeedbackStatus, number>>;
}

export interface NewFeedback {
  readonly route: string;
  readonly target: FeedbackTarget;
  readonly text: string;
  readonly kinds?: readonly FeedbackKind[];
  readonly severe?: boolean;
  readonly screenshotId?: string;
}

export class InvalidRegistry extends Error {
  constructor(detail: string) {
    super(`功能登记表不可用：${detail}`);
    this.name = 'InvalidRegistry';
  }
}

export class InvalidFeedback extends Error {
  constructor(readonly reason: FeedbackErrorReason) {
    super(`反馈无效：${reason}`);
    this.name = 'InvalidFeedback';
  }
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** 登记表：对象数组、id 唯一、字段齐全；一处坏就整块不认，不静默跳过。 */
export function parseRegistry(raw: string): readonly RegistryRow[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new InvalidRegistry('不是合法的 JSON。');
  }
  if (!Array.isArray(parsed)) throw new InvalidRegistry('顶层不是数组。');
  const ids = new Set<string>();
  return parsed.map((entry: unknown, index: number) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new InvalidRegistry(`第 ${index + 1} 条不是对象。`);
    }
    const item = entry as Record<string, unknown>;
    if (!nonEmptyString(item.id) || !REGISTRY_ID.test(item.id)) {
      throw new InvalidRegistry(`第 ${index + 1} 条的 id 不合格式。`);
    }
    if (ids.has(item.id)) throw new InvalidRegistry(`id 重复：${item.id}。`);
    ids.add(item.id);
    for (const field of ['module', 'page', 'feature', 'source', 'status']) {
      if (typeof item[field] !== 'string') {
        throw new InvalidRegistry(`${item.id} 的 ${field} 不是字符串。`);
      }
    }
    if (item.route !== undefined && typeof item.route !== 'string') {
      throw new InvalidRegistry(`${item.id} 的 route 不是字符串。`);
    }
    if (item.betaAt !== undefined && typeof item.betaAt !== 'string') {
      throw new InvalidRegistry(`${item.id} 的 betaAt 不是字符串。`);
    }
    return {
      id: item.id,
      module: item.module as string,
      page: item.page as string,
      feature: item.feature as string,
      source: item.source as string,
      status: item.status as string,
      betaAt: typeof item.betaAt === 'string' ? item.betaAt : '',
      ...(typeof item.route === 'string' ? { route: item.route } : {}),
    };
  });
}

export function emptyFeedbackState(): FeedbackState {
  return { items: [], seen: {} };
}

function asStatus(value: unknown): FeedbackStatus | undefined {
  return FEEDBACK_STATUSES.includes(value as FeedbackStatus)
    ? (value as FeedbackStatus)
    : undefined;
}

function asKinds(value: unknown): readonly FeedbackKind[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const kinds: FeedbackKind[] = [];
  for (const item of value) {
    if (!FEEDBACK_KINDS.includes(item as FeedbackKind)) return undefined;
    kinds.push(item as FeedbackKind);
  }
  return kinds;
}

function asTarget(value: unknown): FeedbackTarget | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const item = value as Record<string, unknown>;
  if (item.kind === 'page') {
    return nonEmptyString(item.route) ? { kind: 'page', route: item.route } : undefined;
  }
  if (item.kind === 'element') {
    if (!nonEmptyString(item.text) || !nonEmptyString(item.locator)) return undefined;
    return {
      kind: 'element',
      text: item.text,
      locator: item.locator,
      ...(typeof item.source === 'string' ? { source: item.source } : {}),
    };
  }
  if (item.kind === 'registry') {
    return nonEmptyString(item.registryId) && REGISTRY_ID.test(item.registryId)
      ? { kind: 'registry', registryId: item.registryId }
      : undefined;
  }
  return undefined;
}

function asItem(value: unknown): FeedbackItem | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const item = value as Record<string, unknown>;
  const status = asStatus(item.status);
  const target = asTarget(item.target);
  if (
    !FEEDBACK_ID.test(String(item.id)) ||
    !nonEmptyString(item.at) ||
    !nonEmptyString(item.route) ||
    !nonEmptyString(item.text) ||
    status === undefined ||
    target === undefined
  ) {
    return undefined;
  }
  const notes = Array.isArray(item.notes)
    ? item.notes.flatMap((note) => {
        if (typeof note !== 'object' || note === null) return [];
        const entry = note as Record<string, unknown>;
        return nonEmptyString(entry.text) && nonEmptyString(entry.at)
          ? [{ text: entry.text, at: entry.at }]
          : [];
      })
    : [];
  return {
    id: String(item.id),
    at: String(item.at),
    route: String(item.route),
    target,
    text: String(item.text),
    kinds: asKinds(item.kinds) ?? [],
    severe: item.severe === true,
    screenshot: typeof item.screenshot === 'string' ? item.screenshot : null,
    status,
    ref: typeof item.ref === 'string' ? item.ref : '',
    note: typeof item.note === 'string' ? item.note : '',
    notes,
    updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : String(item.at),
  };
}

/** 状态文件读坏了就按空起步：它只是本机状态，丢一条坏记录不该让整页打不开。 */
export function normalizeFeedbackState(value: unknown): FeedbackState {
  if (typeof value !== 'object' || value === null) return emptyFeedbackState();
  const item = value as Record<string, unknown>;
  const feedbacks = Array.isArray(item.items)
    ? item.items.flatMap((entry) => {
        const valid = asItem(entry);
        return valid ? [valid] : [];
      })
    : [];
  const seen: Record<string, string> = {};
  if (typeof item.seen === 'object' && item.seen !== null) {
    for (const [id, at] of Object.entries(item.seen)) {
      if (REGISTRY_ID.test(id) && typeof at === 'string') seen[id] = at;
    }
  }
  return { items: feedbacks, seen };
}

export function parseStateFile(raw: string): FeedbackState {
  try {
    return normalizeFeedbackState(JSON.parse(raw));
  } catch {
    return emptyFeedbackState();
  }
}

export function validateTarget(target: unknown): FeedbackTarget {
  const valid = asTarget(target);
  if (valid === undefined) throw new InvalidFeedback('INVALID_TARGET');
  return valid;
}

export function validateKinds(kinds: unknown): readonly FeedbackKind[] {
  const valid = asKinds(kinds ?? []);
  if (valid === undefined) throw new InvalidFeedback('INVALID_KIND');
  return valid;
}

/** 编号只追加：取当前最大序号加一，不复用已处理条目的号。 */
export function nextFeedbackId(items: readonly FeedbackItem[]): string {
  const max = items.reduce((highest, item) => {
    const match = /^FB-(\d+)$/u.exec(item.id);
    return match ? Math.max(highest, Number(match[1])) : highest;
  }, 0);
  return `FB-${String(max + 1).padStart(3, '0')}`;
}

/** 追加一条，状态固定为「新」；文本至少四个字，类型与严重可选。 */
export function appendFeedback(
  state: FeedbackState,
  input: NewFeedback,
  at: string,
): { readonly state: FeedbackState; readonly id: string } {
  if (typeof input.text !== 'string' || input.text.trim().length < MIN_TEXT_LENGTH) {
    throw new InvalidFeedback('TEXT_TOO_SHORT');
  }
  const target = validateTarget(input.target);
  const kinds = validateKinds(input.kinds);
  if (typeof input.route !== 'string' || input.route.trim().length === 0) {
    throw new InvalidFeedback('INVALID_TARGET');
  }
  const id = nextFeedbackId(state.items);
  const item: FeedbackItem = {
    id,
    at,
    route: input.route,
    target,
    text: input.text,
    kinds,
    severe: input.severe === true,
    screenshot:
      typeof input.screenshotId === 'string' && input.screenshotId.length > 0
        ? input.screenshotId
        : null,
    status: 'new',
    ref: '',
    note: '',
    notes: [],
    updatedAt: at,
  };
  return { state: { items: [...state.items, item], seen: state.seen }, id };
}

/** 追加说明，旧内容与状态都不改。 */
export function appendNote(
  state: FeedbackState,
  id: string,
  text: string,
  at: string,
): FeedbackState {
  if (!nonEmptyString(text)) throw new InvalidFeedback('UNKNOWN_ID');
  let found = false;
  const items = state.items.map((item) => {
    if (item.id !== id) return item;
    found = true;
    return {
      ...item,
      notes: [...item.notes, { text, at }],
      updatedAt: at,
    };
  });
  if (!found) throw new InvalidFeedback('UNKNOWN_ID');
  return { items, seen: state.seen };
}

/** 主会话脚本用：写状态、去处与一句说明，只改这一条，历史保留。 */
export function markProcessed(
  state: FeedbackState,
  id: string,
  status: FeedbackStatus,
  ref: string,
  note: string,
  at: string,
): FeedbackState {
  const resolved = asStatus(status);
  if (resolved === undefined) throw new InvalidFeedback('INVALID_STATUS');
  if (!nonEmptyString(ref)) throw new InvalidFeedback('MISSING_REF');
  if (!nonEmptyString(note)) throw new InvalidFeedback('MISSING_NOTE');
  let found = false;
  const items = state.items.map((item) => {
    if (item.id !== id) return item;
    found = true;
    return { ...item, status: resolved, ref, note, updatedAt: at };
  });
  if (!found) throw new InvalidFeedback('UNKNOWN_ID');
  return { items, seen: state.seen };
}

/** 「看过，没意见」是本机确认，按登记表 id 记一个时刻。 */
export function markSeen(
  state: FeedbackState,
  registryId: string,
  at: string,
): FeedbackState {
  if (!REGISTRY_ID.test(registryId)) throw new InvalidFeedback('UNKNOWN_ID');
  return { items: state.items, seen: { ...state.seen, [registryId]: at } };
}

export function buildSnapshot(
  registry: readonly RegistryRow[],
  state: FeedbackState,
  generatedAt: string = new Date().toISOString(),
): FeedbackSnapshot {
  const counts = Object.fromEntries(
    FEEDBACK_STATUSES.map((status) => [
      status,
      state.items.filter((item) => item.status === status).length,
    ]),
  ) as Record<FeedbackStatus, number>;
  return {
    generatedAt,
    items: [...state.items].sort((left, right) => left.id.localeCompare(right.id)),
    registry,
    seen: state.seen,
    counts,
  };
}

/** 主会话脚本用：状态为「新」的，按编号排。 */
export function pendingFeedbacks(state: FeedbackState): readonly FeedbackItem[] {
  return state.items
    .filter((item) => item.status === 'new')
    .sort((left, right) => left.id.localeCompare(right.id));
}
