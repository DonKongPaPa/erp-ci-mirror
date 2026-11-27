import { defineRecordAccess } from '@nocobase/authorization/core';
import { condition } from '@nocobase/app-plugin-authorization/server';

/**
 * R-017 M3：审批的两个「仅本人」范围键。
 *
 * 设计 R-017.md「授权与暴露面」的范围键只盖一张表：`submit` 的申请人标识只在
 * `approvals` 上（applicantId），`review` 的审批人标识只在 `approvalRecords` 上
 * （assigneeId）。框架内置的 recordsIOwn 比的是 ownerId，这里照部门范围键的做法
 * 自己定义两把键，逐表限定，不给「全部」选项 —— 声明时 `.options()` 只放这一把，
 * 管理员也选不出更宽的范围。
 *
 * resolve 只在主体是用户时返回等值条件；其他主体返回 false（选不到任何行），
 * 不放宽成全部。
 */
export const APPROVAL_APPLICANT_OWN = 'approval.applicantOwn';
export const APPROVAL_ASSIGNEE_OWN = 'approval.assigneeOwn';

const NAMESPACE = 'app-local';

const applicantOwn = defineRecordAccess(APPROVAL_APPLICANT_OWN, (access) =>
  access
    .title({ key: 'authorization.recordAccess.approvalApplicant', ns: NAMESPACE })
    .collections('approvals')
    .resolver(({ principal, collection }) =>
      collection === 'approvals' && principal.type === 'user'
        ? condition('applicantId', '$eq', principal.id)
        : false,
    ),
).build();

const assigneeOwn = defineRecordAccess(APPROVAL_ASSIGNEE_OWN, (access) =>
  access
    .title({ key: 'authorization.recordAccess.approvalAssignee', ns: NAMESPACE })
    .collections('approvalRecords')
    .resolver(({ principal, collection }) =>
      collection === 'approvalRecords' && principal.type === 'user'
        ? condition('assigneeId', '$eq', principal.id)
        : false,
    ),
).build();

export const APPROVAL_RECORD_ACCESS = [applicantOwn, assigneeOwn] as const;

/** 给声明与守门测试用的稳定引用形状：{key, collections}。 */
export const APPROVAL_SCOPE_REFERENCES = {
  approvals: { key: APPROVAL_APPLICANT_OWN, collections: ['approvals'] },
  approvalRecords: {
    key: APPROVAL_ASSIGNEE_OWN,
    collections: ['approvalRecords'],
  },
} as const;
