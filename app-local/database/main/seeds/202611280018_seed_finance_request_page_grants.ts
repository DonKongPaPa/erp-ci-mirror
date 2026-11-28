import type { PermissionGrant } from '@nocobase/authorization/core';
import {
  definePermissionSet,
  type PermissionSet,
} from '@nocobase/authorization/permission-sets';
import { defineSeed, type QueryAdapter } from '@nocobase/db';

/**
 * R-066 页面片：请款单与报销单页面的页面授权。已执行的种子不能回头改，所以新开一颗：
 * 全新安装时紧跟 017 跑，已有环境执行 `pnpm nocobase db apply` 只跑这一颗。
 *
 * 只给两个现成角色补「能打开请款 / 报销页面」这一条：staff 申请人、finance 审核与转出；
 * root 天然全通，不写进任何权限集。幂等只看本条授权在不在角色上（资源、动作），
 * 不比对角色的整份授权 —— 别的种子给同一角色加过授权、管理员改过别的授权都照常补，
 * 已有的一条不重复、不覆盖、不重排。角色不存在时跳过，不建新角色、不补用户指派。
 */
const NAMESPACE = 'app-local';

export const financeRequestPageGrant: PermissionGrant = {
  resource: { type: 'page', id: 'financeRequests' },
  actions: [{ action: 'access' }],
};

export const financeRequestPagePermissionSets: readonly PermissionSet[] = [
  definePermissionSet('staff')
    .title({ key: 'permissionSets.business.staff', ns: NAMESPACE })
    .grant(financeRequestPageGrant)
    .build(),
  definePermissionSet('finance')
    .title({ key: 'permissionSets.business.finance', ns: NAMESPACE })
    .grant(financeRequestPageGrant)
    .build(),
];

export interface FinanceRequestPageGrantReport {
  readonly granted: readonly string[];
  readonly skipped: readonly string[];
}

function grantsText(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function parseGrants(value: unknown): PermissionGrant[] {
  return JSON.parse(grantsText(value)) as PermissionGrant[];
}

/** 一条授权已经在角色上：资源与动作都要对上，不带 access 的宽授权不算。 */
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

/** 已有环境：缺这条页面授权的角色逐条补；整份授权被改过不影响这一条的判断。 */
export async function persistFinanceRequestPageGrants(
  query: QueryAdapter,
): Promise<FinanceRequestPageGrantReport> {
  const granted: string[] = [];
  const skipped: string[] = [];
  for (const set of financeRequestPagePermissionSets) {
    const row = await query
      .selectFrom('authorizationPermissionSets')
      .select(['key', 'grants'])
      .where('key', '=', set.key)
      .executeTakeFirst();
    if (!row) {
      skipped.push(set.key);
      continue;
    }
    const stored = parseGrants(row.grants);
    if (hasGrant(stored, financeRequestPageGrant)) {
      skipped.push(set.key);
      continue;
    }
    await query
      .updateTable('authorizationPermissionSets')
      .set({
        grants: JSON.stringify([...stored, financeRequestPageGrant]),
        updatedAt: new Date(),
      })
      .where('key', '=', set.key)
      .execute();
    granted.push(set.key);
  }
  return { granted, skipped };
}

export default defineSeed({
  name: '202611280018_seed_finance_request_page_grants',
  async run({ query }) {
    await persistFinanceRequestPageGrants(query);
  },
});
