import type { PermissionGrant } from '@nocobase/authorization/core';
import { defineSeed, type QueryAdapter } from '@nocobase/db';

import { businessPermissionSets } from './202611240001_seed_business_permission_sets.ts';
import { APPROVAL_GRANT } from './202611280002_seed_staff_approval_grants.ts';
import { financePageGrants } from './202611280004_seed_finance_page_grants.ts';
import { salesDocPrintGrants } from './202611280006_seed_doc_print_grants.ts';
import {
  planningPermissionSet,
  salesReviewPermissionSet,
} from './202611280003_seed_order_review_grants.ts';
import { planningPurchaseRequestGrant } from './202611280007_seed_purchase_request_grants.ts';
import { purchaseRequestPageGrant } from './202611280012_seed_purchase_request_page_grants.ts';
import { salesQuotationGrant } from './202611280009_seed_quotation_grants.ts';

/**
 * R-064 页面片：open 页面与选人端点的授权。已执行的 003 只给了业务动作，页面授权不能
 * 回头追加到它上面（框架只警告校验和、不会重跑），所以另开这一颗：全新安装时跟着跑，
 * 已有环境 `pnpm nocobase db apply` 时只跑这一颗。
 *
 * - planning：要给销售订单页 access，才能打开详情看到评审页签；订单总台账页 access；
 *   bizOptions.view，才能用 R-072 的收窄人员选项端点选评审人（不授予「用户 · 读」）。
 * - sales：原种子已有销售订单页 access；这里只补订单总台账页 access。
 * 已有的授权不覆盖；角色的授权只要出现已知形状之外的条目（管理员改过），整条跳过。
 */
const salesOrdersPageGrant: PermissionGrant = {
  resource: { type: 'page', id: 'salesOrders' },
  actions: [{ action: 'access' }],
};
const orderLedgerPageGrant: PermissionGrant = {
  resource: { type: 'page', id: 'orderLedger' },
  actions: [{ action: 'access' }],
};
const bizOptionsGrant: PermissionGrant = {
  resource: { type: 'composite', id: 'bizOptions' },
  actions: [{ action: 'view' }],
};

export const planningPageGrants: readonly PermissionGrant[] = [
  salesOrdersPageGrant,
  orderLedgerPageGrant,
  bizOptionsGrant,
];
export const salesPageGrants: readonly PermissionGrant[] = [orderLedgerPageGrant];

export interface OrderReviewPageGrantReport {
  readonly granted: readonly string[];
  readonly skipped: readonly string[];
}

const TARGET_GRANTS: Readonly<Record<string, readonly PermissionGrant[]>> = {
  planning: planningPageGrants,
  sales: salesPageGrants,
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

/**
 * 「已知形状」= 原种子 + 此前几颗补丁（含 012 的请购单页面授权）+ 本片授权；
 * 出现任何别的授权就认定管理员改过，整条跳过。planning 由 003 建出
 * （没有原种子那份），sales 在全新库里已经带 R-064 的两条只读授权、
 * R-076 的打印与 R-022 波 1 的报价授权。
 */
function knownGrants(key: string): readonly unknown[] {
  const baseline = businessPermissionSets.find((set) => set.key === key);
  if (baseline === undefined && key !== 'planning') {
    throw new Error(`[r064-pages] 原种子里没有 ${key}，无法判断授权是否被改过`);
  }
  return [
    ...(baseline?.grants ?? []),
    ...(key === 'sales' ? salesReviewPermissionSet.grants : []),
    ...(key === 'planning' ? planningPermissionSet.grants : []),
    ...(key === 'planning' ? [planningPurchaseRequestGrant] : []),
    // 012 按文件名次序先于本片执行，planning 已带请购单页面授权；不认作已知形状就会整条跳过。
    ...(key === 'planning' ? [purchaseRequestPageGrant] : []),
    ...(key === 'sales' ? salesDocPrintGrants : []),
    ...(key === 'sales' ? [salesQuotationGrant] : []),
    ...(key === 'staff' ? [APPROVAL_GRANT] : []),
    ...(key === 'finance' ? financePageGrants : []),
    ...(TARGET_GRANTS[key] ?? []),
  ];
}

export async function persistOrderReviewPageGrants(
  query: QueryAdapter,
): Promise<OrderReviewPageGrantReport> {
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
    const known = knownGrants(key).map((grant) => JSON.stringify(grant));
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
  name: '202611280015_seed_order_review_page_grants',
  async run({ query }) {
    await persistOrderReviewPageGrants(query);
  },
});
