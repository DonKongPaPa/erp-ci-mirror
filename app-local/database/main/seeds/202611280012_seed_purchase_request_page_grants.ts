import type { PermissionGrant } from '@nocobase/authorization/core';
import {
  definePermissionSet,
  type PermissionSet,
} from '@nocobase/authorization/permission-sets';
import { defineSeed, type QueryAdapter } from '@nocobase/db';

import { businessPermissionSets } from './202611240001_seed_business_permission_sets.ts';
import { APPROVAL_GRANT } from './202611280002_seed_staff_approval_grants.ts';
import { planningPermissionSet } from './202611280003_seed_order_review_grants.ts';
import { purchaseDocPrintGrants } from './202611280006_seed_doc_print_grants.ts';
import {
  planningPurchaseRequestGrant,
  purchasePurchaseRequestGrant,
  staffPurchaseRequestGrant,
} from './202611280007_seed_purchase_request_grants.ts';

/**
 * R-021 波 2：请购单页面的页面授权。已执行的种子不能回头改，所以新开一颗：
 * 全新安装时紧跟前面的种子跑，已有环境执行 `pnpm nocobase db apply` 只跑这一颗。
 *
 * 只给三个现成角色补「能打开请购单页面」这一条：planning、staff 提出需求，purchase
 * 接收并转订单；root 天然全通。角色不存在、已经补过、或授权已被管理员改过都整条跳过，
 * 不覆盖、不重排、不补用户指派。
 */
const NAMESPACE = 'app-local';

export const purchaseRequestPageGrant: PermissionGrant = {
  resource: { type: 'page', id: 'purchaseRequests' },
  actions: [{ action: 'access' }],
};

export const purchaseRequestPagePermissionSets: readonly PermissionSet[] = [
  definePermissionSet('planning')
    .title({ key: 'permissionSets.business.planning', ns: NAMESPACE })
    .grant(purchaseRequestPageGrant)
    .build(),
  definePermissionSet('staff')
    .title({ key: 'permissionSets.business.staff', ns: NAMESPACE })
    .grant(purchaseRequestPageGrant)
    .build(),
  definePermissionSet('purchase')
    .title({ key: 'permissionSets.business.purchase', ns: NAMESPACE })
    .grant(purchaseRequestPageGrant)
    .build(),
];

export interface PurchaseRequestPageGrantReport {
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
        entry.actions.some((have) => have.action === action.action),
      ),
  );
}

/** 已知形状 = 原种子 + 前面几颗补丁种子 + 本片授权；多出任何一条就当管理员改过。 */
function knownGrantsOf(key: string): readonly unknown[] {
  const base = businessPermissionSets.find((set) => set.key === key);
  if (key === 'planning') {
    return [
      ...planningPermissionSet.grants,
      planningPurchaseRequestGrant,
      purchaseRequestPageGrant,
    ];
  }
  if (base === undefined) throw new Error(`[r021-page] 原种子里没有 ${key}`);
  if (key === 'staff')
    return [
      ...base.grants,
      APPROVAL_GRANT,
      staffPurchaseRequestGrant,
      purchaseRequestPageGrant,
    ];
  return [
    ...base.grants,
    ...purchaseDocPrintGrants,
    purchasePurchaseRequestGrant,
    purchaseRequestPageGrant,
  ];
}

/** 只给三个已有角色补缺的页面授权；返回补过的与跳过的 key。本片不建新角色。 */
export async function persistPurchaseRequestPageGrants(
  query: QueryAdapter,
): Promise<PurchaseRequestPageGrantReport> {
  const granted: string[] = [];
  const skipped: string[] = [];
  for (const set of purchaseRequestPagePermissionSets) {
    const key = set.key;
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
    if (hasGrant(existing, purchaseRequestPageGrant)) {
      skipped.push(key);
      continue;
    }
    const known = knownGrantsOf(key).map((grant) => JSON.stringify(grant));
    if (existing.some((grant) => !known.includes(JSON.stringify(grant)))) {
      skipped.push(key);
      continue;
    }
    await query
      .updateTable('authorizationPermissionSets')
      .set({
        grants: JSON.stringify([...existing, purchaseRequestPageGrant]),
        updatedAt: new Date(),
      })
      .where('key', '=', key)
      .execute();
    granted.push(key);
  }
  return { granted, skipped };
}

export default defineSeed({
  name: '202611280012_seed_purchase_request_page_grants',
  async run({ query }) {
    await persistPurchaseRequestPageGrants(query);
  },
});
