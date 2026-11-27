import type { PermissionGrant } from '@nocobase/authorization/core';
import {
  definePermissionSet,
  type PermissionSet,
} from '@nocobase/authorization/permission-sets';
import { defineSeed, type QueryAdapter } from '@nocobase/db';

import { businessPermissionSets } from './202611240001_seed_business_permission_sets.ts';
import { financePageGrants } from './202611280004_seed_finance_page_grants.ts';
import { docPrintPermissionSets } from './202611280006_seed_doc_print_grants.ts';

/**
 * R-020 波 1：盘点与调拨授权不能回头追加到已经执行过的 202611240001 上。
 * 这一颗在新库里紧跟原种子与其补丁跑；已有环境执行 `pnpm nocobase db apply` 时只跑这一颗。
 *
 * 仓管拿盘点的建、改、读、作废与调拨五动作；财务拿盘点的读与监盘结束，不拿调拨、
 * 出入库的写权。root 不受限，不登记。角色已不存在、已有全部目标授权、或授权已不是
 * 已知形状（管理员改过）时整条跳过，不覆盖、不改写、不补用户指派。
 */
const stocktakingGrant = (
  actions: readonly ('view' | 'create' | 'update' | 'finish' | 'void')[],
): PermissionGrant => ({
  resource: { type: 'composite', id: 'stocktakings' },
  actions: actions.map((action) => ({ action })),
});
const transferGrant = (
  actions: readonly ('view' | 'create' | 'update' | 'post' | 'void')[],
): PermissionGrant => ({
  resource: { type: 'composite', id: 'transfers' },
  actions: actions.map((action) => ({ action })),
});

export const warehouseStocktakingTransferGrants: readonly PermissionGrant[] = [
  stocktakingGrant(['view', 'create', 'update', 'void']),
  transferGrant(['view', 'create', 'update', 'post', 'void']),
];
export const financeStocktakingGrant: PermissionGrant =
  stocktakingGrant(['view', 'finish']);

export const stocktakingTransferPermissionSets: readonly PermissionSet[] = [
  definePermissionSet('warehouse')
    .grant(warehouseStocktakingTransferGrants[0])
    .grant(warehouseStocktakingTransferGrants[1])
    .build(),
  definePermissionSet('finance').grant(financeStocktakingGrant).build(),
];

export interface StocktakingTransferGrantReport {
  readonly created: readonly string[];
  readonly granted: readonly string[];
  readonly skipped: readonly string[];
}

const TARGET_GRANTS: Readonly<Record<string, readonly PermissionGrant[]>> = {
  warehouse: warehouseStocktakingTransferGrants,
  finance: [financeStocktakingGrant],
};

/** json 列在 QueryAdapter 里读回来是字符串；兼容已经解析成对象的方言。 */
function grantsText(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function parseGrants(value: unknown): PermissionGrant[] {
  return JSON.parse(grantsText(value)) as PermissionGrant[];
}

/** 一条授权视为已存在：资源相同，且它逐条含有所需动作。 */
function hasGrant(
  stored: readonly PermissionGrant[],
  candidate: PermissionGrant,
): boolean {
  return stored.some(
    (entry) =>
      entry.resource.type === candidate.resource.type &&
      entry.resource.id === candidate.resource.id &&
      candidate.actions.every((action) =>
        entry.actions.some((have) => have.action === action.action),
      ),
  );
}

/** 已知形状 = 原种子 + 已执行的补丁种子 + 本片授权；额外的授权一律视为管理员改过。 */
function knownGrantsOf(key: string, wanted: readonly PermissionGrant[]): PermissionGrant[] {
  const baseline = businessPermissionSets.find((set) => set.key === key);
  if (baseline === undefined) throw new Error(`[r020-stocktake] 原种子里没有 ${key}`);
  const print = docPrintPermissionSets
    .filter((set) => set.key === key)
    .flatMap((set) => set.grants);
  const financePages = key === 'finance' ? financePageGrants : [];
  return [...baseline.grants, ...print, ...financePages, ...wanted];
}

export async function persistStocktakingTransferGrants(
  query: QueryAdapter,
): Promise<StocktakingTransferGrantReport> {
  const created: string[] = [];
  const granted: string[] = [];
  const skipped: string[] = [];

  for (const [key, wanted] of Object.entries(TARGET_GRANTS)) {
    const row = await query
      .selectFrom('authorizationPermissionSets')
      .select(['key', 'grants'])
      .where('key', '=', key)
      .executeTakeFirst();
    if (!row) {
      skipped.push(key);
      continue;
    }
    const existing = parseGrants(row.grants);
    const known = knownGrantsOf(key, wanted).map((grant) => JSON.stringify(grant));
    if (existing.some((grant) => !known.includes(JSON.stringify(grant)))) {
      skipped.push(key);
      continue;
    }
    const missing = wanted.filter((candidate) => !hasGrant(existing, candidate));
    if (missing.length === 0) {
      skipped.push(key);
      continue;
    }
    await query
      .updateTable('authorizationPermissionSets')
      .set({ grants: JSON.stringify([...existing, ...missing]), updatedAt: new Date() })
      .where('key', '=', key)
      .execute();
    granted.push(key);
  }

  return { created, granted, skipped };
}

export default defineSeed({
  name: '202611280010_seed_stocktaking_transfer_grants',
  async run({ query }) {
    await persistStocktakingTransferGrants(query);
  },
});
