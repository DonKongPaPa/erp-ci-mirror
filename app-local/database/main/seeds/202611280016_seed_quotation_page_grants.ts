import type { PermissionGrant } from '@nocobase/authorization/core';
import {
  definePermissionSet,
  type PermissionSet,
} from '@nocobase/authorization/permission-sets';
import { defineSeed, type QueryAdapter } from '@nocobase/db';

/**
 * R-022 波 2：报价单页面的页面授权。已执行的种子不能回头改，所以补授权另开一颗；
 * 编号排在 015（订单评审与总台账页面）之后：全新安装时 015 先跑、本片后跑，
 * 已有环境执行 `pnpm nocobase db apply` 只跑这一颗。
 *
 * 只给 sales 补「能打开报价单页面」这一条；root 天然全通，别的角色一个动作都没有。
 * 幂等只看本条授权在不在 sales 上：在就跳过，不在就加；不比对整份授权 —— sales
 * 带着别的授权（例如 015 给的总台账页）时照常补上。不覆盖、不重排，不建新角色、
 * 不补用户指派。
 */
const NAMESPACE = 'app-local';
const SALES_KEY = 'sales';

export const quotationPageGrant: PermissionGrant = {
  resource: { type: 'page', id: 'quotations' },
  actions: [{ action: 'access' }],
};

export const quotationPagePermissionSet: PermissionSet = definePermissionSet(SALES_KEY)
  .title({ key: 'permissionSets.business.sales', ns: NAMESPACE })
  .grant(quotationPageGrant)
  .build();

export interface QuotationPageGrantReport {
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

export async function persistQuotationPageGrants(
  query: QueryAdapter,
): Promise<QuotationPageGrantReport> {
  const granted: string[] = [];
  const skipped: string[] = [];
  const row = await query
    .selectFrom('authorizationPermissionSets')
    .select(['key', 'grants'])
    .where('key', '=', SALES_KEY)
    .executeTakeFirst();
  if (!row) {
    skipped.push(SALES_KEY);
    return { granted, skipped };
  }
  const existing = parseGrants(row.grants);
  if (hasGrant(existing, quotationPageGrant)) {
    skipped.push(SALES_KEY);
    return { granted, skipped };
  }
  await query
    .updateTable('authorizationPermissionSets')
    .set({
      grants: JSON.stringify([...existing, quotationPageGrant]),
      updatedAt: new Date(),
    })
    .where('key', '=', SALES_KEY)
    .execute();
  granted.push(SALES_KEY);
  return { granted, skipped };
}

export default defineSeed({
  name: '202611280016_seed_quotation_page_grants',
  async run({ query }) {
    await persistQuotationPageGrants(query);
  },
});
