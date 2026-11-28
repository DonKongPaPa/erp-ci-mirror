import type { PermissionGrant } from '@nocobase/authorization/core';
import {
  definePermissionSet,
  type PermissionSet,
} from '@nocobase/authorization/permission-sets';
import { defineSeed, type QueryAdapter } from '@nocobase/db';

/**
 * R-070：来料检验授权不能回头追加到已执行过的种子上 —— 老环境只警告校验和，不会重跑。
 * 本文件是新种子：全新安装时紧跟 018 跑，已有环境 `db apply` 只跑这一颗。
 *
 * 只给四个现成角色各追加一条检验授权：建改完成给质量员，作废给质量主管，
 * view 给两个质量角色与采购，receiveView 只给仓管；root 直通，不写进权限集。
 * 不建新角色、不补用户指派、不覆盖已有授权。幂等只看本条授权（资源、动作、范围）
 * 在不在角色上：缺哪条补哪条，已在就跳过；不比对整份授权，别的种子给同一角色加过
 * 授权也照常补。重跑不写，revision 不动。
 */
const NAMESPACE = 'app-local';
const RESOURCE = 'inspectionOrders';

export const IQC_ACTIONS: Readonly<Record<string, readonly string[]>> = {
  quality_inspector: ['view', 'create', 'update', 'complete'],
  quality_manager: ['view', 'void'],
  purchase: ['view'],
  warehouse: ['receiveView'],
};

export const iqcGrant = (role: string): PermissionGrant => ({
  resource: { type: 'composite', id: RESOURCE },
  actions: (IQC_ACTIONS[role] ?? []).map((action) => ({ action })),
});

export const inspectorIqcGrant = iqcGrant('quality_inspector');
export const managerIqcGrant = iqcGrant('quality_manager');
export const purchaseIqcGrant = iqcGrant('purchase');
export const warehouseIqcGrant = iqcGrant('warehouse');

export const iqcPermissionSets: readonly PermissionSet[] = [
  definePermissionSet('quality_inspector')
    .title({ key: 'permissionSets.business.qualityInspector', ns: NAMESPACE })
    .grant(inspectorIqcGrant)
    .build(),
  definePermissionSet('quality_manager')
    .title({ key: 'permissionSets.business.qualityManager', ns: NAMESPACE })
    .grant(managerIqcGrant)
    .build(),
  definePermissionSet('purchase')
    .title({ key: 'permissionSets.business.purchase', ns: NAMESPACE })
    .grant(purchaseIqcGrant)
    .build(),
  definePermissionSet('warehouse')
    .title({ key: 'permissionSets.business.warehouse', ns: NAMESPACE })
    .grant(warehouseIqcGrant)
    .build(),
];

export interface IqcGrantReport {
  readonly granted: readonly string[];
  readonly skipped: readonly string[];
}

function grantsText(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function parseGrants(value: unknown): PermissionGrant[] {
  return JSON.parse(grantsText(value)) as PermissionGrant[];
}

/** 一条授权已经在角色上：资源与动作都要对上；不带范围的宽授权这里没有。 */
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

/** 已有环境：角色上缺的检验动作逐条补；整份授权被改过不影响这些动作的判断。 */
export async function persistIqcGrants(
  query: QueryAdapter,
): Promise<IqcGrantReport> {
  const granted: string[] = [];
  const skipped: string[] = [];
  for (const set of iqcPermissionSets) {
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
  return { granted, skipped };
}

export default defineSeed({
  name: '202611280021_seed_iqc_grants',
  async run({ query }) {
    await persistIqcGrants(query);
  },
});
