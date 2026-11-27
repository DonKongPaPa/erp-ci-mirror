import type { PermissionGrant } from '@nocobase/authorization/core';
import {
  definePermissionSet,
  type PermissionSet,
} from '@nocobase/authorization/permission-sets';
import { defineSeed, type QueryAdapter } from '@nocobase/db';

import { businessPermissionSets } from './202611240001_seed_business_permission_sets.ts';
import { salesReviewPermissionSet } from './202611280003_seed_order_review_grants.ts';

/**
 * R-076：打印授权不能回头追加到已经执行过的 202611240001 上 —— 框架只警告校验和
 * 不匹配，不会重跑。这一颗是新文件：全新安装时紧跟原种子跑；已有环境执行
 * `pnpm nocobase db apply` 时只跑这一颗。
 *
 * 只补三个角色的打印授权，按「一类单据 + 一个动作」最窄落地：
 * - 仓管：三种单的 print，一份 printPrice 都不给；
 * - 采购：采购入库的 print + printPrice；
 * - 销售：销售出库的 print + printPrice。
 * 已有角色只要出现「原种子 + R-064 补丁 + 本片授权」之外的授权（管理员改过），整条跳过，
 * 不覆盖、不改写。销售在全新库里已经带 R-064 的两条只读授权，必须把它们认作已知形状，
 * 否则会误判成管理员改动、把打印授权漏掉。授权定义只写在这里，原种子一字不改。
 */
const grantOf = (
  id: 'docPrintInternalIssue' | 'docPrintSalesIssue' | 'docPrintPurchaseReceipt',
  actions: readonly ('print' | 'printPrice')[],
): PermissionGrant => ({
  resource: { type: 'composite', id },
  actions: actions.map((action) => ({ action })),
});

export const warehouseDocPrintGrants: readonly PermissionGrant[] = [
  grantOf('docPrintInternalIssue', ['print']),
  grantOf('docPrintSalesIssue', ['print']),
  grantOf('docPrintPurchaseReceipt', ['print']),
];
export const purchaseDocPrintGrants: readonly PermissionGrant[] = [
  grantOf('docPrintPurchaseReceipt', ['print', 'printPrice']),
];
export const salesDocPrintGrants: readonly PermissionGrant[] = [
  grantOf('docPrintSalesIssue', ['print', 'printPrice']),
];

export const docPrintPermissionSets: readonly PermissionSet[] = [
  definePermissionSet('warehouse')
    .grant(warehouseDocPrintGrants[0])
    .grant(warehouseDocPrintGrants[1])
    .grant(warehouseDocPrintGrants[2])
    .build(),
  definePermissionSet('purchase').grant(purchaseDocPrintGrants[0]).build(),
  definePermissionSet('sales').grant(salesDocPrintGrants[0]).build(),
];

export interface DocPrintGrantReport {
  readonly created: readonly string[];
  readonly granted: readonly string[];
  readonly skipped: readonly string[];
}

const TARGET_GRANTS: Readonly<Record<string, readonly PermissionGrant[]>> = {
  warehouse: warehouseDocPrintGrants,
  purchase: purchaseDocPrintGrants,
  sales: salesDocPrintGrants,
};

/** json 列在 QueryAdapter 里读回来是字符串；兼容已经解析成对象的方言。 */
function grantsText(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function parseGrants(value: unknown): PermissionGrant[] {
  return JSON.parse(grantsText(value)) as PermissionGrant[];
}

/** 一条授权视为已存在：资源相同，且它逐条含有所需动作。 */
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

/**
 * 只给三个已有角色补缺的打印授权；返回新建（本片不建新角色，恒空）、补过的与跳过的 key。
 *
 * 幂等的三条路都跳过写入：角色不存在；已有全部目标授权；角色的授权已不是原种子写出的
 * 那份（管理员改过）。最后一条让补授权不会悄悄抹掉管理员后来的收窄或放宽。
 */
export async function persistDocPrintGrants(
  query: QueryAdapter,
): Promise<DocPrintGrantReport> {
  const created: string[] = [];
  const granted: string[] = [];
  const skipped: string[] = [];

  for (const [key, wanted] of Object.entries(TARGET_GRANTS)) {
    const row = await query
      .selectFrom('authorizationPermissionSets')
      .select(['key', 'grants'])
      .where('key', '=', key)
      .executeTakeFirst();
    if (!row) {
      skipped.push(key);
      continue;
    }
    const baseline = businessPermissionSets.find((set) => set.key === key);
    if (baseline === undefined) {
      throw new Error(`[r076] 原种子里没有 ${key}，无法判断授权是否被改过`);
    }
    const stored = grantsText(row.grants);
    const existing = parseGrants(stored);
    // 已知形状 = 原种子 + 前面几颗补丁种子 + 本片自己的授权；出现任何别的授权就
    // 认定管理员改过，整条跳过。销售必须把 R-064 的两条只读授权算进来。
    const known = [
      ...baseline.grants,
      ...(key === 'sales' ? salesReviewPermissionSet.grants : []),
      ...wanted,
    ].map((grant) => JSON.stringify(grant));
    if (existing.some((grant) => !known.includes(JSON.stringify(grant)))) {
      skipped.push(key);
      continue;
    }
    const missing = wanted.filter((candidate) => !hasGrant(existing, candidate));
    if (missing.length === 0) {
      skipped.push(key);
      continue;
    }
    await query
      .updateTable('authorizationPermissionSets')
      .set({ grants: JSON.stringify([...existing, ...missing]), updatedAt: new Date() })
      .where('key', '=', key)
      .execute();
    granted.push(key);
  }

  return { created, granted, skipped };
}

export default defineSeed({
  name: '202611280006_seed_doc_print_grants',
  async run({ query }) {
    await persistDocPrintGrants(query);
  },
});
