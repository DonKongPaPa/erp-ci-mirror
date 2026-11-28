import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type { RequirementsBoardSources } from './requirements-board.js';

/**
 * 从仓库根读两份 Markdown。开发环境里应用从 `app-local/` 起，`import.meta.dirname`
 * 也指向 `app-local/server/dev-tools/`，两条路都能向上找到仓库根。
 * 文件缺失时抛带路径的错，端点据此回 503，不把「源没了」伪装成空看板。
 */

const POOL_RELATIVE = path.join('wiki', '项目决策', '需求', '需求池.md');
const FOLLOW_UPS_RELATIVE = path.join(
  'wiki',
  '项目决策',
  '需求',
  '需求跟进记录.md',
);

export class RequirementsSourcesUnavailable extends Error {
  constructor(readonly detail: string) {
    super(`需求池看板的数据源不可用：${detail}`);
    this.name = 'RequirementsSourcesUnavailable';
  }
}

function findRepoRoot(start: string): string | undefined {
  let current = path.resolve(start);
  for (;;) {
    if (readableSync(path.join(current, POOL_RELATIVE))) return current;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/** 只做存在性判断，不打印内容；数据本身由下面的 readFile 读。 */
function readableSync(candidate: string): boolean {
  return existsSync(candidate);
}

export async function readRequirementsSources(): Promise<RequirementsBoardSources> {
  const root =
    findRepoRoot(process.cwd()) ??
    findRepoRoot(path.resolve(import.meta.dirname, '../../..'));
  if (!root) {
    throw new RequirementsSourcesUnavailable(
      '从应用目录向上找不到需求池文件所在的仓库根。',
    );
  }
  try {
    const [pool, followUps] = await Promise.all([
      readFile(path.join(root, POOL_RELATIVE), 'utf8'),
      readFile(path.join(root, FOLLOW_UPS_RELATIVE), 'utf8'),
    ]);
    return { pool, followUps };
  } catch (error) {
    throw new RequirementsSourcesUnavailable(
      error instanceof Error ? error.message : '读取需求池文件失败',
    );
  }
}
