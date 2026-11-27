import {
  encodeAuthorizationTitle,
  type PermissionGrant,
} from '@nocobase/authorization/core';
import {
  definePermissionSet,
  type PermissionSet,
} from '@nocobase/authorization/permission-sets';
import { defineSeed, type QueryAdapter } from '@nocobase/db';
import { randomUUID } from 'node:crypto';

import { businessPermissionSets } from './202611240001_seed_business_permission_sets.ts';

/**
 * R-065 页面片：财务角色的「支出记录」「到票记录」页面授权。
 * 已执行的 202611240001 不能回头改，所以新开一颗种子：全新安装时它跟着原种子跑，
 * 已有环境执行 `pnpm nocobase db apply` 时只跑这一颗。
 *
 * 只在 finance 角色的授权仍是原种子写出的那份时补两条页面授权；已补过、或管理员
 * 改过授权，都整颗跳过，不覆盖、不改写已有授权、不补用户指派。
 */
const NAMESPACE = 'app-local';
const FINANCE_KEY = 'finance';

const expensePage: PermissionGrant = {
  resource: { type: 'page', id: 'expenses' },
  actions: [{ action: 'access' }],
};
const invoicePage: PermissionGrant = {
  resource: { type: 'page', id: 'invoiceReceipts' },
  actions: [{ action: 'access' }],
};

export const financePagePermissionSet: PermissionSet = definePermissionSet(
  FINANCE_KEY,
)
  .grant(expensePage)
  .grant(invoicePage)
  .build();

export const financePageGrants: readonly PermissionGrant[] =
  financePagePermissionSet.grants;

export interface FinancePageGrantReport {
  readonly created: readonly string[];
  readonly granted: readonly string[];
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

/** 返回本次新建的角色与补过授权的角色；三条幂等路径都跳过写入。 */
export async function persistFinancePageGrants(
  query: QueryAdapter,
): Promise<FinancePageGrantReport> {
  const created: string[] = [];
  const granted: string[] = [];

  const row = await query
    .selectFrom('authorizationPermissionSets')
    .select(['key', 'grants'])
    .where('key', '=', FINANCE_KEY)
    .executeTakeFirst();

  if (!row) {
    // 全新库里 finance 一定由原种子建出；这里只是兜底，缺了就照原种子加页面授权建出它。
    const baseline = businessPermissionSets.find((set) => set.key === FINANCE_KEY);
    const title = baseline?.title ?? {
      key: 'permissionSets.business.finance',
      ns: NAMESPACE,
    };
    const now = new Date();
    await query
      .insertInto('authorizationPermissionSets')
      .values({
        id: randomUUID(),
        key: FINANCE_KEY,
        title: encodeAuthorizationTitle(title),
        grants: JSON.stringify(financePageGrants),
        createdAt: now,
        updatedAt: now,
      })
      .execute();
    created.push(FINANCE_KEY);
    return { created, granted };
  }

  const baseline = businessPermissionSets.find((set) => set.key === FINANCE_KEY);
  if (baseline === undefined) {
    throw new Error('[r065] 原种子里没有 finance，无法判断授权是否被改过');
  }
  const stored = grantsText(row.grants);
  if (stored !== JSON.stringify(baseline.grants)) return { created, granted };

  const existing = parseGrants(stored);
  const missing = financePageGrants.filter(
    (candidate) => !hasGrant(existing, candidate),
  );
  if (missing.length > 0) {
    await query
      .updateTable('authorizationPermissionSets')
      .set({
        grants: JSON.stringify([...existing, ...missing]),
        updatedAt: new Date(),
      })
      .where('key', '=', FINANCE_KEY)
      .execute();
    granted.push(FINANCE_KEY);
  }
  return { created, granted };
}

export default defineSeed({
  name: '202611280004_seed_finance_page_grants',
  async run({ query }) {
    await persistFinancePageGrants(query);
  },
});
