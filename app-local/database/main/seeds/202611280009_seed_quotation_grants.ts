import type { PermissionGrant } from '@nocobase/authorization/core';
import {
  definePermissionSet,
  type PermissionSet,
} from '@nocobase/authorization/permission-sets';
import { defineSeed, type QueryAdapter } from '@nocobase/db';

import { businessPermissionSets } from './202611240001_seed_business_permission_sets.ts';
import { salesReviewPermissionSet } from './202611280003_seed_order_review_grants.ts';
import { salesDocPrintGrants } from './202611280006_seed_doc_print_grants.ts';

/**
 * R-022 复刻波 1：报价授权不能回头追加到已经执行过的 202611240001 上 —— 框架只警告校验和
 * 不匹配，不会重跑。这一颗新文件：全新安装时紧跟其它补丁种子跑；已有环境执行
 * `pnpm nocobase db apply` 时只跑这一颗。
 *
 * 只给 sales 补 quotations 六个动作，不建新角色、不碰别的角色、不补用户指派。
 * 已有销售角色只要出现「原种子 + R-064 补丁 + R-076 打印 + 本片授权」之外的授权
 * （管理员改过），整条跳过，不覆盖、不改写。授权定义只写在这里，原种子一字不改。
 */
const SALES_KEY = 'sales';
const QUOTATION_ACTIONS = ['view', 'create', 'update', 'confirm', 'convert', 'void'] as const;

export const salesQuotationGrant: PermissionGrant = {
  resource: { type: 'composite', id: 'quotations' },
  actions: QUOTATION_ACTIONS.map((action) => ({ action })),
};

export const salesQuotationPermissionSet: PermissionSet = definePermissionSet(SALES_KEY)
  .grant(salesQuotationGrant)
  .build();

export interface QuotationGrantReport {
  readonly created: readonly string[];
  readonly granted: readonly string[];
  readonly skipped: readonly string[];
}

/** json 列在 QueryAdapter 里读回来是字符串；兼容已经解析成对象的方言。 */
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

export async function persistQuotationGrants(
  query: QueryAdapter,
): Promise<QuotationGrantReport> {
  const created: string[] = [];
  const granted: string[] = [];
  const skipped: string[] = [];

  const row = await query
    .selectFrom('authorizationPermissionSets')
    .select(['key', 'grants'])
    .where('key', '=', SALES_KEY)
    .executeTakeFirst();
  if (!row) {
    skipped.push(SALES_KEY);
    return { created, granted, skipped };
  }
  const baseline = businessPermissionSets.find((set) => set.key === SALES_KEY);
  if (baseline === undefined) {
    throw new Error('[r022-quotation] 原种子里没有 sales，无法判断授权是否被改过');
  }
  const stored = grantsText(row.grants);
  const existing = parseGrants(stored);
  const known = [
    ...baseline.grants,
    ...salesReviewPermissionSet.grants,
    ...salesDocPrintGrants,
    salesQuotationGrant,
  ].map((grant) => JSON.stringify(grant));
  if (existing.some((grant) => !known.includes(JSON.stringify(grant)))) {
    skipped.push(SALES_KEY);
    return { created, granted, skipped };
  }
  if (hasGrant(existing, salesQuotationGrant)) {
    skipped.push(SALES_KEY);
    return { created, granted, skipped };
  }
  await query
    .updateTable('authorizationPermissionSets')
    .set({ grants: JSON.stringify([...existing, salesQuotationGrant]), updatedAt: new Date() })
    .where('key', '=', SALES_KEY)
    .execute();
  granted.push(SALES_KEY);
  return { created, granted, skipped };
}

export default defineSeed({
  name: '202611280009_seed_quotation_grants',
  async run({ query }) {
    await persistQuotationGrants(query);
  },
});
