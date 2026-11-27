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
 * R-064：评审授权不能回头追加到已经执行过的 202611240001 上 —— 框架只警告校验和
 * 不匹配，不会重跑，老环境就一直缺 planning 与两条 sales 读授权。这一颗是新文件，
 * 全新安装时紧跟着原种子跑，已有环境 `pnpm nocobase db apply` 时只跑这一颗。
 *
 * 照原种子文件头注释的做法：已经存在的 key 一律跳过，管理员改过的角色不被覆盖。
 * planning 已存在就整颗跳过；sales 只在授权仍是原种子写出的那份时补两条只读授权，
 * 授权已存在或被管理员改过都跳过，不覆盖、不改写已有授权、不补用户指派。
 * 两份授权的定义只写在这里，原种子一字不改（回滚后它还是主线的样子）。
 */
const NAMESPACE = 'app-local';
const SALES_KEY = 'sales';

/** 评审六个动作只给 planning（外加 root，root 不受限，不必登记）。 */
const REVIEW_ACTIONS = ['view', 'create', 'update', 'submit', 'confirm', 'void'] as const;
const planningReviewGrant: PermissionGrant = {
  resource: { type: 'composite', id: 'orderReviews' },
  actions: REVIEW_ACTIONS.map((action) => ({ action })),
};
/** sales 只读评审；两边各拿台账只读，都不拿订单 view —— 那会连价格一起放行。 */
const reviewViewGrant: PermissionGrant = {
  resource: { type: 'composite', id: 'orderReviews' },
  actions: [{ action: 'view' }],
};
const salesLedgerView: PermissionGrant = {
  resource: { type: 'composite', id: 'salesOrders' },
  actions: [{ action: 'ledgerView' }],
};

/** 新角色一份；sales 的补丁授权单独一份，绝不作为整份权限集写进去。 */
export const planningPermissionSet: PermissionSet = definePermissionSet('planning')
  .title({ key: 'permissionSets.business.planning', ns: NAMESPACE })
  .grant(planningReviewGrant)
  .grant(salesLedgerView)
  .build();

export const salesReviewPermissionSet: PermissionSet = definePermissionSet(SALES_KEY)
  .grant(reviewViewGrant)
  .grant(salesLedgerView)
  .build();

export const orderReviewPermissionSets: readonly PermissionSet[] = [
  planningPermissionSet,
  salesReviewPermissionSet,
];

export interface OrderReviewGrantReport {
  readonly created: readonly string[];
  readonly granted: readonly string[];
}

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
 * 只做两件事，返回这一次新建的角色与补过授权的角色。
 *
 * 幂等的三条路都跳过写入：planning 已存在；sales 已有两条授权；sales 的授权
 * 已不是原种子写出的形状（管理员改过）。最后这一条让「新增授权」不会把管理员
 * 后来的收窄或放宽悄悄抹掉 —— 那种改动要由人走升级命令决定。
 */
export async function persistOrderReviewGrants(
  query: QueryAdapter,
): Promise<OrderReviewGrantReport> {
  const created: string[] = [];
  const granted: string[] = [];

  const planning = await query
    .selectFrom('authorizationPermissionSets')
    .select('key')
    .where('key', '=', planningPermissionSet.key)
    .executeTakeFirst();
  if (!planning) {
    const now = new Date();
    await query
      .insertInto('authorizationPermissionSets')
      .values({
        id: randomUUID(),
        key: planningPermissionSet.key,
        title: encodeAuthorizationTitle(planningPermissionSet.title),
        grants: JSON.stringify(planningPermissionSet.grants),
        createdAt: now,
        updatedAt: now,
      })
      .execute();
    created.push(planningPermissionSet.key);
  }

  const salesRow = await query
    .selectFrom('authorizationPermissionSets')
    .select(['key', 'grants'])
    .where('key', '=', SALES_KEY)
    .executeTakeFirst();
  if (salesRow) {
    const baseline = businessPermissionSets.find((set) => set.key === SALES_KEY);
    if (baseline === undefined) {
      throw new Error(`[r064] 原种子里没有 ${SALES_KEY}，无法判断授权是否被改过`);
    }
    const stored = grantsText(salesRow.grants);
    // 只认原种子写出的那一份；后面两种状态（已补过、管理员改过）都跳过。
    if (stored === JSON.stringify(baseline.grants)) {
      const existing = parseGrants(stored);
      const missing = salesReviewPermissionSet.grants.filter(
        (candidate) => !hasGrant(existing, candidate),
      );
      if (missing.length > 0) {
        await query
          .updateTable('authorizationPermissionSets')
          .set({
            grants: JSON.stringify([...existing, ...missing]),
            updatedAt: new Date(),
          })
          .where('key', '=', SALES_KEY)
          .execute();
        granted.push(SALES_KEY);
      }
    }
  }

  return { created, granted };
}

export default defineSeed({
  name: '202611280003_seed_order_review_grants',
  async run({ query }) {
    await persistOrderReviewGrants(query);
  },
});
