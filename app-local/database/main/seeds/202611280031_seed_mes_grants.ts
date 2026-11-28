import { randomUUID } from 'node:crypto';

import {
  encodeAuthorizationTitle,
  type PermissionGrant,
} from '@nocobase/authorization/core';
import {
  definePermissionSet,
  type PermissionSet,
} from '@nocobase/authorization/permission-sets';
import { defineSeed, type QueryAdapter } from '@nocobase/db';

/**
 * R-023 W3-1：MES 基础设置授权不能回头追加到已执行过的种子上。这一颗是新文件：
 * 全新安装时排在 026 之后，已有环境 `db apply` 只跑这一颗。
 *
 * 新建 production（车间）权限集：同名已存在时只补授权，不覆盖管理员改过的那份。
 * mesSettings.view 给 craft / planning / production / warehouse / quality_inspector；
 * mesSettings.priceView 只给 finance；maintain 只给 root，一行都不写。
 * 不补用户指派。幂等只看本条授权（资源、动作、范围）在不在角色上，不比对整份授权。
 */
const NAMESPACE = 'app-local';
export const PRODUCTION_KEY = 'production';
export const PRODUCTION_TITLE = {
  key: 'permissionSets.business.production',
  ns: NAMESPACE,
} as const;
export const RESOURCE = 'mesSettings';

/** 顺序即分配顺序；craft / planning / warehouse / quality_inspector / finance 已存在。 */
export const MES_ROLES = [
  'craft', 'planning', PRODUCTION_KEY, 'warehouse', 'quality_inspector', 'finance',
] as const;

export const MES_ACTIONS_BY_ROLE: Readonly<Record<string, readonly string[]>> = {
  craft: ['view'],
  planning: ['view'],
  production: ['view'],
  warehouse: ['view'],
  quality_inspector: ['view'],
  finance: ['priceView'],
};

export const mesGrant = (role: string): PermissionGrant => ({
  resource: { type: 'composite', id: RESOURCE },
  actions: (MES_ACTIONS_BY_ROLE[role] ?? []).map((action) => ({ action })),
});

export const productionPermissionSet: PermissionSet = definePermissionSet(PRODUCTION_KEY)
  .title(PRODUCTION_TITLE)
  .grant(mesGrant(PRODUCTION_KEY))
  .build();

export const mesPermissionSets: readonly PermissionSet[] = MES_ROLES.map((role) =>
  definePermissionSet(role)
    .grant(mesGrant(role))
    .build(),
);

export interface MesGrantReport {
  readonly created: readonly string[];
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

/** 已有环境：角色上缺的本片授权逐条补；整份授权被改过不影响这些动作的判断。 */
export async function persistMesGrants(
  query: QueryAdapter,
): Promise<MesGrantReport> {
  const created: string[] = [];
  const granted: string[] = [];
  const skipped: string[] = [];

  for (const set of mesPermissionSets) {
    const row = await query
      .selectFrom('authorizationPermissionSets')
      .select(['key', 'grants'])
      .where('key', '=', set.key)
      .executeTakeFirst();

    if (!row) {
      // 只建 production。别的角色由更早的种子建，这里不替它们写整份权限集。
      if (set.key !== PRODUCTION_KEY) {
        skipped.push(set.key);
        continue;
      }
      const now = new Date();
      await query
        .insertInto('authorizationPermissionSets')
        .values({
          id: randomUUID(),
          key: set.key,
          title: encodeAuthorizationTitle(PRODUCTION_TITLE),
          grants: JSON.stringify(set.grants),
          createdAt: now,
          updatedAt: now,
        })
        .execute();
      created.push(set.key);
      continue;
    }

    const stored = parseGrants(row.grants);
    const candidate = set.grants[0];
    if (candidate === undefined) {
      skipped.push(set.key);
      continue;
    }
    const missing = candidate.actions.filter(
      (action) => !hasAction(stored, candidate, action),
    );
    if (missing.length === 0) {
      skipped.push(set.key);
      continue;
    }
    const addition: PermissionGrant = {
      resource: candidate.resource,
      actions: missing,
    };
    await query
      .updateTable('authorizationPermissionSets')
      .set({ grants: JSON.stringify([...stored, addition]), updatedAt: new Date() })
      .where('key', '=', set.key)
      .execute();
    granted.push(set.key);
  }

  return { created, granted, skipped };
}

export default defineSeed({
  name: '202611280031_seed_mes_grants',
  async run({ query }) {
    await persistMesGrants(query);
  },
});
