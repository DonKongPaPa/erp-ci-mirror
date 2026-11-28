import type { PermissionGrant } from '@nocobase/authorization/core';
import {
  definePermissionSet,
  type PermissionSet,
} from '@nocobase/authorization/permission-sets';
import { defineSeed, type QueryAdapter } from '@nocobase/db';

/**
 * R-066：请款单授权不能回头追加到已执行过的种子上 —— 老环境只警告校验和，不会重跑。
 * 本文件是新种子：全新安装时紧跟前面的种子跑，已有环境 `db apply` 只跑这一颗。
 *
 * 只给两个现成角色各追加请款单授权：staff 五个动作按建单人收窄，finance 只读与转支出。
 * 不建新角色、不补用户指派、不覆盖已有授权。幂等只看本条授权（资源、动作、范围）
 * 在不在角色上：缺哪条补哪条，已在就跳过；不比对整份授权，别的种子给同一角色加过
 * 授权也照常补。重跑不写，revision 不动。
 */
const NAMESPACE = 'app-local';
const RESOURCE = 'financeRequests';
/** 与 server/finance-request-record-access.ts 的键逐字一致。 */
const CREATOR_OWN = 'financeRequest.creatorOwn';
const WRITER_ACTIONS = ['view', 'create', 'update', 'submit', 'void'] as const;
const FINANCE_ACTIONS = ['view', 'convert'] as const;

const scoped = (
  action: string,
): { action: string; policy: { type: string; scopes: Record<string, string> } } => ({
  action,
  // 作用域的键是集合名，不是资源 id —— 资源叫 financeRequests，表叫 financeRequestDocs。
  policy: { type: 'composite', scopes: { financeRequestDocs: CREATOR_OWN } },
});

export const staffFinanceRequestGrant: PermissionGrant = {
  resource: { type: 'composite', id: RESOURCE },
  actions: WRITER_ACTIONS.map((action) => scoped(action)),
};
export const financeFinanceRequestGrant: PermissionGrant = {
  resource: { type: 'composite', id: RESOURCE },
  actions: FINANCE_ACTIONS.map((action) => ({ action })),
};

export const financeRequestPermissionSets: readonly PermissionSet[] = [
  definePermissionSet('staff')
    .title({ key: 'permissionSets.business.staff', ns: NAMESPACE })
    .grant(staffFinanceRequestGrant)
    .build(),
  definePermissionSet('finance')
    .title({ key: 'permissionSets.business.finance', ns: NAMESPACE })
    .grant(financeFinanceRequestGrant)
    .build(),
];

export interface FinanceRequestGrantReport {
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

/** 已有环境：角色上缺的请款单动作逐条补；整份授权被改过不影响这些动作的判断。 */
export async function persistFinanceRequestGrants(
  query: QueryAdapter,
): Promise<FinanceRequestGrantReport> {
  const granted: string[] = [];
  const skipped: string[] = [];
  for (const set of financeRequestPermissionSets) {
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
  name: '202611280017_seed_finance_request_grants',
  async run({ query }) {
    await persistFinanceRequestGrants(query);
  },
});
