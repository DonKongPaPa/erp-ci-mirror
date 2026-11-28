import type { PermissionGrant } from '@nocobase/authorization/core';
import {
  definePermissionSet,
  type PermissionSet,
} from '@nocobase/authorization/permission-sets';
import { defineSeed, type QueryAdapter } from '@nocobase/db';

/**
 * R-020 波 2 加片二：采购退货与销售退货的页面授权。已执行的种子不能回头改，这一颗排在 020 之后。
 *
 * 只给现成的四个角色补「能打开这一页」：采购拿采购退货页，销售拿销售退货页，
 * 仓管拿两页（只读待过账并过账），财务只拿销售退货页（financeView 窄读）。
 * root 天然全通，不登记。
 *
 * 幂等只看本条授权在不在（资源、动作），不比对整份授权：020 给同一角色加过退货业务动作、
 * 013 给同一角色加过盘点页，都照常补。缺哪条补哪条，已有的授权不重排、不覆盖，
 * 不建新角色、不补用户指派；重跑不写。
 */
export const purchaseReturnsPageGrant: PermissionGrant = {
  resource: { type: 'page', id: 'purchaseReturns' },
  actions: [{ action: 'access' }],
};

export const salesReturnsPageGrant: PermissionGrant = {
  resource: { type: 'page', id: 'salesReturns' },
  actions: [{ action: 'access' }],
};

export const returnsPagePermissionSets: readonly PermissionSet[] = [
  definePermissionSet('purchase').grant(purchaseReturnsPageGrant).build(),
  definePermissionSet('sales').grant(salesReturnsPageGrant).build(),
  definePermissionSet('warehouse')
    .grant(purchaseReturnsPageGrant)
    .grant(salesReturnsPageGrant)
    .build(),
  definePermissionSet('finance').grant(salesReturnsPageGrant).build(),
];

export const RETURNS_PAGE_TARGET_GRANTS: Readonly<Record<string, readonly PermissionGrant[]>> = {
  purchase: [purchaseReturnsPageGrant],
  sales: [salesReturnsPageGrant],
  warehouse: [purchaseReturnsPageGrant, salesReturnsPageGrant],
  finance: [salesReturnsPageGrant],
};

export interface ReturnsPageGrantReport {
  readonly granted: readonly string[];
  readonly skipped: readonly string[];
}

function grantsText(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function parseGrants(value: unknown): PermissionGrant[] {
  return JSON.parse(grantsText(value)) as PermissionGrant[];
}

/** 一条授权已经在角色上：资源与动作都要对上。 */
function hasGrant(stored: readonly PermissionGrant[], candidate: PermissionGrant): boolean {
  return stored.some(
    (entry) =>
      entry.resource.type === candidate.resource.type &&
      entry.resource.id === candidate.resource.id &&
      candidate.actions.every((action) =>
        entry.actions.some((have) => have.action === action.action),
      ),
  );
}

/** 逐条判在不在，缺哪条补哪条；整份授权被别的种子改过不影响判断。 */
export async function persistReturnsPageGrants(
  query: QueryAdapter,
): Promise<ReturnsPageGrantReport> {
  const granted: string[] = [];
  const skipped: string[] = [];
  for (const [key, wanted] of Object.entries(RETURNS_PAGE_TARGET_GRANTS)) {
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
      .set({ grants: JSON.stringify([...existing, ...missing]), updatedAt: new Date() })
      .where('key', '=', key)
      .execute();
    granted.push(key);
  }
  return { granted, skipped };
}

export default defineSeed({
  name: '202611280027_seed_returns_page_grants',
  async run({ query }) {
    await persistReturnsPageGrants(query);
  },
});
