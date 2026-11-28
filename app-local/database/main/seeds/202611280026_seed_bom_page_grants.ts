import type { PermissionGrant } from '@nocobase/authorization/core';
import {
  definePermissionSet,
  type PermissionSet,
} from '@nocobase/authorization/permission-sets';
import { defineSeed, type QueryAdapter } from '@nocobase/db';

/**
 * R-019 波 2 BOM 页面片：页面授权另开一颗种子，排在 022（BOM 业务授权建 craft）之后。
 * 全新安装时 022 先建 craft、本片后补页面；已有环境执行 `pnpm nocobase db apply` 只跑这一颗。
 *
 * 只给 craft（工艺）与 planning（计划经理）补「能打开 BOM 页面」这一条 `access`；
 * 维护入口（新建、编辑、作废）走 boms 业务资源的动作，只有管理员有，这里一行都不写。
 * 幂等只看「本条页面授权在不在」：在就跳过，不在就补；不比对角色的整份授权 ——
 * 后续种子给同一角色加东西也照常补。不覆盖、不重排、不建新角色、不补用户指派。
 */
const CRAFT_KEY = 'craft';
const PLANNING_KEY = 'planning';
export const BOMS_PAGE_ID = 'boms';

export const bomPageGrant: PermissionGrant = {
  resource: { type: 'page', id: BOMS_PAGE_ID },
  actions: [{ action: 'access' }],
};

export const bomPagePermissionSets: readonly PermissionSet[] = [
  definePermissionSet(CRAFT_KEY).grant(bomPageGrant).build(),
  definePermissionSet(PLANNING_KEY).grant(bomPageGrant).build(),
];

export interface BomPageGrantReport {
  readonly granted: readonly string[];
  readonly skipped: readonly string[];
}

const TARGET_KEYS = [CRAFT_KEY, PLANNING_KEY] as const;

function grantsText(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function parseGrants(value: unknown): PermissionGrant[] {
  return JSON.parse(grantsText(value)) as PermissionGrant[];
}

/** 页面授权必须是不带 policy 的 access：带条件的算不上「能打开」。 */
function hasGrant(stored: readonly PermissionGrant[]): boolean {
  return stored.some(
    (entry) =>
      entry.resource.type === bomPageGrant.resource.type &&
      entry.resource.id === bomPageGrant.resource.id &&
      entry.actions.some(
        (action) => action.action === 'access' && action.policy === undefined,
      ),
  );
}

/** 逐条判本条授权在不在；角色不存在时跳过（建角色是 022 的事），不写别的角色。 */
export async function persistBomPageGrants(
  query: QueryAdapter,
): Promise<BomPageGrantReport> {
  const granted: string[] = [];
  const skipped: string[] = [];
  for (const key of TARGET_KEYS) {
    const row = await query
      .selectFrom('authorizationPermissionSets')
      .select(['key', 'grants'])
      .where('key', '=', key)
      .executeTakeFirst();
    if (!row || hasGrant(parseGrants(row.grants))) {
      skipped.push(key);
      continue;
    }
    await query
      .updateTable('authorizationPermissionSets')
      .set({
        grants: JSON.stringify([...parseGrants(row.grants), bomPageGrant]),
        updatedAt: new Date(),
      })
      .where('key', '=', key)
      .execute();
    granted.push(key);
  }
  return { granted, skipped };
}

export default defineSeed({
  name: '202611280026_seed_bom_page_grants',
  async run({ query }) {
    await persistBomPageGrants(query);
  },
});
