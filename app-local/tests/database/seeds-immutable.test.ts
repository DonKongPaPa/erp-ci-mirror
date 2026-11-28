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
  '202611280004_seed_finance_page_grants.ts':
    'dc602bb042b79ef1795f6dd4f5c3958b62ed6c25e5744b0c50be57f7abf2cc6a',
  '202611280006_seed_doc_print_grants.ts':
    '772a744596e1a05ce1121e958aa82f55f3c4d713f36e8e0d004737fb1e9e1304',
  '202611280007_seed_purchase_request_grants.ts':
    'e2dece0caef2aa018bbb6a99639e0116b2ef5447e31f523dbdf63385bc3d3f34',
  // R-022 复刻波 1：报价授权新种子，随本片入库后同样不可改。
  '202611280009_seed_quotation_grants.ts':
    'cceff5aba936d20bd9d6876ce417de8dea25538ad041ee3ce711140c998de0b3',
  '202611280010_seed_stocktaking_transfer_grants.ts':
    '4e6cca552126636f55e0081ed53df61ca205c787ee0b907727dbeab0ac0edcea',
  '202611280017_seed_finance_request_grants.ts':
    'b2536823bd829c4f22637cd26c6dc22bfa7565a9e2d67b98e19e8e56e3fcac90',
  // R-066 页面片：请款 / 报销页面授权的新种子，随本片入库后同样不可改。
  '202611280018_seed_finance_request_page_grants.ts':
    'dd8f6ce2725876095f2fbc91ab5437df57b47a42c294556ec9a25a5ca5fd3722',
  // R-064 页面片：页面授权新种子，随本片入库后同样不可改。
  '202611280015_seed_order_review_page_grants.ts':
    'ab582d4d561158f9db12c3e9891bfb72457be508167fdcc638a8d54605d530b2',
  // R-021 波 2：请购单页面授权的新种子，随本片入库后同样不可改。
  '202611280012_seed_purchase_request_page_grants.ts':
    '987f44f94373a843987803963b5bde7c6369bf3907197eabda1c30bdb20458b4',
  // R-020 波 2：盘点单与调拨单页面授权的新种子，随本片入库后同样不可改。
  '202611280013_seed_stocktaking_transfer_page_grants.ts':
    'db44d78af12c1cb62b86dea10c1131024b22d0f64db5858cc25bc193908eef4f',
  // R-022 波 2：报价单页面授权的新种子，排在 015 之后；随本片入库后同样不可改。
  '202611280016_seed_quotation_page_grants.ts':
    'decc8433ac042d6fad58dae1bfeb3b769cf5c1990234d60f0b2451b0bf923d0a',
  // R-070 IQC：来料检验授权的新种子，随本片入库后同样不可改。
  '202611280021_seed_iqc_grants.ts':
    '134b9e56c9bd5635848378c7b5b9ab3ca4f6eabc51f639ef4b5921bb2dd0e765',
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
