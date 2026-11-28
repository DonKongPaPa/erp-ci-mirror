import type { PermissionGrant } from '@nocobase/authorization/core';
import {
  definePermissionSet,
  type PermissionSet,
} from '@nocobase/authorization/permission-sets';
import { defineSeed, type QueryAdapter } from '@nocobase/db';

import { REPORT_ROLES } from './202611280023_seed_reports_grants.ts';

/**
 * R-078 页面片：报表中心 `/reports` 的页面授权。服务端种子 023 已给五个岗位四个入口动作，
 * 这一颗只补「能打开页面」这一条；root 天然全通，不写进任何权限集。
 *
 * 幂等只看本条授权在不在角色上（资源 + 动作），不比对整份授权：别的种子加过、管理员改过
 * 的授权都照常补；已有的一条不重复、不覆盖、不重排。角色不存在时跳过，不建新角色、不补用户指派。
 * 已有环境执行 `pnpm nocobase authz upgrade-r078-pages`（或一次性 db apply 只跑这一颗）。
 */
const NAMESPACE = 'app-local';

export const reportsPageGrant: PermissionGrant = {
  resource: { type: 'page', id: 'reports' },
  actions: [{ action: 'access' }],
};

export const reportsPagePermissionSets: readonly PermissionSet[] = REPORT_ROLES.map(
  (role) =>
    definePermissionSet(role)
      .title({ key: `permissionSets.business.${role}`, ns: NAMESPACE })
      .grant(reportsPageGrant)
      .build(),
);

export interface ReportsPageGrantReport {
  readonly granted: readonly string[];
  readonly skipped: readonly string[];
}

function grantsText(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function parseGrants(value: unknown): PermissionGrant[] {
  return JSON.parse(grantsText(value)) as PermissionGrant[];
}

/** 一条授权已经在角色上：资源与动作都要对上，不带 access 的宽授权不算。 */
export function hasReportsPageGrant(stored: readonly PermissionGrant[]): boolean {
  return stored.some(
    (entry) =>
      entry.resource.type === reportsPageGrant.resource.type &&
      entry.resource.id === reportsPageGrant.resource.id &&
      reportsPageGrant.actions.every((action) =>
        entry.actions.some((have) => have.action === action.action),
      ),
  );
}

/** 已有环境：缺这条页面授权的角色逐条补；整份授权被改过不影响这一条的判断。 */
export async function persistReportsPageGrants(
  query: QueryAdapter,
): Promise<ReportsPageGrantReport> {
  const granted: string[] = [];
  const skipped: string[] = [];
  for (const set of reportsPagePermissionSets) {
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
    if (hasReportsPageGrant(stored)) {
      skipped.push(set.key);
      continue;
    }
    await query
      .updateTable('authorizationPermissionSets')
      .set({
        grants: JSON.stringify([...stored, reportsPageGrant]),
        updatedAt: new Date(),
      })
      .where('key', '=', set.key)
      .execute();
    granted.push(set.key);
  }
  return { granted, skipped };
}

export default defineSeed({
  name: '202611280029_seed_reports_page_grants',
  async run({ query }) {
    await persistReportsPageGrants(query);
  },
});
