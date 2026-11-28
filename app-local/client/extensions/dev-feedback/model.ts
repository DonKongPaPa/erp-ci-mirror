/**
 * R-087 测试反馈的视图模型：只把端点响应切成视图要的组合，不改服务端数据。
 *
 * 类型与状态用固定的键，文案走词条表；「看过，没意见」是本机的确认，记在 localStorage。
 */

export type FeedbackStatus =
  'new' | 'accepted' | 'fixed' | 'wontfix' | 'duplicate';
export type FeedbackKind =
  'display' | 'flow' | 'data' | 'missing' | 'copy' | 'other';

export interface FeedbackTarget {
  readonly kind: 'page' | 'element' | 'registry';
  readonly route?: string;
  readonly text?: string;
  readonly locator?: string;
  readonly source?: string;
  readonly registryId?: string;
}

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

export interface FeedbackSnapshot {
  readonly generatedAt: string;
  readonly items: readonly FeedbackItem[];
  readonly registry: readonly RegistryRow[];
  readonly seen: Readonly<Record<string, string>>;
  readonly counts: Readonly<Record<FeedbackStatus, number>>;
}

export const STATUS_ORDER: readonly FeedbackStatus[] = [
  'new',
  'accepted',
  'fixed',
  'wontfix',
  'duplicate',
];
export const STATUS_KEY: Readonly<Record<FeedbackStatus, string>> = {
  new: 'devTools.feedback.statusNew',
  accepted: 'devTools.feedback.statusAccepted',
  fixed: 'devTools.feedback.statusFixed',
  wontfix: 'devTools.feedback.statusWontfix',
  duplicate: 'devTools.feedback.statusDuplicate',
};
export const KIND_ORDER: readonly FeedbackKind[] = [
  'display',
  'flow',
  'data',
  'missing',
  'copy',
  'other',
];
export const KIND_KEY: Readonly<Record<FeedbackKind, string>> = {
  display: 'devTools.feedback.kindDisplay',
  flow: 'devTools.feedback.kindFlow',
  data: 'devTools.feedback.kindData',
  missing: 'devTools.feedback.kindMissing',
  copy: 'devTools.feedback.kindCopy',
  other: 'devTools.feedback.kindOther',
};

/** 快捷输入点一下就往正文里插的那一句；同一句也是取消时唯一要去掉的内容。 */
export const KIND_HINT_KEY: Readonly<Record<FeedbackKind, string>> = {
  display: 'devTools.feedback.kindDisplayHint',
  flow: 'devTools.feedback.kindFlowHint',
  data: 'devTools.feedback.kindDataHint',
  missing: 'devTools.feedback.kindMissingHint',
  copy: 'devTools.feedback.kindCopyHint',
  other: 'devTools.feedback.kindOtherHint',
};

/** 引导句是占位提示，不算用户写的正文：只去掉被记录的那些句子，不动用户自己的字。 */
export function userTextLength(text: string, hints: readonly string[]): number {
  let rest = text;
  for (const hint of hints) {
    if (hint.length > 0) rest = rest.replace(hint, '');
  }
  return rest.trim().length;
}

export function byStatus(
  items: readonly FeedbackItem[],
  status: FeedbackStatus,
): readonly FeedbackItem[] {
  return items.filter((item) => item.status === status);
}

export function targetLabel(item: FeedbackItem): string {
  const target = item.target;
  if (target.kind === 'page') return target.route ?? item.route;
  if (target.kind === 'registry') return target.registryId ?? '';
  return target.locator || target.text || item.route;
}

export interface RegistryViewRow extends RegistryRow {
  readonly feedbackCount: number;
  readonly openCount: number;
  readonly seenAt: string | null;
  readonly daysSinceBeta: number | null;
}

/** 一条反馈指向哪条登记表行：登记目标按 id，页面目标按路由，元素目标按所属页面路由。 */
function targetsRow(item: FeedbackItem, row: RegistryRow): boolean {
  if (item.target.kind === 'registry') return item.target.registryId === row.id;
  if (row.route === undefined) return false;
  return item.route === row.route || item.target.route === row.route;
}

export function daysSince(
  at: string,
  now: string = new Date().toISOString(),
): number | null {
  if (at === '') return null;
  const start = Date.parse(at);
  const end = Date.parse(now);
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return null;
  return Math.floor((end - start) / 86_400_000);
}

export function registryViews(
  registry: readonly RegistryRow[],
  items: readonly FeedbackItem[],
  seen: Readonly<Record<string, string>>,
  now: string = new Date().toISOString(),
): readonly RegistryViewRow[] {
  return registry.map((row) => {
    const targeting = items.filter((item) => targetsRow(item, row));
    return {
      ...row,
      feedbackCount: targeting.length,
      openCount: targeting.filter(
        (item) => item.status === 'new' || item.status === 'accepted',
      ).length,
      seenAt: seen[row.id] ?? null,
      daysSinceBeta: daysSince(row.betaAt, now),
    };
  });
}

export type RegistryGroup = 'feedbacked' | 'seen' | 'unfeedbacked';

export function inRegistryGroup(
  rows: readonly RegistryViewRow[],
  group: RegistryGroup,
): readonly RegistryViewRow[] {
  if (group === 'feedbacked')
    return rows.filter((row) => row.feedbackCount > 0);
  if (group === 'seen')
    return rows.filter((row) => row.feedbackCount === 0 && row.seenAt !== null);
  return rows.filter((row) => row.feedbackCount === 0 && row.seenAt === null);
}

export function byModule(
  rows: readonly RegistryViewRow[],
): readonly { module: string; rows: readonly RegistryViewRow[] }[] {
  const groups = new Map<string, RegistryViewRow[]>();
  for (const row of rows) {
    const list = groups.get(row.module) ?? [];
    list.push(row);
    groups.set(row.module, list);
  }
  return [...groups].map(([module, list]) => ({ module, rows: list }));
}

/** 悬浮入口的本机偏好；「看过，没意见」不在这里，真相在服务端 state.json。 */
export const PREFERENCE_STORAGE_KEY = 'dev-feedback.preference';

export interface FeedbackPreference {
  readonly locate: 'page' | 'element' | 'registry';
  readonly kinds: readonly FeedbackKind[];
  readonly collapsed: boolean;
}

export const DEFAULT_PREFERENCE: FeedbackPreference = {
  locate: 'page',
  kinds: [],
  collapsed: false,
};

export function readPreference(
  storage: Storage | undefined,
): FeedbackPreference {
  if (!storage) return DEFAULT_PREFERENCE;
  try {
    const raw = storage.getItem(PREFERENCE_STORAGE_KEY);
    if (!raw) return DEFAULT_PREFERENCE;
    const value = JSON.parse(raw) as Partial<FeedbackPreference>;
    const locate =
      value.locate === 'element' || value.locate === 'registry'
        ? value.locate
        : 'page';
    const kinds = Array.isArray(value.kinds)
      ? value.kinds.filter((kind): kind is FeedbackKind =>
          KIND_ORDER.includes(kind as FeedbackKind),
        )
      : [];
    return {
      locate,
      kinds,
      collapsed: value.collapsed === true,
    };
  } catch {
    return DEFAULT_PREFERENCE;
  }
}

export interface ElementLocation {
  readonly text: string;
  readonly locator: string;
  readonly source?: string;
}

export interface ElementDraftInput extends ElementLocation {
  readonly kind?: 'element';
}

/** 面板的草稿状态；纯函数只认这些值，不碰 React、localStorage 或网络。 */
export interface FeedbackDraftInput {
  readonly locate: 'page' | 'element' | 'registry';
  readonly route: string;
  readonly element: ElementDraftInput | null;
  readonly registryId: string;
  readonly text: string;
  readonly kinds: readonly FeedbackKind[];
  readonly severe: boolean;
  readonly screenshotId?: string | null;
}

export interface FeedbackRequestBody {
  readonly route: string;
  readonly target: FeedbackTarget;
  readonly text: string;
  readonly kinds: readonly FeedbackKind[];
  readonly severe: boolean;
  readonly screenshotId?: string;
}

/**
 * 组装 POST /dev/feedback 的请求体，形状与服务端 `dev-tools/feedback-schema.ts` 的 zod 一致。
 * 三种定位各带各的键：页面是 route、元素是 text/locator(可选 source)、登记行是 registryId；
 * 不把别的模式的空字段塞进 target —— 那正是页面模式被服务端 400 的原因。
 */
export function buildFeedbackRequestBody(
  input: FeedbackDraftInput,
): FeedbackRequestBody {
  const target: FeedbackTarget =
    input.locate === 'element' && input.element
      ? {
          kind: 'element',
          text: input.element.text,
          locator: input.element.locator,
          ...(input.element.source ? { source: input.element.source } : {}),
        }
      : input.locate === 'registry'
        ? { kind: 'registry', registryId: input.registryId }
        : { kind: 'page', route: input.route };

  return {
    route: input.route,
    target,
    text: input.text.trim(),
    kinds: [...input.kinds],
    severe: input.severe,
    ...(input.screenshotId ? { screenshotId: input.screenshotId } : {}),
  };
}

const TEXT_ATTRIBUTES = ['aria-label', 'alt', 'title', 'placeholder'] as const;

/**
 * 服务端要求 `target.text` 至少一个字符，所以拾取到的文字永远不能是空串。
 * 依次取可见文字、aria-label、alt、title、占位符；都没有就用「标签名 + 同类第几个」。
 * 定位信息只用真正的可见文字，避免把生成的描述误当成选择器。
 */
function elementText(node: HTMLElement, visible: string): string {
  if (visible) return visible.slice(0, 200);
  for (const attribute of TEXT_ATTRIBUTES) {
    const value = node.getAttribute(attribute)?.trim();
    if (value) return value.slice(0, 200);
  }
  const tag = node.tagName.toLowerCase();
  const ordinal =
    typeof document === 'undefined'
      ? 1
      : [...document.querySelectorAll(tag)].indexOf(node) + 1;
  return `${tag} #${ordinal || 1}`;
}

/**
 * 点选元素时从 DOM 取文字与定位信息；`data-testid` 优先，其次角色/名称，最后可见文字。
 *
 * React 19 的开发构建把 JSX 源文件作为 `_debugStack`（错误栈）而不是结构化的 `_source`/`_debugSource`
 * 挂在元素上：本仓库实测只能从 fiber 取到所属组件名，取不到可靠的 `fileName`/`lineNumber`。
 * 这里仍尝试几个可能的字段，取不到就退回文字与定位信息（设计「待补查 #1」的默认做法）。
 */
export function locateElement(node: Element): ElementLocation {
  const html = node as HTMLElement;
  const visible = (html.innerText || html.textContent || '').trim();
  const text = elementText(html, visible);
  const testId = html.getAttribute('data-testid');
  const ariaLabel = html.getAttribute('aria-label');
  const role = html.getAttribute('role');
  const locator = testId
    ? `[data-testid="${testId}"]`
    : ariaLabel
      ? `${role ?? 'element'}[name="${ariaLabel}"]`
      : role
        ? `[role="${role}"]`
        : visible
          ? `text="${visible.slice(0, 60)}"`
          : html.tagName.toLowerCase();

  const source = sourceFromFiber(node);
  return source ? { text, locator, source } : { text, locator };
}

interface DebugSource {
  readonly fileName?: string;
  readonly lineNumber?: number;
}

function formattedSource(source: DebugSource | undefined): string | undefined {
  if (
    !source ||
    typeof source.fileName !== 'string' ||
    typeof source.lineNumber !== 'number'
  ) {
    return undefined;
  }
  return `${source.fileName}:${source.lineNumber}`;
}

function sourceFromFiber(node: Element): string | undefined {
  const record = node as unknown as Record<string, unknown>;
  const fiberKey = Object.keys(record).find((key) =>
    key.startsWith('__reactFiber$'),
  );
  const propsKey = Object.keys(record).find((key) =>
    key.startsWith('__reactProps$'),
  );
  const props = propsKey
    ? (record[propsKey] as Record<string, unknown> | undefined)
    : undefined;
  const jsxSource = props?.__source as DebugSource | undefined;
  if (jsxSource) {
    const formatted = formattedSource(jsxSource);
    if (formatted) return formatted;
  }
  let fiber = fiberKey
    ? (record[fiberKey] as Record<string, unknown> | undefined)
    : undefined;
  for (let depth = 0; depth < 12 && fiber; depth += 1) {
    const direct = formattedSource(
      fiber._debugSource as DebugSource | undefined,
    );
    if (direct) return direct;
    const owner = fiber._debugOwner as Record<string, unknown> | undefined;
    const owned = owner
      ? formattedSource(owner._debugSource as DebugSource | undefined)
      : undefined;
    if (owned) return owned;
    fiber = fiber.return as Record<string, unknown> | undefined;
  }
  return undefined;
}
