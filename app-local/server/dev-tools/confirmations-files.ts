import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  type ConfirmationQuestion,
  type ConfirmationState,
  emptyConfirmationState,
  parseQuestionList,
  parseStateFile,
} from './confirmations.js';

/**
 * 两份文件的位置：清单在仓库里，状态在本机 `.local/`（不入库）。
 *
 * 仓库根的找法与需求池看板一致：从应用目录向上找带清单文件的那一层。测试可以通过
 * `CONFIRMATIONS_REPO_ROOT` 指到临时目录，不碰主检出的 `.local/`。
 */

const QUESTIONS_RELATIVE = path.join('HANDOFF', 'tasks', 'confirmations.json');
const STATE_RELATIVE = path.join('.local', 'confirmations', 'state.json');

export class ConfirmationsUnavailable extends Error {
  constructor(detail: string) {
    super(`待确认事项的数据源不可用：${detail}`);
    this.name = 'ConfirmationsUnavailable';
  }
}

function readableSync(candidate: string): boolean {
  return existsSync(candidate);
}

function findRepoRoot(start: string): string | undefined {
  let current = path.resolve(start);
  for (;;) {
    if (readableSync(path.join(current, QUESTIONS_RELATIVE))) return current;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/** 环境变量只给测试和脚本指临时仓库根用；正常启动按目录向上找。 */
export function resolveConfirmationsRepoRoot(): string {
  const override = process.env.CONFIRMATIONS_REPO_ROOT;
  if (override) return path.resolve(override);
  const root =
    findRepoRoot(process.cwd()) ??
    findRepoRoot(path.resolve(import.meta.dirname, '../../..'));
  if (!root) {
    throw new ConfirmationsUnavailable(
      '从应用目录向上找不到问题清单所在的仓库根。',
    );
  }
  return root;
}

export function stateFilePath(root = resolveConfirmationsRepoRoot()): string {
  return path.join(root, STATE_RELATIVE);
}

export async function readQuestions(): Promise<readonly ConfirmationQuestion[]> {
  const file = path.join(resolveConfirmationsRepoRoot(), QUESTIONS_RELATIVE);
  try {
    return parseQuestionList(await readFile(file, 'utf8'));
  } catch (error) {
    throw new ConfirmationsUnavailable(
      error instanceof Error ? error.message : '读取问题清单失败',
    );
  }
}

async function readState(): Promise<ConfirmationState> {
  try {
    return parseStateFile(await readFile(stateFilePath(), 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return emptyConfirmationState();
    }
    throw new ConfirmationsUnavailable(
      error instanceof Error ? error.message : '读取答复状态失败',
    );
  }
}

/**
 * 整体覆盖写：先写同目录的临时文件再 rename，半截写不会留下半个 state.json。
 * 串行执行读—改—写（简单的进程内互斥），单机单用户够用；不提供删除。
 */
let writeQueue: Promise<unknown> = Promise.resolve();

function withLock<T>(task: () => Promise<T>): Promise<T> {
  const result = writeQueue.then(task, task);
  writeQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

async function writeState(state: ConfirmationState): Promise<void> {
  const target = stateFilePath();
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}-${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

export function mutateState<T>(
  change: (state: ConfirmationState) => { state: ConfirmationState; result: T },
): Promise<T> {
  return withLock(async () => {
    const current = await readState();
    const { state, result } = change(current);
    await writeState(state);
    return result;
  });
}

export async function readConfirmationState(): Promise<ConfirmationState> {
  return withLock(readState);
}
