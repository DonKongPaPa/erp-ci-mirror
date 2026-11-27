import { defineSeed, type QueryAdapter } from '@nocobase/db';

/**
 * R-017 M3：给业务基线角色 `staff` 补审批的两个业务动作。
 *
 * 为什么是一条新种子而不是改原种子：原种子 202611240001 已经在开发库执行过，
 * 改它会被校验和挡住（R-075）；也不写升级命令，因为种子在全新安装与已有环境里
 * 都会随 `db apply` 执行，不必有人记得跑命令。本文件只追加授权，不动原种子。
 *
 * 形状与 `server/approvals-resources.ts` 的声明一致：资源 `approval` 的 `submit`
 * 与 `review`，两把范围键都只有「仅本人」。已有这条有效授权就跳过；管理员改过
 * 的其他授权逐条原样保留（只 append，不覆盖、不重排）；管理员若把这把资源改成
 * 别的值，不算「已持有」，会再补一条正确的，不删他的那条。
 *
 * 写入带「读到的 grants 原值」作条件：读到之后有人改过角色就写不到行，本轮跳过，
 * 下次 apply 再补。这样不会把别人的并发修改覆盖掉。
 */
const ROLE = 'staff';
const RESOURCE_ID = 'approval';

export interface StoredGrantAction {
  readonly action: string;
  readonly policy?: {
    readonly type?: string;
    readonly scopes?: Readonly<Record<string, unknown>>;
  };
}
export interface StoredGrant {
  readonly resource: { readonly type: string; readonly id: string };
  readonly actions: readonly StoredGrantAction[];
}

export const APPROVAL_GRANT: StoredGrant = {
  resource: { type: 'composite', id: RESOURCE_ID },
  actions: [
    {
      action: 'submit',
      policy: { type: 'composite', scopes: { approvals: 'approval.applicantOwn' } },
    },
    {
      action: 'review',
      policy: {
        type: 'composite',
        scopes: { approvalRecords: 'approval.assigneeOwn' },
      },
    },
  ],
};

const EXPECT = {
  submit: 'approval.applicantOwn',
  review: 'approval.assigneeOwn',
} as const;

function parseGrants(value: unknown): StoredGrant[] {
  if (Array.isArray(value)) return value as StoredGrant[];
  if (typeof value !== 'string') return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as StoredGrant[]) : [];
  } catch {
    return [];
  }
}

function hasEffectiveAction(grants: readonly StoredGrant[], action: string): boolean {
  return grants.some(
    (grant) =>
      grant.resource?.type === 'composite' &&
      grant.resource.id === RESOURCE_ID &&
      grant.actions.some((entry) => {
        if (entry.action !== action) return false;
        const scopes = entry.policy?.scopes;
        const key = action === 'submit' ? 'approvals' : 'approvalRecords';
        return entry.policy?.type === 'composite' && scopes?.[key] === EXPECT[action as keyof typeof EXPECT];
      }),
  );
}

export type StaffApprovalGrantResult =
  | 'granted'
  | 'already'
  | 'missing-role'
  | 'concurrent-change';

/**
 * 单独成函数，测试可以直接喂「已有」「管理员改过」「全新」三种 grants 形状。
 * 返回值写进 seed 日志以外的调用点；seed 本身不打印任何人员信息。
 */
export async function grantStaffApprovalActions(
  query: QueryAdapter,
): Promise<StaffApprovalGrantResult> {
  const row = await query
    .selectFrom('authorizationPermissionSets')
    .select(['grants', 'updatedAt'])
    .where('key', '=', ROLE)
    .executeTakeFirst();
  if (!row) return 'missing-role';

  const raw = (row as { grants?: unknown }).grants;
  const previousUpdatedAt = (row as { updatedAt?: unknown }).updatedAt;
  const grants = parseGrants(raw);
  if (
    hasEffectiveAction(grants, 'submit') &&
    hasEffectiveAction(grants, 'review')
  ) {
    return 'already';
  }
  const next = [...grants, APPROVAL_GRANT];
  let update = query
    .updateTable('authorizationPermissionSets')
    .set({ grants: JSON.stringify(next), updatedAt: new Date() })
    .where('key', '=', ROLE);
  // json 列不能直接和参数做 = 比较（Postgres 没有 json = unknown 运算符），
  // 用读到的 updatedAt 做乐观条件：读到之后有人改过就写不到，下次 apply 再补。
  if (previousUpdatedAt instanceof Date) {
    update = update.where('updatedAt', '=', previousUpdatedAt);
  }
  const updated = await update.execute();
  return (updated.updatedCount ?? 0) > 0 ? 'granted' : 'concurrent-change';
}

export default defineSeed({
  name: '202611280002_seed_staff_approval_grants',
  async run({ query }) {
    await grantStaffApprovalActions(query);
  },
});
