import type { PermissionGrant } from '@nocobase/authorization/core';
import {
  definePermissionSet,
  type PermissionSet,
} from '@nocobase/authorization/permission-sets';
import { defineSeed, type QueryAdapter } from '@nocobase/db';

/**
 * R-065 第二片页面片：四张财务页面的页面授权。已执行的种子不能回头改，所以新开一颗：
 * 全新安装时紧跟 019 跑，已有环境执行 `pnpm nocobase db apply` 只跑这一颗。
 *
 * 只给现成的 finance 角色补「能打开收入记录、销售开票、应收对账单、应付对账单」四条页面授权；
 * root 天然全通，不写进任何权限集。幂等按「本条授权在不在」逐条判（页面资源、动作、范围），
 * 不比对角色的整份授权 —— 别的种子给 finance 加过业务动作或页面授权都照常补，
 * 已有的一条不重复、不覆盖、不重排。角色不存在时跳过，不建新角色、不补用户指派。
 */
const NAMESPACE = 'app-local';

export const FINANCE_RECONCILIATION_PAGE_IDS = [
  'incomeRecords',
  'saleInvoiceRecords',
  'receivableRecons',
  'payableRecons',
] as const;

export const financeReconciliationPageGrants: readonly PermissionGrant[] =
  FINANCE_RECONCILIATION_PAGE_IDS.map((id) => ({
    resource: { type: 'page', id },
    actions: [{ action: 'access' }],
  }));

export const financeReconciliationPagePermissionSets: readonly PermissionSet[] = [
  definePermissionSet('finance')
    .title({ key: 'permissionSets.business.finance', ns: NAMESPACE })
    .grant(...financeReconciliationPageGrants)
    .build(),
];

export interface FinanceReconciliationPageGrantReport {
  readonly granted: readonly string[];
  readonly skipped: readonly string[];
}

function grantsText(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function parseGrants(value: unknown): PermissionGrant[] {
  return JSON.parse(grantsText(value)) as PermissionGrant[];
}

/** 一条页面授权在不在：资源、动作与范围都要对上，带条件的 access 不算同一条。 */
function hasPageGrant(
  stored: readonly PermissionGrant[],
  candidate: PermissionGrant,
): boolean {
  return stored.some(
    (entry) =>
      entry.resource.type === candidate.resource.type &&
      entry.resource.id === candidate.resource.id &&
      entry.actions.some(
        (have) =>
          have.action === 'access' &&
          JSON.stringify(have.policy) === JSON.stringify(candidate.actions[0]?.policy),
      ),
  );
}

/** 已有环境：缺哪条页面授权补哪条；整份授权被改过不影响逐条判断。 */
export async function persistFinanceReconciliationPageGrants(
  query: QueryAdapter,
): Promise<FinanceReconciliationPageGrantReport> {
  const granted: string[] = [];
  const skipped: string[] = [];
  for (const set of financeReconciliationPagePermissionSets) {
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
    const missing = financeReconciliationPageGrants.filter(
      (candidate) => !hasPageGrant(stored, candidate),
    );
    if (missing.length === 0) {
      skipped.push(set.key);
      continue;
    }
    await query
      .updateTable('authorizationPermissionSets')
      .set({ grants: JSON.stringify([...stored, ...missing]), updatedAt: new Date() })
      .where('key', '=', set.key)
      .execute();
    granted.push(set.key);
  }
  return { granted, skipped };
}

export default defineSeed({
  name: '202611280028_seed_finance_reconciliation_page_grants',
  async run({ query }) {
    await persistFinanceReconciliationPageGrants(query);
  },
});
