import { isDeepStrictEqual } from 'node:util';

import { CommandError } from '@nocobase/app-cli';
import type { AppAuthorization } from '@nocobase/app-plugin-authorization/server';
import type {
  DefaultAccessAuthorizationApi,
  DefaultAccessRule,
} from '@nocobase/authorization/default-access';
import type {
  PermissionSet,
  PermissionSetProtectionInfo,
} from '@nocobase/authorization/permission-sets';
import type {
  RestrictionRule,
  RestrictionRulesAuthorizationApi,
} from '@nocobase/authorization/restriction-rules';
import type {
  SharingRule,
  SharingRulesAuthorizationApi,
} from '@nocobase/authorization/sharing-rules';
import type {
  AuthorizationSubject,
  RuleAction,
} from '@nocobase/authorization/core';
import type { DatabaseConnection, DatabaseManager } from '@nocobase/db';

import {
  AUTHORIZATION_EXPORT_FORMAT,
  isServiceAccountSubject,
  isUsernameSubject,
  type AuthorizationExportFile,
  type ExportedAssignment,
  type ExportedDefaultAccessRule,
  type ExportedPermissionSet,
  type ExportedRuleAction,
  type ExportedSharingRule,
  type ExportedSubject,
} from './format.js';

/**
 * 导出与导入共用的服务层逻辑（R-013 验收第 8 条）。
 *
 * 两个命令都不走 HTTP：命令行里没有权限门，直接读授权插件挂在应用上的服务。
 * 应用必须先 `start()`：本应用的 FQC 业务资源在 provider 的 `boot()` 里注册，
 * 没注册时 `compositeResources.validateGrant` 会把每一条业务授权都判成无效。
 *
 * 导入的校验分两层：`format.ts` 管结构（不崩溃、字段齐全），这里管语义（用户名、
 * 服务账号、主体类型、授权内容、规则 selection、默认访问规则冲突、受保护标记）。
 * 两层都在写之前完成，任何问题都列全再退出。
 */
export type AuthorizationApis = AppAuthorization &
  DefaultAccessAuthorizationApi<DatabaseConnection> &
  SharingRulesAuthorizationApi<DatabaseConnection> &
  RestrictionRulesAuthorizationApi<DatabaseConnection>;

type GrantPolicy = {
  type: string;
  [key: string]: unknown;
};

export interface Counts {
  created: number;
  updated: number;
  unchanged: number;
}

export interface ImportChanges {
  created: string[];
  updated: string[];
}

export interface ImportSummary {
  permissionSets: Counts;
  assignments: Counts;
  defaultAccess: Counts;
  sharing: Counts;
  restriction: Counts;
  changes: ImportChanges;
}

const emptyCounts = (): Counts => ({ created: 0, updated: 0, unchanged: 0 });

export interface ExportSummary {
  permissionSets: number;
  assignments: number;
  defaultAccess: number;
  sharing: number;
  restriction: number;
  protected: number;
}

interface UserIdentity {
  username?: string;
  kind?: string;
  name?: string;
}

interface UserRow {
  id: unknown;
  username: unknown;
  kind: unknown;
  name: unknown;
}

async function userIdentitiesById(
  database: DatabaseManager,
): Promise<Map<string, UserIdentity>> {
  const rows = (await database
    .connection()
    .query.selectFrom('user')
    .select(['id', 'username', 'kind', 'name'])
    .where('deletedAt', 'is', null)
    .execute()) as unknown as UserRow[];
  const identities = new Map<string, UserIdentity>();
  for (const row of rows) {
    identities.set(String(row.id), {
      ...(typeof row.username === 'string' && row.username.length > 0
        ? { username: row.username }
        : {}),
      ...(typeof row.kind === 'string' ? { kind: row.kind } : {}),
      ...(typeof row.name === 'string' ? { name: row.name } : {}),
    });
  }
  return identities;
}

/**
 * 一个主体在文件里的跨环境写法。普通账号按 username，服务账号（没有 username）
 * 按 name；其它主体类型的 id 与环境无关，原样保留。认不出来的返回 undefined。
 */
function exportSubject(
  subject: { type: string; id: string },
  identities: Map<string, UserIdentity>,
): ExportedSubject | undefined {
  if (subject.type !== 'user') {
    return { type: subject.type, id: subject.id };
  }
  const identity = identities.get(subject.id);
  if (identity === undefined) {
    return undefined;
  }
  if (identity.kind === 'service') {
    return identity.name === undefined
      ? undefined
      : { type: 'user', kind: 'service', name: identity.name };
  }
  return identity.username === undefined
    ? undefined
    : { type: 'user', username: identity.username };
}

function subjectLabel(subject: ExportedSubject): string {
  if (isUsernameSubject(subject)) {
    return `user "${subject.username}"`;
  }
  if (isServiceAccountSubject(subject)) {
    return `service account "${subject.name}"`;
  }
  return `${subject.type}:${subject.id}`;
}

function subjectKeys(
  subject: { type: string; id: string },
  permissionSet: string,
): string {
  return `${subject.type}\u0000${subject.id}\u0000${permissionSet}`;
}

/** 与服务层生成赋权 id 的规则一致（`type:id:set`），让报错能直接拿去核对。 */
function assignmentId(
  subject: { type: string; id: string },
  permissionSet: string,
): string {
  return `${subject.type}:${subject.id}:${permissionSet}`;
}

function compareAssignments(
  left: ExportedAssignment,
  right: ExportedAssignment,
): number {
  const key = (assignment: ExportedAssignment) =>
    `${assignment.permissionSet}\u0000${subjectLabel(assignment.subject)}`;
  return key(left).localeCompare(key(right));
}

function exportRuleActions(rule: {
  actions: readonly RuleAction[];
}): ExportedRuleAction[] {
  return rule.actions.map((action) => ({
    action: action.action,
    ...(action.scopeKey === undefined ? {} : { scopeKey: action.scopeKey }),
    selection: action.selection,
  }));
}

function exportBaseRule(rule: {
  key: string;
  resource: { type: string; id: string };
  actions: readonly RuleAction[];
  title?: ExportedDefaultAccessRule['title'];
}): ExportedDefaultAccessRule {
  return {
    key: rule.key,
    resource: { type: rule.resource.type, id: rule.resource.id },
    actions: exportRuleActions(rule),
    ...(rule.title === undefined ? {} : { title: rule.title }),
  };
}

function exportSubjectRule(
  rule: SharingRule | RestrictionRule,
  identities: Map<string, UserIdentity>,
  kind: string,
  problems: string[],
): ExportedSharingRule | undefined {
  const subjects: ExportedSubject[] = [];
  let ok = true;
  for (const subject of rule.subjects) {
    const exported = exportSubject(subject, identities);
    if (exported === undefined) {
      problems.push(
        `Rule "${kind}:${rule.key}" refers to ${subject.type} ${subject.id}, which this environment cannot name (the account is missing, deleted, or has neither a username nor a service-account name).`,
      );
      ok = false;
      continue;
    }
    subjects.push(exported);
  }
  if (!ok) {
    return undefined;
  }
  return {
    ...exportBaseRule(rule),
    subjects,
    ...(rule.reason === undefined ? {} : { reason: rule.reason }),
  };
}

/**
 * 读出一份完整的导出。赋权与规则里的用户主体按 username（服务账号按 name）写；
 * 用户既没有 username 也不是有名字的服务账号时，导不出一份能在别处重建的文件，
 * 所以导出直接失败并逐条列出是哪一行。
 */
export async function collectAuthorizationExport(
  authz: AuthorizationApis,
  database: DatabaseManager,
): Promise<{ file: AuthorizationExportFile; summary: ExportSummary }> {
  const [sets, assignments, defaultAccess, sharing, restriction] =
    await Promise.all([
      authz.permissionSets.list(),
      authz.permissionSets.listAssignments(),
      authz.defaultAccess.list(),
      authz.sharingRules.list(),
      authz.restrictionRules.list(),
    ]);

  const identities = await userIdentitiesById(database);
  const unresolved: string[] = [];
  const exportedAssignments: ExportedAssignment[] = [];
  for (const assignment of assignments) {
    const subject = exportSubject(assignment.subject, identities);
    if (subject === undefined) {
      unresolved.push(
        `Assignment "${assignmentId(assignment.subject, assignment.permissionSet)}" cannot be exported: ${assignment.subject.type} ${assignment.subject.id} is missing or deleted, or has neither a username nor a service-account name.`,
      );
      continue;
    }
    exportedAssignments.push({
      subject,
      permissionSet: assignment.permissionSet,
    });
  }

  const exportedDefaultAccess: ExportedDefaultAccessRule[] = [];
  for (const rule of defaultAccess) {
    const exported = exportBaseRule(rule);
    exportedDefaultAccess.push(exported);
  }
  const exportedSharing: ExportedSharingRule[] = [];
  for (const rule of sharing) {
    const exported = exportSubjectRule(rule, identities, 'sharing', unresolved);
    if (exported !== undefined) {
      exportedSharing.push(exported);
    }
  }
  const exportedRestriction: ExportedSharingRule[] = [];
  for (const rule of restriction) {
    const exported = exportSubjectRule(
      rule,
      identities,
      'restriction',
      unresolved,
    );
    if (exported !== undefined) {
      exportedRestriction.push(exported);
    }
  }
  if (unresolved.length > 0) {
    throw new CommandError(
      'The authorization data cannot be exported without losing rows.',
      {
        code: 'EXPORT_INCOMPLETE',
        details: { problems: unresolved },
      },
    );
  }

  const protectedSets = sets.flatMap((set) => {
    const protection = authz.permissionSets.protection(set.key);
    return protection === undefined
      ? []
      : [{ key: set.key, protection: { ...protection } }];
  });

  const file: AuthorizationExportFile = {
    format: AUTHORIZATION_EXPORT_FORMAT,
    exportedAt: new Date().toISOString(),
    permissionSets: sets.map((set) => ({
      key: set.key,
      revision: set.revision ?? '',
      ...(set.title === undefined ? {} : { title: set.title }),
      grants: set.grants,
    })),
    assignments: exportedAssignments.sort(compareAssignments),
    rules: {
      defaultAccess: sortRules(exportedDefaultAccess),
      sharing: sortRules(exportedSharing),
      restriction: sortRules(exportedRestriction),
    },
    protected: protectedSets,
  };

  return {
    file,
    summary: {
      permissionSets: file.permissionSets.length,
      assignments: file.assignments.length,
      defaultAccess: file.rules.defaultAccess.length,
      sharing: file.rules.sharing.length,
      restriction: file.rules.restriction.length,
      protected: file.protected.length,
    },
  };
}

function sortRules<T extends { key: string }>(rules: readonly T[]): T[] {
  return [...rules].sort((left, right) => left.key.localeCompare(right.key));
}

export interface ImportPlanItem {
  label: string;
  apply(): Promise<void>;
}

export interface ImportPlan {
  problems: string[];
  items: ImportPlanItem[];
  unchanged: string[];
  summary: ImportSummary;
}

interface ImportIdentities {
  userIdByUsername: Map<string, string>;
  serviceAccountIdsByName: Map<string, string[]>;
  declaredSubjectTypes: Set<string>;
}

async function importIdentities(
  authz: AuthorizationApis,
  database: DatabaseManager,
): Promise<ImportIdentities> {
  const userIdByUsername = new Map<string, string>();
  const serviceAccountIdsByName = new Map<string, string[]>();
  for (const [id, identity] of await userIdentitiesById(database)) {
    if (identity.username !== undefined) {
      userIdByUsername.set(identity.username.trim().toLowerCase(), id);
    }
    if (identity.kind === 'service' && identity.name !== undefined) {
      const key = identity.name.trim();
      serviceAccountIdsByName.set(key, [
        ...(serviceAccountIdsByName.get(key) ?? []),
        id,
      ]);
    }
  }
  return {
    userIdByUsername,
    serviceAccountIdsByName,
    declaredSubjectTypes: new Set(authz.subjects.list()),
  };
}

/** 把文件里的主体落到目标环境的 id；认不出来就列成问题。 */
function resolveSubject(
  subject: ExportedSubject,
  identities: ImportIdentities,
  where: string,
  problems: string[],
): AuthorizationSubject | undefined {
  if (isUsernameSubject(subject)) {
    const username = subject.username.trim().toLowerCase();
    const id = identities.userIdByUsername.get(username);
    if (id === undefined) {
      problems.push(`Unknown username "${subject.username}" in ${where}.`);
      return undefined;
    }
    return { type: 'user', id };
  }
  if (isServiceAccountSubject(subject)) {
    const name = subject.name.trim();
    const candidates = identities.serviceAccountIdsByName.get(name) ?? [];
    if (candidates.length === 0) {
      problems.push(`Unknown service account "${subject.name}" in ${where}.`);
      return undefined;
    }
    if (candidates.length > 1) {
      problems.push(
        `Ambiguous service account "${subject.name}" in ${where}: ${candidates.length} service accounts have that name.`,
      );
      return undefined;
    }
    return { type: 'user', id: candidates[0] as string };
  }
  if (!identities.declaredSubjectTypes.has(subject.type)) {
    problems.push(
      `Subject type "${subject.type}" is not declared, in ${where}.`,
    );
    return undefined;
  }
  return { type: subject.type, id: subject.id };
}

interface ResolvedAssignment {
  label: string;
  subject: AuthorizationSubject;
  permissionSet: string;
}

interface ResolvedRules {
  defaultAccess: DefaultAccessRule[];
  sharing: SharingRule[];
  restriction: RestrictionRule[];
}

/**
 * 校验并排好导入计划。校验不通过时 `items` 是空的 —— 调用方拿到问题之后
 * 一行都不能写。计划本身在写入之前算好，写到一半失败时才知道哪些还没写。
 */
export async function planAuthorizationImport(
  authz: AuthorizationApis,
  database: DatabaseManager,
  file: AuthorizationExportFile,
): Promise<ImportPlan> {
  const problems: string[] = [];
  const fileSetKeys = new Set(file.permissionSets.map((set) => set.key));
  const currentSets = await authz.permissionSets.list();
  const targetSetKeys = new Set(currentSets.map((set) => set.key));
  const identities = await importIdentities(authz, database);
  const { parseRecordSelection } = await import('@nocobase/authorization/core');

  for (const set of file.permissionSets) {
    for (const grant of set.grants) {
      for (const action of grant.actions) {
        const problem = grantProblem(
          authz,
          `Permission set "${set.key}"`,
          grant.resource,
          action.action,
          { policy: action.policy },
        );
        if (problem !== undefined) {
          problems.push(problem);
        }
      }
    }
  }

  const assignments: ResolvedAssignment[] = [];
  for (const assignment of file.assignments) {
    const where = `assignment to "${assignment.permissionSet}"`;
    const label = `assignment ${subjectLabel(assignment.subject)} → "${assignment.permissionSet}"`;
    if (
      !fileSetKeys.has(assignment.permissionSet) &&
      !targetSetKeys.has(assignment.permissionSet)
    ) {
      problems.push(
        `Assignment to "${assignment.permissionSet}" names a permission set the file and this application do not define.`,
      );
      continue;
    }
    const assignableTo = authz.permissionSets.protection(
      assignment.permissionSet,
    )?.assignableTo;
    if (
      assignableTo !== undefined &&
      !assignableTo.includes(assignment.subject.type)
    ) {
      problems.push(
        `"${assignment.permissionSet}" may not be assigned to subject type "${assignment.subject.type}".`,
      );
      continue;
    }
    const subject = resolveSubject(
      assignment.subject,
      identities,
      where,
      problems,
    );
    if (subject === undefined) {
      continue;
    }
    assignments.push({
      label,
      subject,
      permissionSet: assignment.permissionSet,
    });
  }

  const rules = await resolveRules(
    authz,
    file,
    identities,
    parseRecordSelection,
    problems,
  );

  problems.push(...protectionProblems(authz, file));

  if (problems.length > 0) {
    return {
      problems,
      items: [],
      unchanged: [],
      summary: emptyImportSummary(),
    };
  }

  const plan: ImportPlan = {
    problems,
    items: [],
    unchanged: [],
    summary: emptyImportSummary(),
  };

  await planPermissionSets(authz, currentSets, file, plan);
  await planAssignments(authz, assignments, plan);
  await planRules(authz, rules, plan);
  return plan;
}

function emptyImportSummary(): ImportSummary {
  return {
    permissionSets: emptyCounts(),
    assignments: emptyCounts(),
    defaultAccess: emptyCounts(),
    sharing: emptyCounts(),
    restriction: emptyCounts(),
    changes: { created: [], updated: [] },
  };
}

interface GrantProblemOptions {
  policy?: GrantPolicy;
  /**
   * 规则里的 `resource.id` 可以是 `*`，表示「这一类里的任意一项」（框架的
   * `RuleService.constraints` 按 `rule.resource.id !== '*'` 放行每一条）。
   * 这种资源没法按具体 id 查，只能核对类型本身声明的动作。
   */
  allowWildcard?: boolean;
}

function grantProblem(
  authz: AuthorizationApis,
  where: string,
  resource: { type: string; id: string },
  action: string,
  options: GrantProblemOptions = {},
): string | undefined {
  const { policy, allowWildcard = false } = options;
  if (resource.type === 'composite') {
    const reason = authz.compositeResources.validateGrant({
      resource,
      action,
      ...(policy === undefined ? {} : { policy }),
    });
    return reason === undefined ? undefined : `${where}: ${reason}.`;
  }
  if (!authz.resourceTypes.has(resource.type)) {
    return `${where}: resource type "${resource.type}" is not registered.`;
  }
  const type = authz.resourceTypes.get(resource.type);
  if (allowWildcard && resource.id === '*') {
    // 目录型资源的每一项可以自己声明动作，按 `*` 查 item 永远查不到；
    // 改为要求「类型或某一项支持这个动作」——类型声明的动作是所有项的上限，
    // 没声明类型的目录（例如 settings）只能退到逐项看。
    const supported =
      type.actions.some((entry) => entry.name === action) ||
      (type.items?.list() ?? []).some((item) =>
        item.actions.some((entry) => entry.name === action),
      );
    if (!supported) {
      return `${where}: action "${action}" is not registered for resource type "${resource.type}".`;
    }
    return undefined;
  }
  if (type.items !== undefined) {
    const item = type.items.get(resource.id);
    if (item === undefined) {
      return `${where}: resource "${resource.type}:${resource.id}" is not registered.`;
    }
    if (!item.actions.some((entry) => entry.name === action)) {
      return `${where}: action "${action}" is not registered for "${resource.type}:${resource.id}".`;
    }
    return undefined;
  }
  if (!type.actions.some((entry) => entry.name === action)) {
    return `${where}: action "${action}" is not registered for resource type "${resource.type}".`;
  }
  return undefined;
}

type RuleKindName = 'default-access' | 'sharing' | 'restriction';

/**
 * 与服务层 `RuleKind.allowAll` 一致（`@nocobase/authorization` 的三个规则插件）：
 * 共享规则的 `allowAll` 是 false，默认访问与限制规则是 true。服务层要到写入时
 * 才拒绝，导入必须在这里提前拦下。
 */
const RULE_ALLOWS_ALL: Record<RuleKindName, boolean> = {
  'default-access': true,
  sharing: false,
  restriction: true,
};

function resolveRuleActions(
  authz: AuthorizationApis,
  rule: { key: string; resource: { type: string; id: string } },
  kind: RuleKindName,
  actions: readonly ExportedRuleAction[],
  parseRecordSelection: (value: unknown) => RuleAction['selection'],
  problems: string[],
): RuleAction[] | undefined {
  const where = `${kind} rule "${rule.key}"`;
  const allowsAll = RULE_ALLOWS_ALL[kind];
  const resolved: RuleAction[] = [];
  const seen = new Set<string>();
  let ok = true;
  for (const action of actions) {
    const actionWhere = `${where} action "${action.action}"`;
    const problem = grantProblem(authz, where, rule.resource, action.action, {
      allowWildcard: true,
    });
    if (problem !== undefined) {
      problems.push(problem);
      ok = false;
    }
    const selectionKey = JSON.stringify([
      action.action,
      action.scopeKey ?? null,
    ]);
    if (seen.has(selectionKey)) {
      problems.push(
        `${where} repeats action "${action.action}"${
          action.scopeKey === undefined
            ? ''
            : ` with scope "${action.scopeKey}"`
        }.`,
      );
      ok = false;
      continue;
    }
    seen.add(selectionKey);
    if (action.selection === undefined) {
      problems.push(`${actionWhere} needs a "selection".`);
      ok = false;
      continue;
    }
    let selection: RuleAction['selection'];
    try {
      selection = parseRecordSelection(action.selection);
    } catch (error) {
      problems.push(
        `${actionWhere} has an invalid selection: ${
          error instanceof Error ? error.message : String(error)
        }.`,
      );
      ok = false;
      continue;
    }
    if (selection.type === 'all' && !allowsAll) {
      problems.push(`${actionWhere} cannot select all records.`);
      ok = false;
      continue;
    }
    resolved.push({
      action: action.action,
      ...(action.scopeKey === undefined ? {} : { scopeKey: action.scopeKey }),
      selection,
    });
  }
  return ok ? resolved : undefined;
}

async function resolveRules(
  authz: AuthorizationApis,
  file: AuthorizationExportFile,
  identities: ImportIdentities,
  parseRecordSelection: (value: unknown) => RuleAction['selection'],
  problems: string[],
): Promise<ResolvedRules> {
  const resolved: ResolvedRules = {
    defaultAccess: [],
    sharing: [],
    restriction: [],
  };

  for (const rule of file.rules.defaultAccess) {
    const actions = resolveRuleActions(
      authz,
      rule,
      'default-access',
      rule.actions,
      parseRecordSelection,
      problems,
    );
    if (actions === undefined) {
      continue;
    }
    resolved.defaultAccess.push({
      key: rule.key,
      resource: rule.resource,
      actions,
      ...(rule.title === undefined ? {} : { title: rule.title }),
    });
  }

  for (const [kind, rules] of [
    ['sharing', file.rules.sharing],
    ['restriction', file.rules.restriction],
  ] as const) {
    for (const rule of rules) {
      const actions = resolveRuleActions(
        authz,
        rule,
        kind,
        rule.actions,
        parseRecordSelection,
        problems,
      );
      if (actions === undefined) {
        continue;
      }
      const subjects: AuthorizationSubject[] = [];
      let subjectsOk = true;
      for (const subject of rule.subjects) {
        const target = resolveSubject(
          subject,
          identities,
          `${kind} rule "${rule.key}" subject`,
          problems,
        );
        if (target === undefined) {
          subjectsOk = false;
          continue;
        }
        subjects.push(target);
      }
      if (!subjectsOk) {
        continue;
      }
      const resolvedRule = {
        key: rule.key,
        resource: rule.resource,
        actions,
        subjects,
        ...(rule.title === undefined ? {} : { title: rule.title }),
        ...(rule.reason === undefined ? {} : { reason: rule.reason }),
      };
      if (kind === 'sharing') {
        resolved.sharing.push(resolvedRule as SharingRule);
      } else {
        resolved.restriction.push(resolvedRule as RestrictionRule);
      }
    }
  }

  problems.push(
    ...(await defaultAccessConflicts(authz, resolved.defaultAccess)),
  );
  return resolved;
}

/**
 * 默认访问规则一个资源只能有一条。文件内部重复、或与目标库已有的规则撞同一个
 * 资源，都必须在写之前列出来 —— 服务层的 create/update 会在写到一半时才会报。
 *
 * 冲突按**导入之后**的状态判：文件里同 key 的规则会覆盖库内那条，被挪走或改掉
 * 的旧规则不再占原资源，新规则可以接管它。拿库内当前状态判会把合法的文件整份拒掉。
 */
async function defaultAccessConflicts(
  authz: AuthorizationApis,
  rules: readonly DefaultAccessRule[],
): Promise<string[]> {
  const problems: string[] = [];
  const fileKeys = new Set(rules.map((rule) => rule.key));
  const remainingByResource = new Map(
    (await authz.defaultAccess.list())
      .filter((rule) => !fileKeys.has(rule.key))
      .map((rule) => [resourceKey(rule.resource), rule.key]),
  );
  const fileByResource = new Map<string, string>();
  for (const rule of rules) {
    const key = resourceKey(rule.resource);
    const other = fileByResource.get(key);
    if (other !== undefined && other !== rule.key) {
      problems.push(
        `The file defines two default-access rules for resource "${rule.resource.type}:${rule.resource.id}": "${other}" and "${rule.key}".`,
      );
      continue;
    }
    fileByResource.set(key, rule.key);
    const existing = remainingByResource.get(key);
    if (existing !== undefined) {
      problems.push(
        `Default-access rule "${rule.key}" targets "${rule.resource.type}:${rule.resource.id}", which already has a default-access rule "${existing}".`,
      );
    }
  }
  // 文件里同 key 的规则在终态里只占一条资源（原地 update 或挪到新资源），因此
  // 库内那条不再参与上面的判断；其余情况交给服务层。
  return problems;
}

function resourceKey(resource: { type: string; id: string }): string {
  return `${resource.type}\u0000${resource.id}`;
}

function protectionProblems(
  authz: AuthorizationApis,
  file: AuthorizationExportFile,
): string[] {
  const problems: string[] = [];
  const declared = new Map(
    file.protected.map((entry) => [entry.key, entry.protection]),
  );
  for (const [key, protection] of declared) {
    if (!file.permissionSets.some((set) => set.key === key)) {
      problems.push(
        `The file records a protection for "${key}", which it does not define as a permission set.`,
      );
      continue;
    }
    const code = authz.permissionSets.protection(key);
    if (code === undefined) {
      problems.push(
        `The file marks "${key}" as protected, but this application declares no protection for it.`,
      );
      continue;
    }
    const differences = protectionDifferences(protection, code);
    if (differences.length > 0) {
      problems.push(
        `The protection of "${key}" differs from this application: ${differences.join(', ')}.`,
      );
    }
  }
  for (const set of file.permissionSets) {
    if (
      authz.permissionSets.protection(set.key) !== undefined &&
      !declared.has(set.key)
    ) {
      problems.push(
        `This application protects "${set.key}", but the file does not record its protection.`,
      );
    }
  }
  return problems;
}

function normalizedProtection(protection: PermissionSetProtectionInfo) {
  return {
    owner: protection.owner,
    allow: [...protection.allow].sort(),
    requireActiveAssignment: protection.requireActiveAssignment === true,
    unrestricted: protection.unrestricted === true,
    assignableTo:
      protection.assignableTo === undefined
        ? null
        : [...protection.assignableTo].sort(),
    hidden: protection.hidden === true,
  };
}

function protectionDifferences(
  declared: PermissionSetProtectionInfo,
  code: PermissionSetProtectionInfo,
): string[] {
  const left = normalizedProtection(declared);
  const right = normalizedProtection(code);
  const differences: string[] = [];
  for (const field of Object.keys(left) as (keyof typeof left)[]) {
    if (!isDeepStrictEqual(left[field], right[field])) {
      differences.push(
        `${field} is ${JSON.stringify(left[field])} in the file and ${JSON.stringify(right[field])} here`,
      );
    }
  }
  return differences;
}

async function planPermissionSets(
  authz: AuthorizationApis,
  currentSets: readonly PermissionSet[],
  file: AuthorizationExportFile,
  plan: ImportPlan,
): Promise<void> {
  const existing = new Map(currentSets.map((set) => [set.key, set]));
  for (const set of file.permissionSets) {
    const current = existing.get(set.key);
    if (current === undefined) {
      plan.items.push({
        label: `permission set "${set.key}"`,
        apply: async () => {
          await authz.permissionSets.create(toSetInput(set));
        },
      });
      plan.summary.permissionSets.created += 1;
      plan.summary.changes.created.push(`permission set "${set.key}"`);
      continue;
    }
    if (
      isDeepStrictEqual(
        { title: current.title, grants: current.grants },
        { title: set.title, grants: set.grants },
      )
    ) {
      plan.unchanged.push(`permission set "${set.key}"`);
      plan.summary.permissionSets.unchanged += 1;
      continue;
    }
    try {
      authz.permissionSets.assertWritable(set.key, 'update');
    } catch (error) {
      plan.problems.push(
        `Permission set "${set.key}" is protected and its content differs: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      continue;
    }
    plan.items.push({
      label: `permission set "${set.key}"`,
      apply: async () => {
        await authz.permissionSets.update(
          set.key,
          toSetInput(set),
          current.revision,
        );
      },
    });
    plan.summary.permissionSets.updated += 1;
    plan.summary.changes.updated.push(`permission set "${set.key}"`);
  }
}

function toSetInput(set: ExportedPermissionSet) {
  return {
    key: set.key,
    ...(set.title === undefined ? {} : { title: set.title }),
    grants: set.grants,
  };
}

async function planAssignments(
  authz: AuthorizationApis,
  assignments: readonly ResolvedAssignment[],
  plan: ImportPlan,
): Promise<void> {
  const existing = new Set<string>();
  for (const assignment of await authz.permissionSets.listAssignments()) {
    existing.add(subjectKeys(assignment.subject, assignment.permissionSet));
  }
  const planned = new Set<string>();
  for (const assignment of assignments) {
    const keys = subjectKeys(assignment.subject, assignment.permissionSet);
    if (existing.has(keys) || planned.has(keys)) {
      plan.unchanged.push(assignment.label);
      plan.summary.assignments.unchanged += 1;
      continue;
    }
    planned.add(keys);
    plan.items.push({
      label: assignment.label,
      apply: async () => {
        await authz.permissionSets.assign({
          subject: assignment.subject,
          permissionSet: assignment.permissionSet,
        });
      },
    });
    plan.summary.assignments.created += 1;
    plan.summary.changes.created.push(assignment.label);
  }
}

async function planRules(
  authz: AuthorizationApis,
  rules: ResolvedRules,
  plan: ImportPlan,
): Promise<void> {
  await planRuleKind(
    plan,
    'defaultAccess',
    await orderDefaultAccess(authz, rules.defaultAccess),
    authz.defaultAccess,
    plan.summary.defaultAccess,
  );
  await planRuleKind(
    plan,
    'sharing',
    rules.sharing,
    authz.sharingRules,
    plan.summary.sharing,
  );
  await planRuleKind(
    plan,
    'restriction',
    rules.restriction,
    authz.restrictionRules,
    plan.summary.restriction,
  );
}

interface RuleApiLike<T extends { key: string }> {
  list(): Promise<readonly T[]>;
  create(rule: T): Promise<unknown>;
  update(key: string, rule: T): Promise<unknown>;
}

/**
 * 默认访问规则一个资源只能有一条，所以写入顺序会影响成败：换了资源的更新要先写，
 * 把原资源让给接手它的新规则。冲突本身已按导入后的状态判过（`defaultAccessConflicts`），
 * 这里只保证执行顺序不会撞上「本来就要挪走」的旧规则。
 */
async function orderDefaultAccess(
  authz: AuthorizationApis,
  rules: readonly DefaultAccessRule[],
): Promise<readonly DefaultAccessRule[]> {
  const currentByKey = new Map(
    (await authz.defaultAccess.list()).map((rule) => [rule.key, rule]),
  );
  const vacating = rules.filter((rule) => {
    const current = currentByKey.get(rule.key);
    return (
      current !== undefined &&
      resourceKey(current.resource) !== resourceKey(rule.resource)
    );
  });
  const vacatingRules = new Set(vacating);
  return [...vacating, ...rules.filter((rule) => !vacatingRules.has(rule))];
}

async function planRuleKind<T extends { key: string }>(
  plan: ImportPlan,
  kind: string,
  rules: readonly T[],
  api: RuleApiLike<T>,
  counts: Counts,
): Promise<void> {
  const existing = new Map((await api.list()).map((rule) => [rule.key, rule]));
  for (const rule of rules) {
    const label = `${kind} rule "${rule.key}"`;
    const current = existing.get(rule.key);
    if (current === undefined) {
      plan.items.push({
        label,
        apply: async () => {
          await api.create(rule);
        },
      });
      counts.created += 1;
      plan.summary.changes.created.push(label);
      continue;
    }
    if (isDeepStrictEqual(current, rule)) {
      plan.unchanged.push(label);
      counts.unchanged += 1;
      continue;
    }
    plan.items.push({
      label,
      apply: async () => {
        await api.update(rule.key, rule);
      },
    });
    counts.updated += 1;
    plan.summary.changes.updated.push(label);
  }
}

/**
 * 执行计划。写到一半失败时停下：已经写入的、失败的那一条、还没写的都交给调用方。
 * 不为了「整批回滚」绕开服务层直接写表 —— 重跑是幂等的，这是设计接受的代价。
 */
export async function applyAuthorizationImport(
  plan: ImportPlan,
): Promise<ImportSummary> {
  const written: string[] = [];
  for (const [index, item] of plan.items.entries()) {
    try {
      await item.apply();
    } catch (error) {
      const notWritten = plan.items
        .slice(index + 1)
        .map((entry) => entry.label);
      throw new CommandError(
        'The import stopped after a write failed; nothing else was written.',
        {
          code: 'IMPORT_WRITE_FAILED',
          details: {
            written,
            failed: [item.label],
            notWritten,
            unchanged: plan.unchanged,
            reason: error instanceof Error ? error.message : String(error),
          },
          cause: error,
        },
      );
    }
    written.push(item.label);
  }
  return plan.summary;
}
