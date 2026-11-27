import type { DatabaseCollectionDefinition } from '@nocobase/app-plugin-authorization/server';

/**
 * R-017 S1：审批三张表在授权模型里的登记。
 *
 * 这里只做「登记资源与动作」，不建业务资源、不建业务动作、不给业务角色授权：
 *
 * - R-017.md 的接口契约把授权放在端点自己身上（:100-101「每个端点自己做授权 ——
 *   v3 没有全局兜底」、:136 guard 是业务规则不是权限），三个页面取 `authz: 'skip'`
 *   （:327，入口对所有登录用户可见，数据由端点按申请人/审批人过滤）。设计没有
 *   给出 `approvals` 的业务资源、动作名或列清单，所以这一片不自造它们；端点与
 *   页面到位时再由那一片按实际读写列补声明。
 * - 只登记三张表的 read/create/update 三个动作。不写动作清单的话框架默认把
 *   delete 也登记上，管理员就能经接口给角色写一条「可以删审批单」。
 * - R-028（R-017.md:357-362）：不授予「用户 · 读」。候选人端点自建，只在节点
 *   候选人范围内搜、只回标识/姓名/用户名；这一片没有任何端点，也不涉及人员列。
 *
 * 三张表都不进角色编辑器（没有 composite 资源、没有 placement），只作为数据库
 * 资源存在。seed 不为它们写任何授权（同 employees 资源的第一版：默认只有 root
 * 能读写），所以「默认授权」的形状是默认拒绝；后续片加动作与授权时会在守门
 * 测试里逐列钉住，而不是在这里先放开。
 */
const NAMESPACE = 'app-local';

const approvalsTitle = {
  key: 'authorization.approvals.tables.approvals',
  ns: NAMESPACE,
} as const;

const roundsTitle = {
  key: 'authorization.approvals.tables.rounds',
  ns: NAMESPACE,
} as const;

const recordsTitle = {
  key: 'authorization.approvals.tables.records',
  ns: NAMESPACE,
} as const;

/**
 * 三张表的裸读写登记。动作清单写明，避免框架默认登记 delete。
 * 表由迁移 202611260006_create_approvals 建。
 */
export const APPROVAL_COLLECTIONS: readonly DatabaseCollectionDefinition[] = [
  {
    name: 'approvals',
    title: approvalsTitle,
    actions: ['read', 'create', 'update'],
  },
  {
    name: 'approvalRounds',
    title: roundsTitle,
    actions: ['read', 'create', 'update'],
  },
  {
    name: 'approvalRecords',
    title: recordsTitle,
    actions: ['read', 'create', 'update'],
  },
];
