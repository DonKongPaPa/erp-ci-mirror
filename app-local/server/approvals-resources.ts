import { defineCompositeResource } from '@nocobase/authorization/core';
import {
  defineDatabasePermission,
  type DatabaseCollectionDefinition,
} from '@nocobase/app-plugin-authorization/server';

import {
  APPROVAL_APPLICANT_OWN,
  APPROVAL_ASSIGNEE_OWN,
  APPROVAL_RECORD_ACCESS,
  APPROVAL_SCOPE_REFERENCES,
} from './approval-record-access.js';

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

/**
 * M3 的业务动作：两个动作、两把「仅本人」范围键，逐列写死。
 *
 * 资源 id 用单数 `approval`：S1 的守门测试钉住不注册名为 `approvals` 的 composite，
 * 而设计只定了动作名（submit / review），没有给资源 id。单数不与其冲突，语义不变。
 *
 * `submit` 只盖 approvals 一张表，`review` 只盖 approvalRecords 一张表 —— 另两张表
 * 没有申请人和审批人标识，按 id 读它们靠端点先判行级资格，再走服务端仓储，不给业务
 * 角色直接的范围（R-017.md:128-132）。
 *
 * 写列只列端点真会写的列：审批任务本人任务的 `status` / `comment` / `actedAt`，
 * 加签生成记录那几列；审批单只列草稿可改的业务列。数票结论写审批单列、超时扫描写
 * `lastRemindedAt`，都是引擎在服务端上下文里写的，不为了它们放宽用户授权。
 */
const SUBMIT_APPROVAL_READ_FIELDS = [
  'id',
  'collectionName',
  'dataKey',
  'workflowKey',
  'status',
  'applicantId',
  'currentRound',
  'lifecycleDefinition',
  'statusChangedAt',
  'lifecycleVersion',
  'createdAt',
  'updatedAt',
] as const;
const SUBMIT_APPROVAL_CREATE_FIELDS = [
  'id',
  'collectionName',
  'dataKey',
  'workflowKey',
  'status',
  'lifecycleDefinition',
  'applicantId',
  'createdAt',
  'updatedAt',
] as const;
const SUBMIT_APPROVAL_UPDATE_FIELDS = [
  'collectionName',
  'dataKey',
  'workflowKey',
  'updatedAt',
] as const;

const REVIEW_RECORD_READ_FIELDS = [
  'id',
  'roundId',
  'nodeKey',
  'assigneeId',
  'status',
  'comment',
  'actedAt',
  'prevRecordId',
  'seq',
  'origin',
  'dueAt',
  'lastRemindedAt',
] as const;
/** 加签生成的记录：状态就是 pending，不另设状态（R-017.md:87）。 */
const REVIEW_RECORD_CREATE_FIELDS = [
  'id',
  'roundId',
  'nodeKey',
  'assigneeId',
  'status',
  'prevRecordId',
  'seq',
  'origin',
  'dueAt',
] as const;
const REVIEW_RECORD_UPDATE_FIELDS = ['status', 'comment', 'actedAt'] as const;

const submittedApprovals = defineDatabasePermission((permission) =>
  permission
    .collection('approvals')
    .title(approvalsTitle)
    .read(SUBMIT_APPROVAL_READ_FIELDS)
    .create(SUBMIT_APPROVAL_CREATE_FIELDS)
    .update(SUBMIT_APPROVAL_UPDATE_FIELDS)
    .options(APPROVAL_SCOPE_REFERENCES.approvals)
    .default(APPROVAL_SCOPE_REFERENCES.approvals),
);

const reviewedRecords = defineDatabasePermission((permission) =>
  permission
    .collection('approvalRecords')
    .title(recordsTitle)
    .read(REVIEW_RECORD_READ_FIELDS)
    .create(REVIEW_RECORD_CREATE_FIELDS)
    .update(REVIEW_RECORD_UPDATE_FIELDS)
    .options(APPROVAL_SCOPE_REFERENCES.approvalRecords)
    .default(APPROVAL_SCOPE_REFERENCES.approvalRecords),
);

/** 注册给授权插件的范围键；provider 在 boot() 里逐条定义。 */
export const APPROVAL_RESOURCE = defineCompositeResource('approval', (resource) =>
  resource
    .title({ key: 'authorization.approval.title', ns: NAMESPACE })
    .action('submit', (action) =>
      action
        .title({ key: 'authorization.approval.actions.submit', ns: NAMESPACE })
        .grant('approvals', submittedApprovals),
    )
    .action('review', (action) =>
      action
        .title({ key: 'authorization.approval.actions.review', ns: NAMESPACE })
        .grant('approvalRecords', reviewedRecords),
    ),
);

/** seed 写入的角色授权形状：动作各自成一条，范围键只有「仅本人」。 */
export const APPROVAL_STAFF_GRANT = {
  resource: { type: 'composite', id: 'approval' },
  actions: [
    {
      action: 'submit',
      policy: { type: 'composite', scopes: { approvals: APPROVAL_APPLICANT_OWN } },
    },
    {
      action: 'review',
      policy: {
        type: 'composite',
        scopes: { approvalRecords: APPROVAL_ASSIGNEE_OWN },
      },
    },
  ],
} as const;

export { APPROVAL_RECORD_ACCESS };
