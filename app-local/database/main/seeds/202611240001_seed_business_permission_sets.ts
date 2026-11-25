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
 * R-013 的四个业务角色（seed）。
 *
 * 授权内容照设计文档的角色表：
 * - 质量主管、质量员：FQC 查看与处理、质量页
 * - 部门主管：FQC 查看、质量页
 * - 普通员工：暂无授权，等反馈单的入口页上线后再赋
 *
 * 这一版所有数据范围都填 `allRecords`（Q31）。两把部门范围键已经注册，部门表有数据、
 * 业务表带 `departmentId` 后会自动开始生效。
 *
 * 四个角色都不授予「用户」资源的任何动作（R-028）：读人员信息只做选择性暴露。
 *
 * 写入照框架的存储形态：`grants` 列里是再包了一层的 JSON 字符串，`title` 存
 * `{ key, ns }`，`ns` 是客户端注册的包名 `app-local`。已经存在的 key 一律跳过，
 * 管理员改过的角色不被覆盖 —— 循环里用 `continue`，跳过一颗不能停下整颗 seed。
 * 角色的定义就写在这个文件里，不另建目录：发布产物的白名单只包含 seed 目录。
 */
const NAMESPACE = 'app-local';

const allFqcScopes = {
  fqcMessages: 'allRecords',
  fqcScreenings: 'allRecords',
  fqcTickets: 'allRecords',
} as const;

/**
 * 业务动作的授权以存入库里的形状直接写出来。
 *
 * seed 拿不到应用容器，框架也没给 seed 一个能解析 `authorizationToken` 的上下文，
 * 所以这里不 import `server/fqc-resources.ts` 的声明。动作名与数据范围键写错不会
 * 悄悄生效：启动扫描会拿 `fqc` 的当前定义逐条展开存量的授权，展开不了就直接拒绝
 * 启动（开发环境），测试也断言了这份形状。
 */
function fqcGrant(actions: readonly string[]): PermissionGrant {
  return {
    resource: { type: 'composite', id: 'fqc' },
    actions: actions.map((action) => ({
      action,
      policy: { type: 'composite', scopes: allFqcScopes },
    })),
  };
}

const qualityPage = {
  resource: { type: 'page', id: 'quality' },
  actions: [{ action: 'access' }],
};

export const businessPermissionSets: readonly PermissionSet[] = [
  definePermissionSet('quality_manager')
    .title({ key: 'permissionSets.business.qualityManager', ns: NAMESPACE })
    .grant(qualityPage)
    .grant(fqcGrant(['view', 'handle']))
    .build(),
  definePermissionSet('quality_inspector')
    .title({ key: 'permissionSets.business.qualityInspector', ns: NAMESPACE })
    .grant(qualityPage)
    .grant(fqcGrant(['view', 'handle']))
    .build(),
  definePermissionSet('dept_manager')
    .title({ key: 'permissionSets.business.deptManager', ns: NAMESPACE })
    .grant(qualityPage)
    .grant(fqcGrant(['view']))
    .build(),
  definePermissionSet('staff')
    .title({ key: 'permissionSets.business.staff', ns: NAMESPACE })
    .build(),
];

/**
 * 把四个角色写进权限集表，返回这一次新建的 key。
 *
 * seed 的 run 只做这一件事：开发服务器可能在文件写入后立刻执行这颗 seed，
 * 逻辑放在这里，单元测试可以直接断言它写入的形状与幂等行为。
 */
export async function persistBusinessPermissionSets(
  query: QueryAdapter,
): Promise<readonly string[]> {
  const created: string[] = [];
  for (const set of businessPermissionSets) {
    const existing = await query
      .selectFrom('authorizationPermissionSets')
      .select('key')
      .where('key', '=', set.key)
      .executeTakeFirst();
    // 保留管理员已经改过的角色；跳过这一颗，继续建后面的。
    if (existing) {
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
  }
  return created;
}

export default defineSeed({
  name: '202611240001_seed_business_permission_sets',
  async run({ query }) {
    await persistBusinessPermissionSets(query);
  },
});
