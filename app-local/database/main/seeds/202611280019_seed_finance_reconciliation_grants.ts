import type { PermissionGrant } from '@nocobase/authorization/core';
import {
  definePermissionSet,
  type PermissionSet,
} from '@nocobase/authorization/permission-sets';
import { defineSeed, type QueryAdapter } from '@nocobase/db';

/**
 * R-065 复刻波 2：对账、核销、收入与开票的授权不能回头追加到已执行过的种子上。
 *
 * 本文件是新种子：全新安装时紧跟 018 跑，已有环境 `db apply` 只跑这一颗。
 * 只给现成的 finance 角色补四张财务单各五个动作，加销售订单的窄读 financeView；
 * 不建新角色、不补用户指派、不覆盖已有授权。幂等只看本条授权（资源、动作、范围）
 * 在不在角色上：缺哪条补哪条，已在就跳过；不比对整份授权，别的种子给同一角色
 * 加过授权也照常补。重跑不写，revision 不动。
 */
const NAMESPACE = 'app-local';
const DOC_RESOURCES = [
  'incomeRecords',
  'saleInvoiceRecords',
  'receivableRecons',
  'payableRecons',
] as const;
const DOC_ACTIONS = ['view', 'create', 'update', 'confirm', 'void'] as const;

/** 四份单据资源 + 一个销售窄读：每个动作单独一条，便于逐条判幂等。 */
export const financeReconciliationGrants: readonly PermissionGrant[] = [
  ...DOC_RESOURCES.map((id) => ({
    resource: { type: 'composite' as const, id },
    actions: DOC_ACTIONS.map((action) => ({ action })),
  })),
  {
    resource: { type: 'composite', id: 'salesOrders' },
    actions: [{ action: 'financeView' }],
  },
];

export const financeReconciliationPermissionSets: readonly PermissionSet[] = [
  definePermissionSet('finance')
    .title({ key: 'permissionSets.business.finance', ns: NAMESPACE })
    .grant(...financeReconciliationGrants)
    .build(),
];

export interface ReconciliationGrantReport {
  readonly granted: readonly string[];
  readonly skipped: readonly string[];
}

function grantsText(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function parseGrants(value: unknown): PermissionGrant[] {
  return JSON.parse(grantsText(value)) as PermissionGrant[];
}

/** 一条授权已经在角色上：资源与动作都要对上，范围不同的不算同一条。 */
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

/** 已有环境：finance 角色上缺的本片动作逐条补；整份授权被改过不影响判断。 */
export async function persistFinanceReconciliationGrants(
  query: QueryAdapter,
): Promise<ReconciliationGrantReport> {
  const granted: string[] = [];
  const skipped: string[] = [];
  for (const set of financeReconciliationPermissionSets) {
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
    const missing: PermissionGrant[] = [];
    for (const candidate of set.grants) {
      const actions = candidate.actions.filter(
        (action) => !hasAction(stored, candidate, action),
      );
      if (actions.length > 0) {
        missing.push({ resource: candidate.resource, actions });
      }
    }
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
  name: '202611280019_seed_finance_reconciliation_grants',
  async run({ query }) {
    await persistFinanceReconciliationGrants(query);
  },
});
