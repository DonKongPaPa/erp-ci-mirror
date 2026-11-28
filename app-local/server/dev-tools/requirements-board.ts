/**
 * R-082 需求池看板的读与算：纯函数，不读文件、不碰数据库，便于按验收标准逐条测。
 *
 * 唯一数据源是需求池主表与跟进记录两份 Markdown。看板不另存一份数据，每次请求现算；
 * 一行坏数据只记进 `skipped`，不让整块板空掉。这里只进开发环境（见 `server/embedded.ts`），
 * 部署产物没有这个文件（R-073）。
 */

export type Blocking = '已完成' | '在途' | '待设计' | '等依赖' | '可开工';

export interface FollowUpEntry {
  readonly at: string;
  readonly text: string;
}

export interface ParsedRequirement {
  readonly id: string;
  readonly name: string;
  readonly category: string;
  readonly status: string;
  readonly weight: string;
  readonly hardDeps: readonly string[];
  readonly softDeps: readonly string[];
  readonly note: string;
}

export interface RequirementBoardItem extends ParsedRequirement {
  readonly lastEntry: FollowUpEntry | null;
  /** 这一条的全部跟进记录，按时间升序；没有就是空数组（看板抽屉的时间线用）。 */
  readonly entries: readonly FollowUpEntry[];
  readonly blocking: Blocking;
  readonly blockingDetail: string;
}

export interface RequirementsBoardSnapshot {
  readonly generatedAt: string;
  readonly totals: {
    readonly pool: number;
    readonly parsed: number;
    readonly skipped: number;
  };
  readonly requirements: readonly RequirementBoardItem[];
}

export interface RequirementsBoardSources {
  readonly pool: string;
  readonly followUps: string;
}

/** 反引号、粗体与首尾空格一律剥掉再比（需求池里 R-006 的状态写成 `**需业务决策**`）。 */
export function stripCell(raw: string): string {
  return raw.replaceAll('`', '').replaceAll('**', '').trim();
}

/** 主表七列：编号、名称、分类、状态、权重、依赖、说明。 */
const REQUIREMENT_ROW = /^\|\s*(R-\d+)\s*\|/u;
const SECTION_HEADING = /^##\s+/u;

function parseDeps(cell: string, kind: 'hard' | 'soft'): readonly string[] {
  const pattern = new RegExp(`${kind}\\(([^)]*)\\)`, 'gu');
  const found: string[] = [];
  for (const match of cell.matchAll(pattern)) {
    found.push(...(match[1]?.match(/[RX]-\d+/gu) ?? []));
  }
  return found;
}

/** 只在 `## 需求清单` 这一节里取 `| R-xxx |` 行；其他表的行不认识。 */
export function parseRequirementsPool(markdown: string): {
  readonly rows: readonly ParsedRequirement[];
  readonly skipped: number;
  readonly pool: number;
} {
  const lines = markdown.split('\n');
  const start = lines.findIndex(
    (line) => line.trim() === '## 需求清单' || line.trim() === '## 需求池',
  );
  if (start < 0) return { rows: [], skipped: 0, pool: 0 };
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (SECTION_HEADING.test(lines[index] ?? '')) {
      end = index;
      break;
    }
  }

  const rows: ParsedRequirement[] = [];
  let skipped = 0;
  let pool = 0;
  for (const line of lines.slice(start + 1, end)) {
    if (!REQUIREMENT_ROW.test(line)) continue;
    pool += 1;
    const cells = line.split('|').slice(1, -1).map(stripCell);
    if (cells.length < 7) {
      skipped += 1;
      continue;
    }
    const deps = cells[5] ?? '';
    rows.push({
      id: cells[0] ?? '',
      name: cells[1] ?? '',
      category: cells[2] ?? '',
      status: cells[3] ?? '',
      weight: cells[4] ?? '',
      hardDeps: parseDeps(deps, 'hard'),
      softDeps: parseDeps(deps, 'soft'),
      note: (cells.slice(6).join(' | ') ?? '').slice(0, 120),
    });
  }
  return { rows, skipped, pool };
}

interface CollectedEntry {
  readonly id: string;
  readonly at: string;
  readonly text: string;
}

/** 走一遍跟进记录：每个 `## R-xxx` 小节下的每一条 `- **时间** 正文`，带续行，按文件里的顺序。 */
function collectFollowUps(markdown: string, limit: number): CollectedEntry[] {
  const collected: CollectedEntry[] = [];
  let currentId: string | undefined;
  let collecting = false;
  let at = '';
  let parts: string[] = [];

  const finish = (): void => {
    if (collecting && currentId !== undefined) {
      collected.push({
        id: currentId,
        at,
        text: stripCell(parts.join(' ')).slice(0, limit),
      });
    }
    collecting = false;
  };

  for (const line of markdown.split('\n')) {
    const heading = /^##\s+(R-\d+)\b/u.exec(line);
    if (heading) {
      finish();
      currentId = heading[1];
      continue;
    }
    const entry = /^-\s+\*\*([^*]+)\*\*\s*(.*)$/u.exec(line);
    if (entry && currentId !== undefined) {
      finish();
      at = (entry[1] ?? '').trim();
      parts = [entry[2] ?? ''];
      collecting = true;
      continue;
    }
    if (collecting && /^\s+\S/u.test(line)) {
      parts.push(line.trim());
    }
  }
  finish();
  return collected;
}

const momentOf = (at: string): number => {
  const moment = Date.parse(at);
  return Number.isNaN(moment) ? 0 : moment;
};

/** 每个 `## R-xxx` 小节的最新一条（倒序，标题下第一条就是最新的）。 */
export function parseFollowUps(
  markdown: string,
): ReadonlyMap<string, FollowUpEntry> {
  const entries = new Map<string, FollowUpEntry>();
  for (const { id, ...entry } of collectFollowUps(markdown, 160)) {
    if (!entries.has(id)) entries.set(id, entry);
  }
  return entries;
}

/**
 * 每个 `## R-xxx` 小节的全部跟进记录，按时间升序（文件是倒序写的），文字给全文不截断。
 * 没有跟进的需求不在表里，由调用方按空数组处理。
 */
export function parseAllFollowUps(
  markdown: string,
): ReadonlyMap<string, readonly FollowUpEntry[]> {
  const grouped = new Map<string, FollowUpEntry[]>();
  for (const { id, ...entry } of collectFollowUps(markdown, Infinity)) {
    const list = grouped.get(id);
    if (list) list.push(entry);
    else grouped.set(id, [entry]);
  }
  for (const list of grouped.values()) {
    list.sort((left, right) => momentOf(left.at) - momentOf(right.at));
  }
  return grouped;
}

/**
 * 六种 blocking 的判定。硬依赖的完成状态只认主表里解析出来的状态；外部阻塞项（X-xxx）
 * 没有状态，按「没到已实现」处理，写进 `blockingDetail` 让人知道等谁。
 */
export function blockingFor(
  status: string,
  hardDeps: readonly string[],
  statusById: ReadonlyMap<string, string>,
  lastEntry: FollowUpEntry | null,
): { readonly blocking: Blocking; readonly blockingDetail: string } {
  if (status === '已实现') return { blocking: '已完成', blockingDetail: '' };
  if (status === '实现中' || status === '待验收') {
    return { blocking: '在途', blockingDetail: lastEntry?.at ?? '' };
  }
  if (
    status === '待评估' ||
    status === '可行性已确认' ||
    status === '需业务决策'
  ) {
    return { blocking: '待设计', blockingDetail: '' };
  }
  if (status === '方案已定') {
    const waiting = hardDeps.filter((dep) => statusById.get(dep) !== '已实现');
    return waiting.length > 0
      ? { blocking: '等依赖', blockingDetail: waiting.join(', ') }
      : { blocking: '可开工', blockingDetail: '' };
  }
  // 设计没定义的状态（例如「已排期」）按还没进设计处理，卡片仍要看得到。
  return { blocking: '待设计', blockingDetail: '' };
}

export function buildRequirementsBoard(
  poolMarkdown: string,
  followUpMarkdown: string,
  generatedAt: string = new Date().toISOString(),
): RequirementsBoardSnapshot {
  const { rows, skipped, pool } = parseRequirementsPool(poolMarkdown);
  const latest = parseFollowUps(followUpMarkdown);
  const all = parseAllFollowUps(followUpMarkdown);
  const statusById = new Map(rows.map((row) => [row.id, row.status]));
  const requirements = rows.map((row) => {
    const lastEntry = latest.get(row.id) ?? null;
    return {
      ...row,
      lastEntry,
      entries: all.get(row.id) ?? [],
      ...blockingFor(row.status, row.hardDeps, statusById, lastEntry),
    };
  });
  return {
    generatedAt,
    totals: { pool, parsed: rows.length, skipped },
    requirements,
  };
}
