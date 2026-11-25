import { ApiClientError } from '@nocobase/app-client';

/**
 * 规则码到文案的对照，集中在这一处（两种语言的词条在 `client/locales/`）。
 *
 * 服务端把每条被拒的规则映射成 `reason`（`DepartmentRuleError` 的 code 转成大写），
 * 提示要告诉人下一步该做什么 —— 例如先把负责人换成别人、先把主部门改到别的部门。
 * 没有列出的错误按状态码给一句通用的话，仍然是可读的提示。
 */
export const RULE_MESSAGE_KEYS: Readonly<Record<string, string>> = {
  AUTHORIZATION_DENIED: 'departments.errors.denied',
  DUPLICATE_TITLE: 'departments.errors.duplicateTitle',
  DUPLICATE_CODE: 'departments.errors.duplicateCode',
  DEPARTMENT_CYCLE: 'departments.errors.cycle',
  MANAGER_NOT_MEMBER: 'departments.errors.managerNotMember',
  MANAGER_CANNOT_BE_REMOVED: 'departments.errors.managerCannotBeRemoved',
  PRIMARY_DEPARTMENT_IN_USE: 'departments.errors.primaryDepartmentInUse',
  PRIMARY_DEPARTMENT_CONFLICT: 'departments.errors.primaryConflict',
  DEPARTMENT_HAS_MEMBERS: 'departments.errors.hasMembers',
  DEPARTMENT_HAS_ACTIVE_CHILDREN: 'departments.errors.hasActiveChildren',
  DEPARTMENT_DEACTIVATED: 'departments.errors.deactivated',
  PARENT_DEACTIVATED: 'departments.errors.parentDeactivated',
  SUCCESSOR_DEACTIVATED: 'departments.errors.successorDeactivated',
  MERGE_SOURCE_DEACTIVATED: 'departments.errors.mergeSourceDeactivated',
  MERGE_SOURCE_HAS_ACTIVE_CHILDREN: 'departments.errors.mergeSourceHasChildren',
  MERGE_TARGET_SELF: 'departments.errors.mergeTargetSelf',
  MERGE_TARGET_DEACTIVATED: 'departments.errors.mergeTargetDeactivated',
  MERGE_TARGET_NOT_FOUND: 'departments.errors.missingDepartment',
  DEPARTMENT_MERGE_TARGET_REQUIRED: 'departments.errors.mergeTargetRequired',
  TRANSFER_USER_NOT_MEMBER: 'departments.errors.transferNotMember',
  TRANSFER_INCLUDES_MANAGER: 'departments.errors.transferIncludesManager',
  TRANSFER_TARGET_NOT_FOUND: 'departments.errors.missingDepartment',
  TRANSFER_INVALID_REQUEST: 'departments.errors.transferInvalid',
  DEPARTMENT_NOT_FOUND: 'departments.errors.missingDepartment',
  MEMBERSHIP_NOT_FOUND: 'departments.errors.missingMembership',
  PARENT_NOT_FOUND: 'departments.errors.missingDepartment',
  TITLE_REQUIRED: 'departments.errors.titleRequired',
  CODE_REQUIRED: 'departments.errors.codeRequired',
  INVALID_DEPARTMENT_KIND: 'departments.errors.invalidKind',
};

const STATUS_MESSAGE_KEYS: Readonly<Record<number, string>> = {
  400: 'departments.errors.invalidRequest',
  401: 'departments.errors.session',
  403: 'departments.errors.denied',
  404: 'departments.errors.missingDepartment',
  409: 'departments.errors.conflict',
  422: 'departments.errors.invalidRequest',
};

/** 一次失败对应的词条键。规则码优先，其次按状态码，最后一句通用的失败提示。 */
export function ruleMessageKey(error: unknown): string {
  if (error instanceof ApiClientError) {
    if (error.reason && Object.hasOwn(RULE_MESSAGE_KEYS, error.reason)) {
      return RULE_MESSAGE_KEYS[error.reason];
    }
    if (Object.hasOwn(STATUS_MESSAGE_KEYS, error.status)) {
      return STATUS_MESSAGE_KEYS[error.status];
    }
  }
  return 'departments.errors.failed';
}
