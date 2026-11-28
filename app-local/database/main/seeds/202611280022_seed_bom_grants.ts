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

/**
 * R-019 波 2：BOM 授权不能回头追加到执行过的种子上。这一颗是新文件：
 * 全新安装时紧跟 018 跑，已有环境 `db apply` 只跑这一颗。
 *
 * 只建 craft 角色（同名 key 已存在就只补授权、不覆盖管理员改过的那份），
 * 再给 craft 与 planning 各补 BOM 的两个只读动作。维护动作只给 root，
 * 这里一行都不写；不补用户指派。幂等只看本条授权（资源、动作、范围）在不在，
 * 不比对角色的整份授权 —— 后来的种子给同一角色加东西也照常补。
 */
const NAMESPACE = 'app-local';
export const CRAFT_KEY = 'craft';
export const PLANNING_KEY = 'planning';
const BOM_ACTIONS = ['view', 'explode'] as const;

export const bomReadGrant: PermissionGrant = {
  resource: { type: 'composite', id: 'boms' },
  actions: BOM_ACTIONS.map((action) => ({ action })),
};

/** craft 只有这两个读动作；planning 只追加读动作，不碰它原有的台账授权。 */
export const craftPermissionSet: PermissionSet = definePermissionSet(CRAFT_KEY)
  .title({ key: 'permissionSets.business.craft', ns: NAMESPACE })
  .grant(bomReadGrant)
  .build();

export const planningBomPermissionSet: PermissionSet = definePermissionSet(PLANNING_KEY)
  .grant(bomReadGrant)
  .build();

export const bomPermissionSets: readonly PermissionSet[] = [
  craftPermissionSet,
  planningBomPermissionSet,
];

export interface BomGrantReport {
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

/** 已有环境：角色上缺的 BOM 读动作逐条补；整份授权被改过不影响判断。 */
export async function persistBomGrants(
  query: QueryAdapter,
): Promise<BomGrantReport> {
  const created: string[] = [];
  const granted: string[] = [];
  const skipped: string[] = [];

  for (const set of bomPermissionSets) {
    const row = await query
      .selectFrom('authorizationPermissionSets')
      .select(['key', 'grants'])
      .where('key', '=', set.key)
      .executeTakeFirst();

    if (!row) {
      // 只建 craft。planning 由 003 号种子建；这里不替它写整份权限集。
      if (set.key !== CRAFT_KEY) {
        skipped.push(set.key);
        continue;
      }
      const now = new Date();
      await query
        .insertInto('authorizationPermissionSets')
        .values({
          id: randomUUID(),
          key: set.key,
          title: encodeAuthorizationTitle(set.title),
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
  name: '202611280022_seed_bom_grants',
  async run({ query }) {
    await persistBomGrants(query);
  },
});
