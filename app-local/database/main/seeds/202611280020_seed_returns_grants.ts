import type { PermissionGrant } from '@nocobase/authorization/core';
import {
  definePermissionSet,
  type PermissionSet,
} from '@nocobase/authorization/permission-sets';
import { defineSeed, type QueryAdapter } from '@nocobase/db';

/**
 * R-020 波 2 加片二：退货授权不能回头追加到已执行过的种子上。这一颗排在 018 之后；
 * 已有环境 `db apply` 只跑这一颗。
 *
 * 采购 / 销售只发起、读、改、作废自己的退货；仓库只有两张单的过账；财务只有销售退货
 * 的一条窄读。幂等只看本条授权（资源、动作、范围）在不在角色上：缺哪条补哪条，
 * 不比对整份授权，别的种子给同一角色加过授权也照常补。重跑不写，revision 不动。
 */
const NAMESPACE = 'app-local';
const grant = (id: string, actions: readonly string[]): PermissionGrant => ({
  resource: { type: 'composite', id },
  actions: actions.map((action) => ({ action })),
});

export const purchaseReturnsGrant = grant('purchaseReturns', [
  'view', 'create', 'update', 'void',
]);
export const salesReturnsGrant = grant('salesReturns', [
  'view', 'create', 'update', 'void',
]);
export const warehousePurchasePostGrant = grant('purchaseReturns', ['post']);
export const warehouseSalesPostGrant = grant('salesReturns', ['post']);
export const financeSalesReturnGrant = grant('salesReturns', ['financeView']);
export const warehousePurchasePostViewGrant = grant('purchaseReturns', ['postView']);
export const warehouseSalesPostViewGrant = grant('salesReturns', ['postView']);

export const returnPermissionSets: readonly PermissionSet[] = [
  definePermissionSet('purchase')
    .title({ key: 'permissionSets.business.purchase', ns: NAMESPACE })
    .grant(purchaseReturnsGrant)
    .build(),
  definePermissionSet('sales')
    .title({ key: 'permissionSets.business.sales', ns: NAMESPACE })
    .grant(salesReturnsGrant)
    .build(),
  definePermissionSet('warehouse')
    .title({ key: 'permissionSets.business.warehouse', ns: NAMESPACE })
    .grant({
      resource: warehousePurchasePostGrant.resource,
      actions: [...warehousePurchasePostGrant.actions, ...warehousePurchasePostViewGrant.actions],
    })
    .grant({
      resource: warehouseSalesPostGrant.resource,
      actions: [...warehouseSalesPostGrant.actions, ...warehouseSalesPostViewGrant.actions],
    })
    .build(),
  definePermissionSet('finance')
    .title({ key: 'permissionSets.business.finance', ns: NAMESPACE })
    .grant(financeSalesReturnGrant)
    .build(),
];

export interface ReturnGrantReport {
  readonly granted: readonly string[];
  readonly skipped: readonly string[];
}

function grantsText(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function parseGrants(value: unknown): PermissionGrant[] {
  return JSON.parse(grantsText(value)) as PermissionGrant[];
}

/** 一条授权已经在角色上：资源、动作、范围都要对上，不带范围的宽授权不算。 */
function hasAction(
  stored: readonly PermissionGrant[],
  candidate: PermissionGrant,
  action: PermissionGrant['actions'][number],
): boolean {
  return stored.some(
    (entry) =>
      entry.resource.type === candidate.resource.type &&
      entry.resource.id === candidate.resource.id &&
      entry.actions.some(
        (have) =>
          have.action === action.action &&
          JSON.stringify(have.policy) === JSON.stringify(action.policy),
      ),
  );
}

/** 已有环境：每个角色缺的退货动作逐条补；整份授权被改过不影响这些动作的判断。 */
export async function persistReturnGrants(
  query: QueryAdapter,
): Promise<ReturnGrantReport> {
  const granted: string[] = [];
  const skipped: string[] = [];
  for (const set of returnPermissionSets) {
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
    const missing = set.grants.flatMap((candidate) =>
      candidate.actions
        .filter((action) => !hasAction(stored, candidate, action))
        .map((action) => ({ candidate, action })),
    );
    if (missing.length === 0) {
      skipped.push(set.key);
      continue;
    }
    const additions = new Map<string, PermissionGrant>();
    for (const { candidate, action } of missing) {
      const key = `${candidate.resource.type}:${candidate.resource.id}`;
      const existing = additions.get(key);
      if (existing === undefined) {
        additions.set(key, { resource: candidate.resource, actions: [action] });
      } else {
        additions.set(key, { ...existing, actions: [...existing.actions, action] });
      }
    }
    await query
      .updateTable('authorizationPermissionSets')
      .set({ grants: JSON.stringify([...stored, ...additions.values()]), updatedAt: new Date() })
      .where('key', '=', set.key)
      .execute();
    granted.push(set.key);
  }
  return { granted, skipped };
}

export default defineSeed({
  name: '202611280020_seed_returns_grants',
  async run({ query }) {
    await persistReturnGrants(query);
  },
});
