import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * 「HANDOFF 变更记录有没有落后于提交」的判定。
 *
 * 判定按提交顺序，不按时间：从新到旧看提交，第一个新增了变更记录条目的提交，
 * 连同比它更早的提交都算已记录；比它新的实质性提交（改了交接文档以外的文件）
 * 一条都不允许有。交接文档自己 = 入口 HANDOFF.md + HANDOFF/ 下拆出来的文件。
 *
 * 为什么不比较时间：条目是在提交之前写进文件的，它的时间必然早于携带它的提交，
 * 「条目时间 < 提交时间」对每一次合规的提交都成立。按时间比较的第一版判定
 * 因此在它自己的引入提交（106b560）上失败了。
 */
/**
 * 变更记录小节的标题匹配。
 *
 * **按文字匹配，不按编号**：小节编号会随文档结构变化（加了「下一个会话从哪里开始」
 * 之后它从 8 变成 9），硬编码编号会让守门测试在无关改动上失败。
 */
export const CHANGELOG_HEADING_PATTERN = /^##\s+\d+\.\s*变更记录\s*$/mu;
export const CHANGELOG_HEADING = '变更记录';
/** 临时仓库 fixture 用的小节标题（真实文档的编号会变，fixture 用固定编号即可）。 */
export const CHANGELOG_FIXTURE_HEADING = '## 9. 变更记录';

/** 变更记录小节里的条目时间戳，按出现顺序（文档约定最新在上）。 */
export function changelogStamps(contents: string): string[] {
  const match = contents.match(CHANGELOG_HEADING_PATTERN);
  const section = match
    ? contents.slice((match.index ?? 0) + match[0].length)
    : '';
  const entry = /^- \*\*(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2})\*\*/gmu;
  return [...section.matchAll(entry)].map((match) => match[1] ?? '');
}

/**
 * 交接文档是渐进式的（R-048 验收 6）：入口 `HANDOFF.md` 之外，在途任务、坑、操作手册、
 * 归档都拆在 `HANDOFF/` 目录下，一个主题一个文件。条目只住在两个地方：
 * 最新的 15 条在入口，更早的在 `HANDOFF/changelog-archive.md`。
 */
export const HANDOFF_ENTRY_FILE = 'HANDOFF.md';
export const HANDOFF_DIRECTORY = 'HANDOFF';
export const HANDOFF_ARCHIVE_FILE = `${HANDOFF_DIRECTORY}/changelog-archive.md`;
export const HANDOFF_MAX_LINES = 150;
export const HANDOFF_MAX_ENTRIES = 15;

/** 这个路径是不是交接文档自己：入口，或者从入口拆出去的文件。 */
export function isHandoffFile(file: string): boolean {
  return file === HANDOFF_ENTRY_FILE || file.startsWith(`${HANDOFF_DIRECTORY}/`);
}

const ENTRY_LINE = /^- \*\*(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2})\*\*/u;

/**
 * 变更记录条目的全文，按出现顺序。一条 = 从时间戳那一行到下一条之前（末尾的空行不算）。
 * 归档文件没有小节标题，所以 afterHeading=false 时从文件里第一条条目算起。
 */
export function changelogEntries(contents: string, afterHeading: boolean): string[] {
  const lines = contents.split('\n');
  let start = 0;
  if (afterHeading) {
    const heading = lines.findIndex((line) => CHANGELOG_HEADING_PATTERN.test(line));
    if (heading < 0) {
      return [];
    }
    start = heading + 1;
  }
  const starts: number[] = [];
  for (let index = start; index < lines.length; index += 1) {
    if (ENTRY_LINE.test(lines[index] ?? '')) {
      starts.push(index);
    }
  }
  return starts.map((from, position) => {
    const to = starts[position + 1] ?? lines.length;
    const body = lines.slice(from, to);
    while (body.length > 0 && body[body.length - 1] === '') {
      body.pop();
    }
    return body.join('\n');
  });
}

/**
 * before 里有、after 里不够数的条目（按全文比，一个字都不能差）。
 * 返回每一条的时间戳与第一行的开头，给失败信息用。
 */
export function missingEntries(before: string[], after: string[]): string[] {
  const available = new Map<string, number>();
  for (const entry of after) {
    available.set(entry, (available.get(entry) ?? 0) + 1);
  }
  const missing: string[] = [];
  for (const entry of before) {
    const left = available.get(entry) ?? 0;
    if (left === 0) {
      const firstLine = entry.split('\n')[0] ?? '';
      const stamp = firstLine.match(ENTRY_LINE)?.[1] ?? '?';
      const text = firstLine.replace(ENTRY_LINE, '').trimStart().slice(0, 40);
      missing.push(`${stamp}｜${text}`);
    } else {
      available.set(entry, left - 1);
    }
  }
  return missing;
}

function git(repoRoot: string, ...args: string[]): string {
  try {
    return execFileSync('git', args, {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

interface Commit {
  sha: string;
  subject: string;
  files: string[];
}

function recentCommits(repoRoot: string, limit: number): Commit[] {
  // 每个提交以 \x01 开头，后面跟着它改动的文件。
  // 合并提交不带 -m 时不列文件，files 为空，不会被当成实质性提交。
  const log = git(repoRoot, 'log', `-${limit}`, '--format=%x01%H%x09%s', '--name-only');
  return log
    .split('\x01')
    .filter(Boolean)
    .map((block) => {
      const [header = '', ...files] = block.split('\n');
      const [sha = '', ...subject] = header.split('\t');
      return {
        sha,
        subject: subject.join('\t'),
        files: files.map((file) => file.trim()).filter(Boolean),
      };
    });
}

/** 这次提交是否给变更记录新增了至少一条条目。 */
function addsEntry(repoRoot: string, commit: Commit): boolean {
  if (!commit.files.includes(HANDOFF_ENTRY_FILE)) {
    return false;
  }
  // 浅克隆（CI 的 fetch-depth: 1）取不到父提交，此时已有的条目都算这次新增的。
  // 所以完整的判定只发生在本地全量克隆里。
  const before = new Set(changelogStamps(git(repoRoot, 'show', `${commit.sha}^:HANDOFF.md`)));
  const after = changelogStamps(git(repoRoot, 'show', `${commit.sha}:HANDOFF.md`));
  return after.some((stamp) => !before.has(stamp));
}

/**
 * 比最新一条记录更新的实质性提交，新的在前。空数组表示没有漏记。
 *
 * 只改了交接文档自己的提交不算实质性提交。拆分之后「交接文档自己」是入口加 `HANDOFF/` 下的文件，
 * 与拆分前「只改 HANDOFF.md 不算」是同一条规矩。
 */
export function findUnrecordedCommits(repoRoot: string, limit = 40): string[] {
  const unrecorded: string[] = [];
  for (const commit of recentCommits(repoRoot, limit)) {
    if (addsEntry(repoRoot, commit)) {
      break;
    }
    const substantive =
      commit.files.length > 0 && !commit.files.every(isHandoffFile);
    if (substantive) {
      unrecorded.push(`${commit.sha.slice(0, 7)} ${commit.subject}`);
    }
  }
  return unrecorded;
}

/** 取某个提交里的一份文件；取不到（提交里没有这个文件、或是浅克隆）回 null。 */
function blob(repoRoot: string, rev: string, file: string): string | null {
  try {
    // 不能用上面那个 git()：它会 trim，条目的全文要一个字不差。
    return execFileSync('git', ['show', `${rev}:${file}`], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
}

function entriesAt(entry: string | null, archive: string | null): string[] {
  return [
    ...changelogEntries(entry ?? '', true),
    ...changelogEntries(archive ?? '', false),
  ];
}

/**
 * 这一次改动有没有丢掉或者改掉已经有的变更记录条目。空数组表示没有。
 *
 * 变更记录是 append-only：条目只能在入口与归档之间挪，一个字不能改。拆分之后挪动变多了
 * （入口只留 15 条；并行的分支各自加条目再合并），所以除了「有没有加条目」还要守「有没有少条目」。
 *
 * 比两处：工作区对 HEAD（提交之前就能发现）；HEAD 对它的每一个父提交（合并提交两个父提交都比，
 * 合并时丢掉一边的条目就是在这里抓住）。浅克隆取不到父提交时那一侧不比，理由与漏记判定相同。
 */
export function findLostEntries(repoRoot: string): string[] {
  const read = (file: string): string | null => {
    const target = path.join(repoRoot, file);
    return existsSync(target) ? readFileSync(target, 'utf8') : null;
  };
  const headEntry = blob(repoRoot, 'HEAD', HANDOFF_ENTRY_FILE);
  if (headEntry === null) {
    return [];
  }
  const head = entriesAt(headEntry, blob(repoRoot, 'HEAD', HANDOFF_ARCHIVE_FILE));
  const working = entriesAt(read(HANDOFF_ENTRY_FILE), read(HANDOFF_ARCHIVE_FILE));
  const lost = missingEntries(head, working).map((entry) => `工作区对 HEAD：${entry}`);
  for (const parent of git(repoRoot, 'rev-parse', 'HEAD^@').split('\n').filter(Boolean)) {
    const parentEntry = blob(repoRoot, parent, HANDOFF_ENTRY_FILE);
    if (parentEntry === null) {
      continue;
    }
    const parentArchive = blob(repoRoot, parent, HANDOFF_ARCHIVE_FILE);
    const entries = entriesAt(parentEntry, parentArchive);
    for (const entry of missingEntries(entries, head)) {
      lost.push(`HEAD 对父提交 ${parent.slice(0, 7)}：${entry}`);
    }
  }
  return lost;
}
