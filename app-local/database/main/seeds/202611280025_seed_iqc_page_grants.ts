import type { PermissionGrant } from '@nocobase/authorization/core';
import {
  definePermissionSet,
  type PermissionSet,
} from '@nocobase/authorization/permission-sets';
import { defineSeed, type QueryAdapter } from '@nocobase/db';

/**
 * R-070 页面片：来料检验页面的页面授权。已执行的种子不能回头改，所以新开一颗：
 * 全新安装时紧跟 021 跑，已有环境执行 `pnpm nocobase db apply` 只跑这一颗。
 *
 * 只给三个现成角色补「能打开检验单页」：质量员建改完成、质量主管作废、采购只看列表与详情。
 * 仓管**不拿这一页**：他只是在建采购入库单时用 inspectionOrders.receiveView 窄读选单，
 * 那条动作已由 021 种子给出，页面授权再给就宽了。root 天然全通，不写进权限集。
 *
 * 幂等只看本条授权在不在（资源、动作），不比对整份授权 —— 021 给同一角色加过业务动作、
 * 管理员改过别的授权都照常补；已有的一条不重复、不覆盖、不重排。角色不存在时跳过，
 * 不建新角色、不补用户指派；重跑不写。
 */
const NAMESPACE = 'app-local';

export const inspectionsPageGrant: PermissionGrant = {
  resource: { type: 'page', id: 'inspectionOrders' },
  actions: [{ action: 'access' }],
};

/** 拿页面授权的角色；仓管刻意不在其中，理由见文件头。 */
export const IQC_PAGE_TARGETS = [
  'quality_inspector',
  'quality_manager',
  'purchase',
] as const;

export const iqcPagePermissionSets: readonly PermissionSet[] =
  IQC_PAGE_TARGETS.map((key) =>
    definePermissionSet(key)
      .title({
        key: `permissionSets.business.${key === 'quality_inspector' ? 'qualityInspector' : key === 'quality_manager' ? 'qualityManager' : 'purchase'}`,
        ns: NAMESPACE,
      })
      .grant(inspectionsPageGrant)
      .build(),
  );

export interface IqcPageGrantReport {
  readonly granted: readonly string[];
  readonly skipped: readonly string[];
}

function grantsText(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function parseGrants(value: unknown): PermissionGrant[] {
  return JSON.parse(grantsText(value)) as PermissionGrant[];
}

/** 一条授权已经在角色上：资源与动作都要对上，缺 access 的宽授权不算。 */
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

/** 已有环境：缺这条页面授权的角色逐条补；整份授权被改过不影响这一条的判断。 */
export async function persistIqcPageGrants(
  query: QueryAdapter,
): Promise<IqcPageGrantReport> {
  const granted: string[] = [];
  const skipped: string[] = [];
  for (const set of iqcPagePermissionSets) {
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
    if (hasGrant(stored, inspectionsPageGrant)) {
      skipped.push(set.key);
      continue;
    }
    await query
      .updateTable('authorizationPermissionSets')
      .set({
        grants: JSON.stringify([...stored, inspectionsPageGrant]),
        updatedAt: new Date(),
      })
      .where('key', '=', set.key)
      .execute();
    granted.push(set.key);
  }
  return { granted, skipped };
}

export default defineSeed({
  name: '202611280025_seed_iqc_page_grants',
  async run({ query }) {
    await persistIqcPageGrants(query);
  },
});
