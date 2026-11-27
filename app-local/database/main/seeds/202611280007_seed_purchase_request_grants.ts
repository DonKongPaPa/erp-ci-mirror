import type { PermissionGrant } from '@nocobase/authorization/core';
import {
  definePermissionSet,
  type PermissionSet,
} from '@nocobase/authorization/permission-sets';
import { defineSeed, type QueryAdapter } from '@nocobase/db';

import { businessPermissionSets } from './202611240001_seed_business_permission_sets.ts';
import { APPROVAL_GRANT } from './202611280002_seed_staff_approval_grants.ts';
import { planningPermissionSet } from './202611280003_seed_order_review_grants.ts';

/**
 * R-021 波 1 加片：请购单的授权不能回头追加到已经执行过的种子上 —— 老环境只警告
 * 校验和不匹配，不会重跑。本文件是新种子，全新安装时紧跟前面的种子跑，已有环境
 * `pnpm nocobase db apply` 只跑这一颗。
 *
 * 只给三个现成角色追加授权：planning 建改提交作废与读，staff 同样五件但按建单人收窄，
 * purchase 只读与转订单。没有新角色、不补用户指派，管理员改过的角色（授权不再是基线）
 * 整条跳过，已有的授权不覆盖、不重排。
 */
const NAMESPACE = 'app-local';
const RESOURCE = 'purchaseRequests';
/** 与 server/purchase-request-record-access.ts 的键逐字一致：staff 的「仅本人」。 */
const PURCHASE_REQUEST_CREATOR_OWN = 'purchaseRequest.creatorOwn';
const WRITER_ACTIONS = ['view', 'create', 'update', 'submit', 'void'] as const;

const scoped = (
  action: string,
): { action: string; policy: { type: string; scopes: Record<string, string> } } => ({
  action,
  policy: {
    type: 'composite',
    scopes: { [RESOURCE]: PURCHASE_REQUEST_CREATOR_OWN },
  },
});

export const planningPurchaseRequestGrant: PermissionGrant = {
  resource: { type: 'composite', id: RESOURCE },
  actions: WRITER_ACTIONS.map((action) => ({ action })),
};
export const staffPurchaseRequestGrant: PermissionGrant = {
  resource: { type: 'composite', id: RESOURCE },
  actions: WRITER_ACTIONS.map((action) => scoped(action)),
};
export const purchasePurchaseRequestGrant: PermissionGrant = {
  resource: { type: 'composite', id: RESOURCE },
  actions: [{ action: 'view' }, { action: 'convert' }],
};

export const purchaseRequestPermissionSets: readonly PermissionSet[] = [
  definePermissionSet('planning')
    .title({ key: 'permissionSets.business.planning', ns: NAMESPACE })
    .grant(planningPurchaseRequestGrant)
    .build(),
  definePermissionSet('staff')
    .title({ key: 'permissionSets.business.staff', ns: NAMESPACE })
    .grant(staffPurchaseRequestGrant)
    .build(),
  definePermissionSet('purchase')
    .title({ key: 'permissionSets.business.purchase', ns: NAMESPACE })
    .grant(purchasePurchaseRequestGrant)
    .build(),
];

export interface PurchaseRequestGrantReport {
  readonly granted: readonly string[];
  readonly skipped: readonly string[];
}

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
        entry.actions.some(
          (have) =>
            have.action === action.action &&
            JSON.stringify(have.policy) === JSON.stringify(action.policy),
        ),
      ),
  );
}

function baselineOf(key: string): readonly unknown[] {
  if (key === 'planning') return planningPermissionSet.grants;
  const base = businessPermissionSets.find((set) => set.key === key);
  if (base === undefined) throw new Error(`[r021-pr] 原种子里没有 ${key}`);
  return key === 'staff'
    ? [...base.grants, APPROVAL_GRANT]
    : base.grants;
}

/** 已有环境：基线没被改过才追加，已补过或被管理员改过都跳过。 */
export async function persistPurchaseRequestGrants(
  query: QueryAdapter,
): Promise<PurchaseRequestGrantReport> {
  const granted: string[] = [];
  const skipped: string[] = [];
  for (const set of purchaseRequestPermissionSets) {
    const row = await query
      .selectFrom('authorizationPermissionSets')
      .select(['key', 'grants', 'title'])
      .where('key', '=', set.key)
      .executeTakeFirst();
    if (!row) {
      skipped.push(set.key);
      continue;
    }
    const stored = parseGrants(row.grants);
    const candidate = set.grants[0];
    if (candidate === undefined || hasGrant(stored, candidate)) {
      skipped.push(set.key);
      continue;
    }
    const baseline = baselineOf(set.key);
    const unchanged = baseline.every((grant) => hasGrant(stored, grant as PermissionGrant));
    if (!unchanged) {
      skipped.push(set.key);
      continue;
    }
    await query
      .updateTable('authorizationPermissionSets')
      .set({
        grants: JSON.stringify([...stored, ...set.grants]),
        updatedAt: new Date(),
      })
      .where('key', '=', set.key)
      .execute();
    granted.push(set.key);
  }
  return { granted, skipped };
}

export default defineSeed({
  name: '202611280007_seed_purchase_request_grants',
  async run({ query }) {
    await persistPurchaseRequestGrants(query);
  },
});
