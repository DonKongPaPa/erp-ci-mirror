import { ApiClientError } from '@nocobase/app-client';

import { splitReasons } from './model.js';

/**
 * 规则码到文案的对照，集中在这一处（两种语言的词条在 `client/locales/`）。
 * 服务端把 `EmployeeRuleError` 的 code 转成大写放进 `reason`，提示要告诉人下一步做什么。
 */
export const RULE_MESSAGE_KEYS: Readonly<Record<string, string>> = {
  AUTHORIZATION_DENIED: 'employees.errors.denied',
  PERMISSION_DENIED: 'employees.errors.denied',
  ACCOUNT_PROTECTED: 'employees.errors.accountProtected',
  ALREADY_LEFT: 'employees.errors.alreadyLeft',
  EMPLOYEE_NO_CONFLICT: 'employees.errors.noConflict',
  EMPLOYEE_NO_EXHAUSTED: 'employees.errors.noExhausted',
  GRADE_INACTIVE: 'employees.errors.gradeInactive',
  GRADE_IN_USE: 'employees.errors.gradeInUse',
  HAS_DIRECT_REPORTS: 'employees.errors.hasDirectReports',
  INVALID_DATE: 'employees.errors.invalidDate',
  INVALID_REFERENCE: 'employees.errors.invalidReference',
  INVALID_UPDATE: 'employees.errors.invalidUpdate',
  IS_DEPARTMENT_MANAGER: 'employees.errors.isDepartmentManager',
  NOT_LEFT: 'employees.errors.notLeft',
  OFFBOARD_REJECTED: 'employees.errors.offboardRejected',
  POSITION_INACTIVE: 'employees.errors.positionInactive',
  POSITION_IN_USE: 'employees.errors.positionInUse',
  PROFILE_EXISTS: 'employees.errors.profileExists',
  PROFILE_NOT_FOUND: 'employees.errors.profileNotFound',
  REPORTS_TO_CYCLE: 'employees.errors.reportsToCycle',
  REPORTS_TO_NOT_ACTIVE: 'employees.errors.reportsToNotActive',
  REPORTS_TO_SELF: 'employees.errors.reportsToSelf',
  SELF_LEAVE: 'employees.errors.selfLeave',
  SERVICE_ACCOUNT: 'employees.errors.serviceAccount',
  TARGET_USER_NOT_FOUND: 'employees.errors.userNotFound',
  DICTIONARY_EXISTS: 'employees.errors.dictionaryExists',
  DICTIONARY_NOT_FOUND: 'employees.errors.dictionaryNotFound',
};

const STATUS_MESSAGE_KEYS: Readonly<Record<number, string>> = {
  400: 'employees.errors.invalidRequest',
  401: 'employees.errors.session',
  403: 'employees.errors.denied',
  404: 'employees.errors.notFound',
  409: 'employees.errors.conflict',
  422: 'employees.errors.invalidRequest',
};

export interface EmployeeMessage {
  readonly key: string;
  readonly values?: Readonly<Record<string, string>>;
}

/** 一次失败对应的词条：规则码优先，其次状态码，最后是带原因码的通用提示。 */
export function employeeMessage(error: unknown): EmployeeMessage {
  if (error instanceof ApiClientError) {
    if (error.reason && Object.hasOwn(RULE_MESSAGE_KEYS, error.reason))
      return { key: RULE_MESSAGE_KEYS[error.reason] };
    if (Object.hasOwn(STATUS_MESSAGE_KEYS, error.status))
      return { key: STATUS_MESSAGE_KEYS[error.status] };
    return {
      key: 'employees.errors.generic',
      values: { reason: error.reason ?? String(error.status) },
    };
  }
  return { key: 'employees.errors.failed' };
}

/** 离职前检查的多条理由：从标准错误体的 `metadata.reason` 读，按分号拆成多行。 */
export function rejectionReasons(error: unknown): readonly string[] {
  if (!(error instanceof ApiClientError)) return [];
  const payload = error.payload;
  if (!payload || typeof payload !== 'object') return [];
  const body = (payload as { error?: unknown }).error;
  if (!body || typeof body !== 'object') return [];
  const metadata = (body as { metadata?: unknown }).metadata;
  if (!metadata || typeof metadata !== 'object') return [];
  const reason = (metadata as { reason?: unknown }).reason;
  return splitReasons(typeof reason === 'string' ? reason : undefined);
}

/** 把 `employeeMessage` 的结果翻成一句话，供不接翻译 hook 的地方（例如测试与日志）使用。 */
export function formatEmployeeMessage(
  error: unknown,
  translate: (key: string, values?: Readonly<Record<string, string>>) => string,
): string {
  const { key, values } = employeeMessage(error);
  return translate(key, values);
}
