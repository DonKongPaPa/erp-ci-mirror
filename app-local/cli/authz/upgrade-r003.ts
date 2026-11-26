import type { AppAuthorization } from '@nocobase/app-plugin-authorization';
import { AppCommand } from '@nocobase/app-cli';
import {
  PermissionSetConflictError,
  type CreatePermissionSetInput,
} from '@nocobase/authorization/permission-sets';

/**
 * R-003 的升级步骤：`pnpm nocobase authz upgrade-r003`。
 *
 * seed 只对新建的环境生效，已初始化的环境里两个质量角色拿不到「处理工单」，
 * 质量主管拿不到「维护派单规则」。第一步只做加法：把这三样补上，已有的授权
 * 逐条原样留着，绝不改写「查看、处理」那条，别的角色也不碰。
 *
 * - 判据是能展开的有效授权：页面授权要看不带 policy 的 access，业务动作要看
 *   能按当前声明展开的 `composite` 授权；只看动作名会把带条件的假授权算成已有；
 * - 写之前按 `fqc` 的当前声明核对动作与数据范围，对不上就整个角色跳过、不写库；
 * - 写入带读到的 `set.revision`，读后被改过就报冲突退出，不覆盖别人的编辑；
 * - 改前改后各记一行；已有就跳过；幂等：第二次什么都不写，版本号不动。
 *
 * 设计点名的两处改动（删投递权限集里的 `fqcTickets` scope、部门主管「查看」收窄）
 * 要等 R-026 第三片合并、投递端点不再建工单之后才做，放在第二步。
 */
const FQC = 'fqc';
const ALL_RECORDS = 'allRecords';
const TICKET_SCOPES = { fqcTickets: ALL_RECORDS } as const;
const CONFIGURE_SCOPES = { fqcRoutingRules: ALL_RECORDS } as const;

/** 两个质量角色都要能处理工单；维护派单规则只给质量主管。 */
const TARGET_ROLES = ['quality_manager', 'quality_inspector'] as const;
const CONFIGURE_ROLES = ['quality_manager'] as const;
type TargetRole = (typeof TARGET_ROLES)[number];

export interface UpgradeLogger {
  info(message: string): void;
}

export interface GrantUpgradeReport {
  readonly targets: readonly string[];
  readonly changed: readonly string[];
  readonly unchanged: readonly string[];
  readonly missing: readonly string[];
  /** 因为声明对不上而整个跳过的角色。 */
  readonly invalid: readonly string[];
}

type UpgradeAuthorization = Pick<
  AppAuthorization,
  'permissionSets' | 'compositeResources'
>;

interface StoredGrantAction {
  action: string;
  policy?: { type: string; scopes?: Record<string, unknown> };
}
interface StoredGrant {
  resource: { type: string; id: string };
  actions: StoredGrantAction[];
}
interface StoredSet {
  readonly revision?: string;
  readonly title?: CreatePermissionSetInput['title'];
  readonly grants: CreatePermissionSetInput['grants'];
}

function fqcGrant(
  action: string,
  scopes: Readonly<Record<string, string>>,
): StoredGrant {
  return {
    resource: { type: 'composite', id: FQC },
    actions: [{ action, policy: { type: 'composite', scopes: { ...scopes } } }],
  };
}

/**
 * 写之前按当前声明核对：动作必须存在，每个范围键必须是它声明的，取值必须在
 * 声明给的选项里，整条授权还得能被服务层展开。对不上就返回原因、不写库 ——
 * 硬塞一个没声明的键，启动扫描会把整条授权拒掉（R-002 查错踩过）。
 */
function validateFqcGrant(
  authz: UpgradeAuthorization,
  grant: StoredGrant,
): string | undefined {
  const action = grant.actions[0]!;
  const definition = authz.compositeResources.getAction(FQC, action.action);
  if (!definition) {
    return `unknown fqc action ${action.action}`;
  }
  const scopes = action.policy?.scopes ?? {};
  for (const [key, value] of Object.entries(scopes)) {
    const scope = definition.dataScopes?.find((entry) => entry.key === key);
    if (!scope) {
      return `fqc.${action.action} has no data scope ${key}`;
    }
    if (scope.options && !scope.options.includes(String(value))) {
      return `fqc.${action.action}.${key} cannot be ${String(value)}`;
    }
  }
  return authz.compositeResources.validateGrant({
    resource: grant.resource,
    action: action.action,
    policy: action.policy,
  });
}

/**
 * 「已有」的判据：能展开的 `composite` 授权才算，带条件但展不开的同动作不算；
 * 不带 policy 的无条件授权也算（框架放行）。光看动作名会把带条件的假授权
 * 当成已补，行为上却什么都没放开。
 */
function hasEffectiveFqcAction(
  authz: UpgradeAuthorization,
  grants: readonly StoredGrant[],
  action: string,
): boolean {
  return grants.some((grant) => {
    if (grant.resource.type !== 'composite' || grant.resource.id !== FQC) {
      return false;
    }
    return grant.actions.some((entry) => {
      if (entry.action !== action) {
        return false;
      }
      if (entry.policy === undefined) {
        return true;
      }
      if (entry.policy.type !== 'composite') {
        return false;
      }
      return (
        authz.compositeResources.validateGrant({
          resource: grant.resource,
          action,
          policy: entry.policy,
        }) === undefined
      );
    });
  });
}

/** 写权限集时带上读到的版本号；读后被改过就报错退出，整份 grants 不会被覆盖。 */
async function updateSetWithRevision(
  authz: UpgradeAuthorization,
  key: string,
  set: StoredSet,
  grants: CreatePermissionSetInput['grants'],
  logger: UpgradeLogger,
): Promise<void> {
  if (set.revision === undefined) {
    logger.info(
      `[r003] ${key}: no revision on the stored set; refusing to overwrite a concurrent edit; nothing written`,
    );
    throw new Error(`[r003] ${key}: permission set has no revision; reload and rerun`);
  }
  try {
    await authz.permissionSets.update(
      key,
      {
        key,
        ...(set.title === undefined ? {} : { title: set.title }),
        grants,
      },
      set.revision,
    );
  } catch (error) {
    logger.info(
      error instanceof PermissionSetConflictError
        ? `[r003] ${key}: revision changed since it was read; nothing written; reload and rerun`
        : `[r003] ${key}: update failed; nothing written; reload and rerun`,
    );
    throw error;
  }
}

/** 把要补的动作压成一行，给改前改后的日志用。 */
function describeR003Grants(grants: readonly StoredGrant[]): string {
  return grants
    .filter((grant) => grant.resource.type === 'composite' && grant.resource.id === FQC)
    .flatMap((grant) =>
      grant.actions.map((entry) => {
        const keys = Object.keys(entry.policy?.scopes ?? {});
        return `${entry.action}[${keys.join(',')}]`;
      }),
    )
    .join('; ');
}

/** 第一步：只给两个质量角色补新动作；已有授权逐条不动，别的角色一个字节不碰。 */
export async function upgradeR003Grants(
  authz: UpgradeAuthorization,
  logger: UpgradeLogger,
): Promise<GrantUpgradeReport> {
  logger.info('[r003] === role grants ===');
  const sets = await authz.permissionSets.list();
  const changed: string[] = [];
  const unchanged: string[] = [];
  const missing: string[] = [];
  const invalid: string[] = [];

  for (const key of TARGET_ROLES) {
    const set = sets.find((entry) => entry.key === key);
    if (!set) {
      missing.push(key);
      logger.info(`[r003] ${key}: not found; skipped`);
      continue;
    }
    const before = structuredClone(set.grants) as unknown as StoredGrant[];
    logger.info(`[r003] ${key} before: ${describeR003Grants(before)}`);

    const needed = [fqcGrant('ticket', TICKET_SCOPES)];
    if ((CONFIGURE_ROLES as readonly string[]).includes(key as TargetRole)) {
      needed.push(fqcGrant('configure', CONFIGURE_SCOPES));
    }
    const problems = needed
      .map((grant) => validateFqcGrant(authz, grant))
      .filter((problem): problem is string => problem !== undefined);
    if (problems.length > 0) {
      for (const problem of problems) {
        logger.info(`[r003] ${key}: declaration mismatch: ${problem}; nothing written`);
      }
      invalid.push(key);
      continue;
    }

    const grants = structuredClone(set.grants) as unknown as StoredGrant[];
    let touched = false;
    for (const grant of needed) {
      const action = grant.actions[0]!.action;
      if (!hasEffectiveFqcAction(authz, grants, action)) {
        grants.push(grant);
        touched = true;
      }
    }
    if (!touched) {
      unchanged.push(key);
      logger.info(
        `[r003] ${key}: already has the new actions; nothing written`,
      );
      continue;
    }

    await updateSetWithRevision(
      authz,
      key,
      set,
      grants as unknown as CreatePermissionSetInput['grants'],
      logger,
    );
    const saved = await authz.permissionSets.get(key);
    logger.info(
      `[r003] ${key} after: ${describeR003Grants(
        structuredClone(saved?.grants ?? []) as unknown as StoredGrant[],
      )}`,
    );
    changed.push(key);
  }

  logger.info(`[r003] added: ${changed.join(',') || '(none)'}`);
  logger.info(
    `[r003] skipped (already current): ${unchanged.join(',') || '(none)'}; ` +
      `missing: ${missing.join(',') || '(none)'}; invalid: ${invalid.join(',') || '(none)'}`,
  );
  return { targets: [...TARGET_ROLES], changed, unchanged, missing, invalid };
}

export interface ScopeUpgradeReport {
  readonly scanned: readonly string[];
  readonly changed: readonly string[];
  readonly unchanged: readonly string[];
  readonly invalid: readonly string[];
}

const DEPT_MANAGER = 'dept_manager';
/** 设计：部门主管的「查看」只保留工单表的「本部门及下级」。 */
const DEPT_VIEW_SCOPES = { fqcTickets: 'org.myDepartmentsAndBelow' } as const;

/** 把 fqc 各动作的范围压成一行，给改前改后的日志用。 */
function describeActionScopes(grants: readonly StoredGrant[]): string {
  return grants
    .filter((grant) => grant.resource.type === 'composite' && grant.resource.id === FQC)
    .flatMap((grant) =>
      grant.actions.map((entry) => {
        const keys = Object.keys(entry.policy?.scopes ?? {});
        return `${entry.action}[${keys.join(',')}]`;
      }),
    )
    .join('; ');
}

/**
 * 设计点名的改动①：把 `fqcTickets` 从已有投递权限集的 scopes 里删掉。
 *
 * 「投递」声明已收掉工单表的建，带着这个键的整条授权会被框架跳过、投递直接被拒。
 * 只删这一个键；同一个动作的其他范围、同一权限集的其他动作、其他权限集一个字节不碰。
 * 对着当前声明核对改后的授权，写带版本号、冲突不写、幂等。
 */
export async function upgradeIntakeScopes(
  authz: UpgradeAuthorization,
  logger: UpgradeLogger,
): Promise<ScopeUpgradeReport> {
  logger.info('[r003-intake] === intake scopes ===');
  const sets = await authz.permissionSets.list();
  const scanned: string[] = [];
  const changed: string[] = [];
  const unchanged: string[] = [];
  const invalid: string[] = [];

  for (const set of sets) {
    const grants = structuredClone(set.grants) as unknown as StoredGrant[];
    const before = describeActionScopes(grants);
    let touched = false;
    const problems: string[] = [];
    for (const grant of grants) {
      if (grant.resource.type !== 'composite' || grant.resource.id !== FQC) {
        continue;
      }
      for (const action of grant.actions) {
        if (
          action.action !== 'intake' ||
          action.policy?.type !== 'composite' ||
          action.policy.scopes === undefined ||
          !Object.hasOwn(action.policy.scopes, 'fqcTickets')
        ) {
          continue;
        }
        const candidate: StoredGrant = {
          resource: grant.resource,
          actions: [{ action: action.action, policy: action.policy }],
        };
        // 这个键本来就是失效的：先删，再对当前声明核对剩下的范围。若拿它当
        // 「声明对不上」去跳过，升级就永远修不了它自己要修的旧环境。
        delete action.policy.scopes.fqcTickets;
        scanned.push(set.key);
        const problem = validateFqcGrant(authz, candidate);
        // 框架 validateGrant 的任何报错都阻断：不能靠关键字白名单放行
        // 「Unknown data scope」「Invalid value for data scope」这类结果。
        if (problem !== undefined) {
          problems.push(problem);
        }
        touched = true;
      }
    }
    if (!touched) {
      continue;
    }
    if (problems.length > 0) {
      for (const problem of problems) {
        logger.info(
          `[r003-intake] ${set.key}: declaration mismatch: ${problem}; nothing written`,
        );
      }
      invalid.push(set.key);
      continue;
    }
    logger.info(`[r003-intake] ${set.key} before: ${before}`);
    await updateSetWithRevision(
      authz,
      set.key,
      set,
      grants as unknown as CreatePermissionSetInput['grants'],
      logger,
    );
    const saved = await authz.permissionSets.get(set.key);
    logger.info(
      `[r003-intake] ${set.key} after: ${describeActionScopes(
        structuredClone(saved?.grants ?? []) as unknown as StoredGrant[],
      )}`,
    );
    changed.push(set.key);
  }

  logger.info(
    `[r003-intake] changed: ${changed.join(',') || '(none)'}; ` +
      `invalid: ${invalid.join(',') || '(none)'}`,
  );
  return { scanned, changed, unchanged, invalid };
}

/**
 * 设计点名的改动②：部门主管的「查看」收成只配工单表「本部门及下级」。
 *
 * 只动 `dept_manager` 的 `fqc.view` 那一个动作的范围键；其他动作、其他角色不动。
 * 已经是目标形状就不写；对着声明核对，写带版本号、冲突不写。
 */
export async function upgradeDeptManagerView(
  authz: UpgradeAuthorization,
  logger: UpgradeLogger,
): Promise<ScopeUpgradeReport> {
  logger.info('[r003-view] === department manager view ===');
  const set = (await authz.permissionSets.list()).find(
    (entry) => entry.key === DEPT_MANAGER,
  );
  if (!set) {
    logger.info(`[r003-view] ${DEPT_MANAGER}: not found; skipped`);
    return { scanned: [], changed: [], unchanged: [], invalid: [] };
  }
  const grants = structuredClone(set.grants) as unknown as StoredGrant[];
  logger.info(
    `[r003-view] ${DEPT_MANAGER} before: ${describeActionScopes(grants)}`,
  );
  // 每条 fqc 授权上的每个 view 动作都要收窄：框架允许同一角色有多条同动作
  // 授权，只改第一条会让剩下的宽授权继续读到全公司消息正文。
  const targets: { grant: StoredGrant; action: StoredGrantAction }[] = [];
  for (const grant of grants) {
    if (grant.resource.type !== 'composite' || grant.resource.id !== FQC) {
      continue;
    }
    for (const action of grant.actions) {
      if (action.action === 'view') {
        targets.push({ grant, action });
      }
    }
  }
  const invalidShape = targets.some(
    ({ action }) =>
      action.policy?.type !== 'composite' || action.policy.scopes === undefined,
  );
  if (targets.length === 0 || invalidShape) {
    // 有任何一条不是带范围的复合策略就整份拒绝：宁可不写，也不能部分收窄后
    // 报 changed，让管理员误以为已经收紧。
    logger.info(
      `[r003-view] ${DEPT_MANAGER}: declaration mismatch: ${
        targets.length === 0
          ? 'no composite view scope to narrow'
          : 'a view action is not a composite scoped policy'
      }; nothing written`,
    );
    return {
      scanned: [DEPT_MANAGER],
      changed: [],
      unchanged: [],
      invalid: [DEPT_MANAGER],
    };
  }
  const alreadyNarrow = targets.every(
    ({ action }) =>
      JSON.stringify(action.policy!.scopes) === JSON.stringify(DEPT_VIEW_SCOPES),
  );
  if (alreadyNarrow) {
    logger.info(
      `[r003-view] ${DEPT_MANAGER}: already narrowed to the ticket table; nothing written`,
    );
    return {
      scanned: [DEPT_MANAGER],
      changed: [],
      unchanged: [DEPT_MANAGER],
      invalid: [],
    };
  }
  const problems: string[] = [];
  for (const { grant, action } of targets) {
    action.policy!.scopes = { ...DEPT_VIEW_SCOPES };
    const problem = validateFqcGrant(authz, {
      resource: grant.resource,
      actions: [action],
    });
    if (problem !== undefined) {
      problems.push(problem);
    }
  }
  if (problems.length > 0) {
    for (const problem of problems) {
      logger.info(
        `[r003-view] ${DEPT_MANAGER}: declaration mismatch: ${problem}; nothing written`,
      );
    }
    return {
      scanned: [DEPT_MANAGER],
      changed: [],
      unchanged: [],
      invalid: [DEPT_MANAGER],
    };
  }
  await updateSetWithRevision(
    authz,
    DEPT_MANAGER,
    set,
    grants as unknown as CreatePermissionSetInput['grants'],
    logger,
  );
  const saved = await authz.permissionSets.get(DEPT_MANAGER);
  logger.info(
    `[r003-view] ${DEPT_MANAGER} after: ${describeActionScopes(
      structuredClone(saved?.grants ?? []) as unknown as StoredGrant[],
    )}`,
  );
  return {
    scanned: [DEPT_MANAGER],
    changed: [DEPT_MANAGER],
    unchanged: [],
    invalid: [],
  };
}

export interface R003UpgradeReport {
  readonly grants: GrantUpgradeReport;
  readonly handleRouting: GrantUpgradeReport;
  readonly intakeScopes: ScopeUpgradeReport;
  readonly deptManagerView: ScopeUpgradeReport;
}

/**
 * 只做加法：设计动作表写明「处理」读派单规则（派单时取责任部门）。新环境 seed
 * 已配，旧环境没有；给两个质量角色的 handle 各补一条只含派单规则范围的授权，
 * 已有的 handle 授权逐条原样留着，别的键不动。带版本号、幂等、冲突不写。
 */
export async function upgradeHandleRouting(
  authz: UpgradeAuthorization,
  logger: UpgradeLogger,
): Promise<GrantUpgradeReport> {
  logger.info('[r003-handle] === handle routing scope ===');
  const sets = await authz.permissionSets.list();
  const needed = fqcGrant('handle', CONFIGURE_SCOPES);
  const problem = validateFqcGrant(authz, needed);
  if (problem !== undefined) {
    logger.info(`[r003-handle]: declaration mismatch: ${problem}; nothing written`);
    return {
      targets: [...TARGET_ROLES],
      changed: [],
      unchanged: [],
      missing: [],
      invalid: [...TARGET_ROLES],
    };
  }
  const changed: string[] = [];
  const unchanged: string[] = [];
  const missing: string[] = [];
  for (const key of TARGET_ROLES) {
    const set = sets.find((entry) => entry.key === key);
    if (!set) {
      missing.push(key);
      logger.info(`[r003-handle] ${key}: not found; skipped`);
      continue;
    }
    const before = structuredClone(set.grants) as unknown as StoredGrant[];
    logger.info(`[r003-handle] ${key} before: ${describeR003Grants(before)}`);
    const hasRouting = before.some((grant) => {
      if (grant.resource.type !== 'composite' || grant.resource.id !== FQC) {
        return false;
      }
      return grant.actions.some(
        (entry) =>
          entry.action === 'handle' &&
          entry.policy?.type === 'composite' &&
          entry.policy.scopes !== undefined &&
          Object.hasOwn(entry.policy.scopes, 'fqcRoutingRules') &&
          authz.compositeResources.validateGrant({
            resource: grant.resource,
            action: entry.action,
            policy: entry.policy,
          }) === undefined,
      );
    });
    if (hasRouting) {
      unchanged.push(key);
      logger.info(`[r003-handle] ${key}: already has the routing scope; nothing written`);
      continue;
    }
    const grants = structuredClone(set.grants) as unknown as StoredGrant[];
    grants.push(needed);
    await updateSetWithRevision(
      authz,
      key,
      set,
      grants as unknown as CreatePermissionSetInput['grants'],
      logger,
    );
    const saved = await authz.permissionSets.get(key);
    logger.info(
      `[r003-handle] ${key} after: ${describeR003Grants(
        structuredClone(saved?.grants ?? []) as unknown as StoredGrant[],
      )}`,
    );
    changed.push(key);
  }
  logger.info(`[r003-handle] added: ${changed.join(',') || '(none)'}`);
  return { targets: [...TARGET_ROLES], changed, unchanged, missing, invalid: [] };
}

/** `authz upgrade-r003` 的完整步骤：先加新授权，再做设计点名的两处收窄。 */
export async function upgradeR003(
  authz: UpgradeAuthorization,
  logger: UpgradeLogger,
): Promise<R003UpgradeReport> {
  const grants = await upgradeR003Grants(authz, logger);
  const handleRouting = await upgradeHandleRouting(authz, logger);
  const intakeScopes = await upgradeIntakeScopes(authz, logger);
  const deptManagerView = await upgradeDeptManagerView(authz, logger);
  return { grants, handleRouting, intakeScopes, deptManagerView };
}

export default class AuthzUpgradeR003 extends AppCommand {
  static summary =
    'Bring existing environments up to date with R-003: new grants, intake scopes and the department manager view.';

  static description =
    'For quality_manager and quality_inspector only. Adds fqc.ticket (fqcTickets allRecords); quality_manager also gets fqc.configure (fqcRoutingRules allRecords), each as its own grant. Grants that are already effective are left exactly as they are — a conditional grant that cannot expand does not count as already granted. Nothing is added to the existing view/handle grant, and no other role is touched. Idempotent: a second run writes nothing and leaves revisions alone. Writes carry the revision that was read: if someone edits a role in the meantime the command exits with a conflict rather than overwriting that edit; rerun after reloading. Roles are written one by one without a cross-role transaction, so a failed run can be rerun to finish. It also adds fqc.handle with fqcRoutingRules allRecords to the two quality roles (new environments get it from the seed). Then it performs the two design-named narrow edits: remove fqcTickets from existing intake permission sets (otherwise the whole grant is skipped and intake is denied), and narrow the department manager view to fqcTickets org.myDepartmentsAndBelow only. Each edit touches only the named set, action and key, validates against the current declaration, logs before and after, writes with the revision read, and is idempotent.';

  static examples = ['<%= config.bin %> <%= command.id %>'];

  async run(): Promise<R003UpgradeReport> {
    // 和 export/import 一样先解析：oclif 的 _run() 收尾看到 parsed 为空会发 UnparsedCommand 告警。
    await this.parse(AuthzUpgradeR003);
    return this.withApp(async ({ app }) => {
      await app.start();
      // 命令树在 --help 时也会全部导入，重的东西留到真正执行时再加载。
      const { authorizationToken } =
        await import('@nocobase/app-plugin-authorization/server');
      const authz = app.container.resolve(
        authorizationToken,
      ) as unknown as UpgradeAuthorization;
      return upgradeR003(authz, {
        info: (message) => this.log(message),
      });
    });
  }
}
