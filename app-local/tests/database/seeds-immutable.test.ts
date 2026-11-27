import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test } from 'vitest';

/**
 * R-075：已执行过的种子的内容散列。
 *
 * 框架只在全新安装时重放种子；执行过之后改源文件，它只警告校验和不匹配，不会重跑。
 * 所以这里逐字钉住文件内容：想加角色或权限集就写新种子，并把新文件也加进这张表。
 */
const EXECUTED_SEED_HASHES: Readonly<Record<string, string>> = {
  '202611240001_seed_business_permission_sets.ts':
    '8b24c0abbe25c747f43fb35eae4f4fd3f2d07f0fc41626935322963dac418e0d',
  '202611280001_seed_business_permission_sets_catchup.ts':
    '915cd1f645c8dacd2d2a3c427b72cc259f49868856dd42044f373e8536c87e43',
  '202611280003_seed_order_review_grants.ts':
    '63aa0da7404fd9a724142198eec68772ef524feed7d2d8b3ab426299624bc4fc',
};

const RULE =
  '种子执行过就不可改；新增角色或权限集写新的种子文件；改既有角色的授权走升级命令（`cli/authz/upgrade-*.ts`）；确需改已执行的种子，在同一次合并里更新这里的散列并写明为什么';

const SEEDS_DIR = fileURLToPath(
  new URL('../../database/main/seeds/', import.meta.url),
);

const sha256 = (content: Buffer | string): string =>
  createHash('sha256').update(content).digest('hex');

/**
 * 纯函数：对给定目录里钉住的种子逐个核对内容散列。临时目录里的假文件用来证明
 * 「散列对不上会红」，不需要真改仓库里的种子。
 */
function assertExecutedSeedHashes(
  directory: string,
  expected: Readonly<Record<string, string>> = EXECUTED_SEED_HASHES,
): void {
  for (const [name, pinned] of Object.entries(expected)) {
    let content: Buffer;
    try {
      content = readFileSync(path.join(directory, name));
    } catch {
      throw new Error(`${RULE}\n已执行的种子文件不见了：${name}`);
    }
    const actual = sha256(content);
    if (actual !== pinned) {
      throw new Error(
        `${RULE}\n${name} 的内容散列变了：期望 ${pinned}，实际 ${actual}`,
      );
    }
  }
}

test('R-075: the executed seed files still match their pinned hashes', () => {
  expect(() => assertExecutedSeedHashes(SEEDS_DIR)).not.toThrow();
});

test('R-075: a changed seed file is rejected with the immutability rule', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'hs-r075-seeds-'));
  try {
    const name = '202611240001_seed_business_permission_sets.ts';
    writeFileSync(path.join(directory, name), 'changed seed content\n');
    expect(() =>
      assertExecutedSeedHashes(directory, { [name]: '0'.repeat(64) }),
    ).toThrow(RULE);
    expect(() =>
      assertExecutedSeedHashes(directory, { [name]: '0'.repeat(64) }),
    ).toThrow(name);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('R-075: a missing executed seed file is rejected with the immutability rule', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'hs-r075-seeds-'));
  try {
    const name = '202611280001_seed_business_permission_sets_catchup.ts';
    expect(() =>
      assertExecutedSeedHashes(directory, { [name]: '0'.repeat(64) }),
    ).toThrow(RULE);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
