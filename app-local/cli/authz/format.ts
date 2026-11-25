import type {
  AuthorizationTitle,
  PermissionGrant,
  PermissionGrantAction,
} from '@nocobase/authorization/core';
import type { PermissionSetProtectionInfo } from '@nocobase/authorization/permission-sets';

/**
 * R-013 的权限导出文件（验收标准第 8 条）。
 *
 * 文件分四部分：角色定义（带版本号）、赋权（按用户名，不按 id）、三类规则、
 * 受保护标记。`format` 是格式版本号，导入时不认识的版本一律拒绝。
 *
 * 用户主体有两种跨环境可重建的写法：普通账号用 `{ type: 'user', username }`，
 * 服务账号（R-001 的用法，没有 username）用 `{ type: 'user', kind: 'service', name }`。
 * 其余主体（例如 `authenticated:*` 这类受众）的 id 与环境无关，原样保留。
 * 规则里的 subjects 用同一套写法。
 */
export const AUTHORIZATION_EXPORT_FORMAT = 1;

export interface ExportedPermissionSet {
  key: string;
  revision: string;
  title?: AuthorizationTitle;
  grants: readonly PermissionGrant[];
}

export interface ExportedUsernameSubject {
  type: 'user';
  username: string;
}

export interface ExportedServiceAccountSubject {
  type: 'user';
  kind: 'service';
  name: string;
}

export interface ExportedIdSubject {
  type: string;
  id: string;
}

export type ExportedUserSubject =
  ExportedUsernameSubject | ExportedServiceAccountSubject;

export type ExportedSubject = ExportedUserSubject | ExportedIdSubject;

export function isUsernameSubject(
  subject: ExportedSubject,
): subject is ExportedUsernameSubject {
  return (
    subject.type === 'user' &&
    typeof (subject as { username?: unknown }).username === 'string'
  );
}

export function isServiceAccountSubject(
  subject: ExportedSubject,
): subject is ExportedServiceAccountSubject {
  return (
    subject.type === 'user' &&
    (subject as { kind?: unknown }).kind === 'service'
  );
}

export interface ExportedAssignment {
  subject: ExportedSubject;
  permissionSet: string;
}

export interface ExportedRuleAction {
  action: string;
  scopeKey?: string;
  /** 形状在结构解析时只保证存在；语义（能否解析）由导入计划用授权核心校验。 */
  selection?: unknown;
}

export interface ExportedDefaultAccessRule {
  key: string;
  resource: { type: string; id: string };
  actions: readonly ExportedRuleAction[];
  title?: AuthorizationTitle;
}

export interface ExportedSharingRule extends ExportedDefaultAccessRule {
  subjects: readonly ExportedSubject[];
  reason?: string;
}

export type ExportedRestrictionRule = ExportedSharingRule;

export interface ExportedProtection {
  key: string;
  protection: PermissionSetProtectionInfo;
}

export interface AuthorizationExportFile {
  format: typeof AUTHORIZATION_EXPORT_FORMAT;
  exportedAt: string;
  permissionSets: ExportedPermissionSet[];
  assignments: ExportedAssignment[];
  rules: {
    defaultAccess: ExportedDefaultAccessRule[];
    sharing: ExportedSharingRule[];
    restriction: ExportedRestrictionRule[];
  };
  protected: ExportedProtection[];
}

export interface ParsedAuthorizationExport {
  file?: AuthorizationExportFile;
  problems: string[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isString = (value: unknown): value is string => typeof value === 'string';

/** 只校验导出的形状；授权内容与资源是否注册由导入命令另行校验。 */
export function parseAuthorizationExport(
  value: unknown,
): ParsedAuthorizationExport {
  const problems: string[] = [];
  if (!isRecord(value)) {
    return { problems: ['The file does not hold a JSON object.'] };
  }
  if (value.format !== AUTHORIZATION_EXPORT_FORMAT) {
    problems.push(
      `Unsupported format ${JSON.stringify(value.format)}; this command reads format ${AUTHORIZATION_EXPORT_FORMAT}.`,
    );
    // 版本不认识就不知道其余字段的形状，不再往下猜。
    return { problems };
  }
  if (!isString(value.exportedAt)) {
    problems.push('"exportedAt" must be a string.');
  }
  const permissionSets = parsePermissionSets(value.permissionSets, problems);
  const assignments = parseAssignments(value.assignments, problems);
  const rules = parseRules(value.rules, problems);
  const protectedSets = parseProtections(value.protected, problems);
  if (problems.length > 0) {
    return { problems };
  }
  return {
    problems,
    file: {
      format: AUTHORIZATION_EXPORT_FORMAT,
      exportedAt: value.exportedAt as string,
      permissionSets,
      assignments,
      rules,
      protected: protectedSets,
    },
  };
}

/**
 * 一个赋权/规则主体。用户要么按 username，要么按服务账号的 name；写成用户 id
 * 的文件在导入时无法跨环境重建，直接拒绝。
 */
function parseSubject(
  value: unknown,
  where: string,
  problems: string[],
): ExportedSubject | undefined {
  if (!isRecord(value)) {
    problems.push(`${where} must be an object.`);
    return undefined;
  }
  if (!isString(value.type) || value.type.length === 0) {
    problems.push(`${where} needs a non-empty string "type".`);
    return undefined;
  }
  if (value.type === 'user') {
    if (isString(value.username) && value.username.trim().length > 0) {
      return { type: 'user', username: value.username };
    }
    if (
      value.kind === 'service' &&
      isString(value.name) &&
      value.name.trim().length > 0
    ) {
      return { type: 'user', kind: 'service', name: value.name };
    }
    problems.push(
      `${where} needs a "username", or kind "service" with a "name", for a user.`,
    );
    return undefined;
  }
  if (!isString(value.id) || value.id.length === 0) {
    problems.push(`${where} needs a non-empty string "id".`);
    return undefined;
  }
  return { type: value.type, id: value.id };
}

function parsePermissionSets(
  value: unknown,
  problems: string[],
): ExportedPermissionSet[] {
  if (!Array.isArray(value)) {
    problems.push('"permissionSets" must be an array.');
    return [];
  }
  const parsed: ExportedPermissionSet[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of value.entries()) {
    if (!isRecord(entry)) {
      problems.push(`permissionSets[${index}] must be an object.`);
      continue;
    }
    if (!isString(entry.key) || entry.key.length === 0) {
      problems.push(`permissionSets[${index}].key must be a non-empty string.`);
      continue;
    }
    if (seen.has(entry.key)) {
      problems.push(`permissionSets repeats the key "${entry.key}".`);
      continue;
    }
    seen.add(entry.key);
    if (entry.revision !== undefined && !isString(entry.revision)) {
      problems.push(`permissionSets[${index}].revision must be a string.`);
    }
    if (entry.title !== undefined && !isRecord(entry.title)) {
      problems.push(`permissionSets[${index}].title must be an object.`);
    }
    if (!Array.isArray(entry.grants)) {
      problems.push(`permissionSets[${index}].grants must be an array.`);
      continue;
    }
    const grants: PermissionGrant[] = [];
    let grantsOk = true;
    for (const [grantIndex, grant] of entry.grants.entries()) {
      const where = `permissionSets[${index}].grants[${grantIndex}]`;
      if (!isRecord(grant) || !isRecord(grant.resource)) {
        problems.push(`${where}.resource must be an object.`);
        grantsOk = false;
        continue;
      }
      if (!isString(grant.resource.type) || !isString(grant.resource.id)) {
        problems.push(`${where}.resource needs a string "type" and "id".`);
        grantsOk = false;
        continue;
      }
      if (!Array.isArray(grant.actions)) {
        problems.push(`${where}.actions must be an array.`);
        grantsOk = false;
        continue;
      }
      const actions: PermissionGrantAction[] = [];
      let actionsOk = true;
      for (const [actionIndex, action] of grant.actions.entries()) {
        if (!isRecord(action) || !isString(action.action)) {
          problems.push(
            `${where}.actions[${actionIndex}] needs a string "action".`,
          );
          actionsOk = false;
          continue;
        }
        if (action.policy !== undefined && !isRecord(action.policy)) {
          problems.push(
            `${where}.actions[${actionIndex}].policy must be an object.`,
          );
          actionsOk = false;
          continue;
        }
        actions.push({
          action: action.action,
          ...(isRecord(action.policy)
            ? {
                policy:
                  action.policy as PermissionGrant['actions'][number]['policy'],
              }
            : {}),
        });
      }
      if (!actionsOk) {
        grantsOk = false;
        continue;
      }
      grants.push({
        resource: {
          type: grant.resource.type,
          id: grant.resource.id,
        },
        actions,
      });
    }
    if (!grantsOk) {
      continue;
    }
    parsed.push({
      key: entry.key,
      revision: isString(entry.revision) ? entry.revision : '',
      ...(isRecord(entry.title)
        ? { title: entry.title as AuthorizationTitle }
        : {}),
      grants,
    });
  }
  return parsed;
}

function parseAssignments(
  value: unknown,
  problems: string[],
): ExportedAssignment[] {
  if (!Array.isArray(value)) {
    problems.push('"assignments" must be an array.');
    return [];
  }
  const parsed: ExportedAssignment[] = [];
  for (const [index, entry] of value.entries()) {
    if (!isRecord(entry)) {
      problems.push(`assignments[${index}] must be an object.`);
      continue;
    }
    if (!isString(entry.permissionSet) || entry.permissionSet.length === 0) {
      problems.push(
        `assignments[${index}].permissionSet must be a non-empty string.`,
      );
      continue;
    }
    const subject = parseSubject(
      entry.subject,
      `assignments[${index}].subject`,
      problems,
    );
    if (subject === undefined) {
      continue;
    }
    parsed.push({ subject, permissionSet: entry.permissionSet });
  }
  return parsed;
}

function parseRuleActions(
  value: unknown,
  where: string,
  problems: string[],
): ExportedRuleAction[] {
  if (!Array.isArray(value)) {
    problems.push(`${where}.actions must be an array.`);
    return [];
  }
  const parsed: ExportedRuleAction[] = [];
  for (const [index, action] of value.entries()) {
    if (!isRecord(action)) {
      problems.push(`${where}.actions[${index}] must be an object.`);
      continue;
    }
    if (!isString(action.action) || action.action.length === 0) {
      problems.push(
        `${where}.actions[${index}] needs a non-empty string "action".`,
      );
      continue;
    }
    if (action.scopeKey !== undefined && !isString(action.scopeKey)) {
      problems.push(`${where}.actions[${index}].scopeKey must be a string.`);
      continue;
    }
    parsed.push({
      action: action.action,
      ...(isString(action.scopeKey) ? { scopeKey: action.scopeKey } : {}),
      ...(action.selection === undefined
        ? {}
        : { selection: action.selection }),
    });
  }
  return parsed;
}

function parseRuleBase(
  entry: Record<string, unknown>,
  where: string,
  problems: string[],
): Omit<ExportedDefaultAccessRule, 'key'> | undefined {
  if (!isRecord(entry.resource)) {
    problems.push(`${where} needs a "resource" object.`);
    return undefined;
  }
  if (
    !isString(entry.resource.type) ||
    !isString(entry.resource.id) ||
    entry.resource.type.length === 0 ||
    entry.resource.id.length === 0
  ) {
    problems.push(`${where}.resource needs a string "type" and "id".`);
    return undefined;
  }
  if (entry.title !== undefined && !isRecord(entry.title)) {
    problems.push(`${where}.title must be an object.`);
  }
  const actions = parseRuleActions(entry.actions, where, problems);
  if (entry.actions !== undefined && !Array.isArray(entry.actions)) {
    return undefined;
  }
  return {
    resource: { type: entry.resource.type, id: entry.resource.id },
    actions,
    ...(isRecord(entry.title)
      ? { title: entry.title as AuthorizationTitle }
      : {}),
  };
}

function parseRules(
  value: unknown,
  problems: string[],
): AuthorizationExportFile['rules'] {
  const empty = {
    defaultAccess: [],
    sharing: [],
    restriction: [],
  } as AuthorizationExportFile['rules'];
  if (!isRecord(value)) {
    problems.push('"rules" must be an object.');
    return empty;
  }
  const result = { ...empty };
  for (const key of ['defaultAccess', 'sharing', 'restriction'] as const) {
    const rules = value[key];
    if (!Array.isArray(rules)) {
      problems.push(`"rules.${key}" must be an array.`);
      continue;
    }
    const seen = new Set<string>();
    const parsed: (ExportedDefaultAccessRule | ExportedSharingRule)[] = [];
    for (const [index, rule] of rules.entries()) {
      const where = `rules.${key}[${index}]`;
      if (!isRecord(rule)) {
        problems.push(`${where} must be an object.`);
        continue;
      }
      if (!isString(rule.key) || rule.key.length === 0) {
        problems.push(`${where} needs a non-empty string "key".`);
        continue;
      }
      if (seen.has(rule.key)) {
        problems.push(`rules.${key} repeats the key "${rule.key}".`);
        continue;
      }
      seen.add(rule.key);
      const base = parseRuleBase(rule, where, problems);
      if (base === undefined) {
        continue;
      }
      if (key === 'defaultAccess') {
        parsed.push({ key: rule.key, ...base });
        continue;
      }
      if (!Array.isArray(rule.subjects)) {
        problems.push(`${where} needs a "subjects" array.`);
        continue;
      }
      if (rule.reason !== undefined && !isString(rule.reason)) {
        problems.push(`${where}.reason must be a string.`);
      }
      const subjects: ExportedSubject[] = [];
      let subjectsOk = true;
      for (const [subjectIndex, subject] of rule.subjects.entries()) {
        const parsedSubject = parseSubject(
          subject,
          `${where}.subjects[${subjectIndex}]`,
          problems,
        );
        if (parsedSubject === undefined) {
          subjectsOk = false;
          continue;
        }
        subjects.push(parsedSubject);
      }
      if (!subjectsOk) {
        continue;
      }
      parsed.push({
        key: rule.key,
        ...base,
        subjects,
        ...(isString(rule.reason) ? { reason: rule.reason } : {}),
      });
    }
    switch (key) {
      case 'defaultAccess':
        result.defaultAccess = parsed as ExportedDefaultAccessRule[];
        break;
      case 'sharing':
        result.sharing = parsed as ExportedSharingRule[];
        break;
      case 'restriction':
        result.restriction = parsed as ExportedRestrictionRule[];
        break;
    }
  }
  return result;
}

function parseProtections(
  value: unknown,
  problems: string[],
): ExportedProtection[] {
  if (!Array.isArray(value)) {
    problems.push('"protected" must be an array.');
    return [];
  }
  const parsed: ExportedProtection[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of value.entries()) {
    if (!isRecord(entry) || !isString(entry.key)) {
      problems.push(`protected[${index}] needs a string "key".`);
      continue;
    }
    if (seen.has(entry.key)) {
      problems.push(`protected repeats the key "${entry.key}".`);
      continue;
    }
    seen.add(entry.key);
    const protection = entry.protection;
    if (!isRecord(protection) || !isString(protection.owner)) {
      problems.push(`protected[${index}].protection needs a string "owner".`);
      continue;
    }
    if (!Array.isArray(protection.allow)) {
      problems.push(`protected[${index}].protection needs an "allow" array.`);
      continue;
    }
    parsed.push({
      key: entry.key,
      protection: protection as unknown as PermissionSetProtectionInfo,
    });
  }
  return parsed;
}
