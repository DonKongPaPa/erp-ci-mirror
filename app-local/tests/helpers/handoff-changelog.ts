import { execFileSync } from 'node:child_process';

/**
 * 「HANDOFF 变更记录有没有落后于提交」的判定。
 *
 * 判定按提交顺序，不按时间：从新到旧看提交，第一个新增了变更记录条目的提交，
 * 连同比它更早的提交都算已记录；比它新的实质性提交（改了 HANDOFF.md 以外的文件）
 * 一条都不允许有。
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
  if (!commit.files.includes('HANDOFF.md')) {
    return false;
  }
  // 浅克隆（CI 的 fetch-depth: 1）取不到父提交，此时已有的条目都算这次新增的。
  // 所以完整的判定只发生在本地全量克隆里。
  const before = new Set(changelogStamps(git(repoRoot, 'show', `${commit.sha}^:HANDOFF.md`)));
  const after = changelogStamps(git(repoRoot, 'show', `${commit.sha}:HANDOFF.md`));
  return after.some((stamp) => !before.has(stamp));
}

/** 比最新一条记录更新的实质性提交，新的在前。空数组表示没有漏记。 */
export function findUnrecordedCommits(repoRoot: string, limit = 40): string[] {
  const unrecorded: string[] = [];
  for (const commit of recentCommits(repoRoot, limit)) {
    if (addsEntry(repoRoot, commit)) {
      break;
    }
    const substantive =
      commit.files.length > 0 && !commit.files.every((file) => file === 'HANDOFF.md');
    if (substantive) {
      unrecorded.push(`${commit.sha.slice(0, 7)} ${commit.subject}`);
    }
  }
  return unrecorded;
}
