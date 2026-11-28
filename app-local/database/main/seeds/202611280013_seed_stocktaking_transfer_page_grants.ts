import type { PermissionGrant } from '@nocobase/authorization/core';
import {
  definePermissionSet,
  type PermissionSet,
} from '@nocobase/authorization/permission-sets';
import { defineSeed, type QueryAdapter } from '@nocobase/db';

/**
 * R-020 波 2：盘点单与调拨单的页面授权。已执行的种子不能回头改，所以新开一颗：
 * 全新安装时紧跟前面的种子跑，已有环境执行 `pnpm nocobase db apply` 只跑这一颗。
 *
 * 只给现成的两个角色补「能打开这一页」：仓管拿盘点单与调拨单两页，财务只拿盘点单页
 * （它持 stocktakings.finish 监盘，不拿调拨）。root 天然全通，不登记。
 * 幂等只看本条授权在不在：在就跳过，不在就加；不比对整份授权 —— 011（请款报销）
 * 等种子先跑给 finance 加过业务动作时也照常补。不覆盖、不重排、不建新角色、
 * 不补用户指派；重跑不写。
 */
export const stocktakingPageGrant: PermissionGrant = {
  resource: { type: 'page', id: 'stocktakings' },
  actions: [{ action: 'access' }],
};

export const transferPageGrant: PermissionGrant = {
  resource: { type: 'page', id: 'transfers' },
  actions: [{ action: 'access' }],
};

export const stocktakingTransferPagePermissionSets: readonly PermissionSet[] = [
  definePermissionSet('warehouse')
    .grant(stocktakingPageGrant)
    .grant(transferPageGrant)
    .build(),
  definePermissionSet('finance').grant(stocktakingPageGrant).build(),
];

export interface StocktakingTransferPageGrantReport {
  readonly granted: readonly string[];
  readonly skipped: readonly string[];
}

const TARGET_GRANTS: Readonly<Record<string, readonly PermissionGrant[]>> = {
  warehouse: [stocktakingPageGrant, transferPageGrant],
  finance: [stocktakingPageGrant],
};

function grantsText(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function parseGrants(value: unknown): PermissionGrant[] {
  return JSON.parse(grantsText(value)) as PermissionGrant[];
}

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

/** 只给两个已有角色补缺的页面授权；返回补过的与跳过的 key。本片不建新角色。 */
export async function persistStocktakingTransferPageGrants(
  query: QueryAdapter,
): Promise<StocktakingTransferPageGrantReport> {
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
    const missing = wanted.filter((candidate) => !hasGrant(existing, candidate));
    if (missing.length === 0) {
      skipped.push(key);
      continue;
    }
    await query
      .updateTable('authorizationPermissionSets')
      .set({
        grants: JSON.stringify([...existing, ...missing]),
        updatedAt: new Date(),
      })
      .where('key', '=', key)
      .execute();
    granted.push(key);
  }
  return { granted, skipped };
}

export default defineSeed({
  name: '202611280013_seed_stocktaking_transfer_page_grants',
  async run({ query }) {
    await persistStocktakingTransferPageGrants(query);
  },
});
