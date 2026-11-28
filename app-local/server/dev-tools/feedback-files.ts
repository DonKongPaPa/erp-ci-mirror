import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  type FeedbackState,
  emptyFeedbackState,
  parseRegistry,
  parseStateFile,
} from './feedback.js';

/**
 * 反馈的三份文件：登记表在仓库里，反馈状态与截图在本机 `.local/feedback/`（不入库）。
 *
 * 仓库根的找法与需求池看板、待确认事项一致：从应用目录向上找带登记表的那一层。测试可以通过
 * `FEEDBACK_REPO_ROOT` 指到临时目录，不碰主检出的 `.local/`。
 */

const REGISTRY_RELATIVE = path.join('HANDOFF', 'tasks', 'feature-registry.json');
const STATE_RELATIVE = path.join('.local', 'feedback', 'state.json');
const ATTACHMENTS_RELATIVE = path.join('.local', 'feedback', 'attachments');
const MAX_ATTACHMENT_BYTES = 2 * 1024 * 1024;
const ATTACHMENT_ID = /^[0-9a-f-]{36}$/u;

const CONTENT_TYPES = {
  'image/png': 'png',
  'image/webp': 'webp',
  'image/jpeg': 'jpeg',
} as const;

export class FeedbackUnavailable extends Error {
  constructor(detail: string) {
    super(`测试反馈的数据源不可用：${detail}`);
    this.name = 'FeedbackUnavailable';
  }
}

export class InvalidAttachment extends Error {
  constructor(readonly reason: 'TYPE' | 'SIZE' | 'NOT_FOUND') {
    super(`截图无效：${reason}`);
    this.name = 'InvalidAttachment';
  }
}

function findRepoRoot(start: string): string | undefined {
  let current = path.resolve(start);
  for (;;) {
    if (existsSync(path.join(current, REGISTRY_RELATIVE))) return current;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/** 环境变量只给测试和脚本指临时仓库根用；正常启动按目录向上找。 */
export function resolveFeedbackRepoRoot(): string {
  const override = process.env.FEEDBACK_REPO_ROOT;
  if (override) return path.resolve(override);
  const root =
    findRepoRoot(process.cwd()) ??
    findRepoRoot(path.resolve(import.meta.dirname, '../../..'));
  if (!root) {
    throw new FeedbackUnavailable(
      '从应用目录向上找不到功能登记表所在的仓库根。',
    );
  }
  return root;
}

export function stateFilePath(root = resolveFeedbackRepoRoot()): string {
  return path.join(root, STATE_RELATIVE);
}

export function attachmentsDir(root = resolveFeedbackRepoRoot()): string {
  return path.join(root, ATTACHMENTS_RELATIVE);
}

export async function readRegistry() {
  const file = path.join(resolveFeedbackRepoRoot(), REGISTRY_RELATIVE);
  try {
    return parseRegistry(await readFile(file, 'utf8'));
  } catch (error) {
    throw new FeedbackUnavailable(
      error instanceof Error ? error.message : '读取功能登记表失败',
    );
  }
}

async function readState(): Promise<FeedbackState> {
  try {
    return parseStateFile(await readFile(stateFilePath(), 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return emptyFeedbackState();
    }
    throw new FeedbackUnavailable(
      error instanceof Error ? error.message : '读取反馈状态失败',
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

async function writeState(state: FeedbackState): Promise<void> {
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
  change: (state: FeedbackState) => { state: FeedbackState; result: T },
): Promise<T> {
  return withLock(async () => {
    const current = await readState();
    const { state, result } = change(current);
    await writeState(state);
    return result;
  });
}

export async function readFeedbackState(): Promise<FeedbackState> {
  return withLock(readState);
}

function extensionFor(contentType: string | undefined): string {
  const normalized = contentType?.split(';')[0]?.trim().toLowerCase();
  return normalized !== undefined && normalized in CONTENT_TYPES
    ? CONTENT_TYPES[normalized as keyof typeof CONTENT_TYPES]
    : '';
}

/** 粘贴的截图：只收 png、webp、jpeg，不超过 2 MB，前几个字节还要对得上格式。 */
export async function saveAttachment(
  bytes: Uint8Array,
  contentType: string | undefined,
): Promise<string> {
  const extension = extensionFor(contentType);
  if (extension === '') throw new InvalidAttachment('TYPE');
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_ATTACHMENT_BYTES) {
    throw new InvalidAttachment('SIZE');
  }
  const signature = Array.from(bytes.slice(0, 12));
  const matches =
    extension === 'png'
      ? signature.slice(0, 8).join(',') === '137,80,78,71,13,10,26,10'
      : extension === 'jpeg'
        ? signature[0] === 0xff && signature[1] === 0xd8
        : signature.slice(0, 4).join(',') === '82,73,70,70' &&
          String.fromCharCode(...signature.slice(8, 12)) === 'WEBP';
  if (!matches) throw new InvalidAttachment('TYPE');

  const id = randomUUID();
  const directory = attachmentsDir();
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, `${id}.${extension}`), bytes);
  return id;
}

export async function readAttachment(
  id: string,
): Promise<{ readonly bytes: Buffer; readonly contentType: string }> {
  if (!ATTACHMENT_ID.test(id)) throw new InvalidAttachment('NOT_FOUND');
  const directory = attachmentsDir();
  const found = await Promise.all(
    (Object.keys(CONTENT_TYPES) as (keyof typeof CONTENT_TYPES)[]).map(
      async (type) => {
        const file = path.join(directory, `${id}.${CONTENT_TYPES[type]}`);
        try {
          return { bytes: await readFile(file), contentType: type };
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
          throw error;
        }
      },
    ),
  );
  const result = found.find((entry) => entry !== undefined);
  if (!result) throw new InvalidAttachment('NOT_FOUND');
  return result;
}
