import type { AppAuthorization } from '@nocobase/app-plugin-authorization';
import { AppCommand, CommandError } from '@nocobase/app-cli';
import { isUniqueConstraintViolation, type DatabaseConnection } from '@nocobase/db';
import {
  PermissionSetConflictError,
  type CreatePermissionSetInput,
} from '@nocobase/authorization/permission-sets';

/**
 * R-026 的升级步骤：`pnpm nocobase authz upgrade-r026`。
 *
 * seed 只对新建的环境生效，已初始化的环境里三个角色拿不到反馈单页与两个新动作，
 * 存量的人也没有 `staff`（框架建人默认带的是 `member`）。这条命令把这几样补上：
 *
 * - 普通员工（`staff`）：反馈单页、`submit`；
 * - 质量主管、质量员：反馈单页、`submit`、`maintain`；
 * - 只给还没有的人补 `staff`，服务账号除外；
 * - 只加不改，已有的授权逐条原样留着，绝不往「查看、处理」那条里加动作；
 * - 已有就跳过，改前改后各记一行，找不到角色记一行；
 * - 幂等：第二次什么都不写，权限集的版本号也不变；
 * - 逐角色写，没有跨角色事务：中途失败重跑可补。
 *
 * 写之前按 `fqc` 的当前声明核对动作与数据范围；页面 id 放进共享常量，由守门测试
 * 钉住它与 seed 写的页面授权是同一个。写入带读到的 `set.revision` 作 `expectedRevision`：
 * 读到之后有人改过角色就什么都不写、报错退出，日志写明读后被改过、重载重跑。
 */
/** 反馈单页的页面 id：seed、命令与路由各引用一次，守门测试钉住三处一致。 */
export const FEEDBACK_PAGE_ID = 'feedback';

const FQC = 'fqc';
const STAFF = 'staff';
const TARGET_ROLES = ['staff', 'quality_manager', 'quality_inspector'] as const;
const MAINTAIN_ROLES = ['quality_manager', 'quality_inspector'] as const;

/** 与 seed 的 `submitFqcScopes`、`maintainFqcScopes` 逐键逐值一致。 */
const SUBMIT_SCOPES = {
  fqcMessages: 'recordsIOwn',
  fqcScreenings: 'recordsIOwn',
} as const;
const MAINTAIN_SCOPES = {
  fqcMessages: 'allRecords',
  fqcScreenings: 'allRecords',
  fqcTickets: 'allRecords',
} as const;

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

export interface StaffFailure {
  readonly userId: string;
  readonly reason: string;
}

export interface StaffUpgradeReport {
  readonly assigned: readonly string[];
  readonly already: readonly string[];
  readonly failed: readonly StaffFailure[];
}

export interface R026UpgradeReport {
  readonly grants: GrantUpgradeReport;
  readonly staff: StaffUpgradeReport;
}

export interface R026UpgradeServices {
  readonly authorization: Pick<
    AppAuthorization,
    'permissionSets' | 'compositeResources' | 'pages'
  >;
  readonly connection: DatabaseConnection;
}

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

/** 造一条带数据范围的业务动作授权，形状与 seed 的 `fqcGrant` 一致。 */
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
 * 声明给的选项里，整条授权还得能被服务层展开。对不上就返回原因，不写库 ——
 * 硬塞一个没声明的键，启动扫描/展开会把整条授权拒掉（R-002 查错踩过）。
 */
function validateFqcGrant(
  authz: R026UpgradeServices['authorization'],
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
 * 「已有」的判据：页面授权必须是不带 policy 的 `access` —— 框架 `grantBacked`
 * 过滤带条件的授权，只看动作名会报「已补」却什么都放不开；业务动作也不能只看
 * 动作名，带条件（不能展开）的那条同样不算。能展开的 `composite` 授权才算已有，
 * 这正是 seed 对新环境写的形状。
 */
function hasUnconditionalPageAccess(
  grants: readonly StoredGrant[],
  id: string,
): boolean {
  return grants.some(
    (grant) =>
      grant.resource.type === 'page' &&
      grant.resource.id === id &&
      grant.actions.some(
        (entry) => entry.action === 'access' && entry.policy === undefined,
      ),
  );
}

function hasEffectiveFqcAction(
  authz: R026UpgradeServices['authorization'],
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

/**
 * 写权限集时带上读到的版本号。框架 `permissionSets.update(key, input, expectedRevision)`
 * 在版本不匹配时抛 `PermissionSetConflictError`，整份 grants 不会被覆盖 —— 管理员同时
 * 在角色编辑器里保存时，命令报错退出、重跑即可，不静默吞掉别人的改动。
 */
async function updateSetWithRevision(
  authz: R026UpgradeServices['authorization'],
  key: string,
  set: StoredSet,
  grants: CreatePermissionSetInput['grants'],
  logger: UpgradeLogger,
): Promise<void> {
  if (set.revision === undefined) {
    logger.info(
      `[r026] ${key}: no revision on the stored set; refusing to overwrite a concurrent edit; nothing written`,
    );
    throw new Error(`[r026] ${key}: permission set has no revision; reload and rerun`);
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
        ? `[r026] ${key}: 读后被改过（revision changed since it was read）; nothing written; 重载重跑（reload and rerun）`
        : `[r026] ${key}: update failed; nothing written; reload and rerun`,
    );
    throw error;
  }
}

/** 把反馈单页与两个新动作压成一行，给改前改后的日志用。 */
function describeR026Grants(grants: readonly StoredGrant[]): string {
  return grants
    .filter(
      (grant) =>
        (grant.resource.type === 'page' &&
          grant.resource.id === FEEDBACK_PAGE_ID) ||
        (grant.resource.type === 'composite' && grant.resource.id === FQC),
    )
    .flatMap((grant) =>
      grant.actions.map((entry) => {
        const keys = Object.keys(entry.policy?.scopes ?? {});
        return `${grant.resource.id}/${entry.action}${keys.length ? `[${keys.join(',')}]` : ''}`;
      }),
    )
    .join('; ');
}

async function upgradeGrants(
  services: R026UpgradeServices,
  logger: UpgradeLogger,
): Promise<GrantUpgradeReport> {
  const { authorization: authz } = services;
  logger.info('[r026] === role grants ===');
  const sets = await authz.permissionSets.list();
  const changed: string[] = [];
  const unchanged: string[] = [];
  const missing: string[] = [];
  const invalid: string[] = [];

  for (const key of TARGET_ROLES) {
    const set = sets.find((entry) => entry.key === key);
    if (!set) {
      missing.push(key);
      logger.info(`[r026] ${key}: not found; skipped`);
      continue;
    }
    const before = structuredClone(set.grants) as unknown as StoredGrant[];
    logger.info(`[r026] ${key} before: ${describeR026Grants(before)}`);

    // 页面授权用框架现成的函数造，动作授权按 seed 的形状造；两样都先验声明，
    // 有任何一样对不上就整个角色不加、逐条报出来。
    const pageGrant = authz.pages.grant(FEEDBACK_PAGE_ID);
    const submitGrant = fqcGrant('submit', SUBMIT_SCOPES);
    const needed = [submitGrant];
    if ((MAINTAIN_ROLES as readonly string[]).includes(key)) {
      needed.push(fqcGrant('maintain', MAINTAIN_SCOPES));
    }
    const problems = needed
      .map((grant) => validateFqcGrant(authz, grant))
      .filter((problem): problem is string => problem !== undefined);
    if (problems.length > 0) {
      for (const problem of problems) {
        logger.info(`[r026] ${key}: declaration mismatch: ${problem}; nothing written`);
      }
      invalid.push(key);
      continue;
    }

    const grants = structuredClone(set.grants) as unknown as StoredGrant[];
    let touched = false;
    if (!hasUnconditionalPageAccess(grants, FEEDBACK_PAGE_ID)) {
      grants.push(pageGrant as unknown as StoredGrant);
      touched = true;
    }
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
        `[r026] ${key}: already has the feedback page and the new actions; nothing written`,
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
      `[r026] ${key} after: ${describeR026Grants(
        structuredClone(saved?.grants ?? []) as unknown as StoredGrant[],
      )}`,
    );
    changed.push(key);
  }

  logger.info(`[r026] added: ${changed.join(',') || '(none)'}`);
  logger.info(
    `[r026] skipped (already current): ${unchanged.join(',') || '(none)'}; ` +
      `missing: ${missing.join(',') || '(none)'}; ` +
      `invalid: ${invalid.join(',') || '(none)'}`,
  );
  return { targets: [...TARGET_ROLES], changed, unchanged, missing, invalid };
}

/**
 * 存量的人补 `staff`：框架建人时默认只带 `member`，服务账号只经 API key 起作用，
 * 不给它业务角色。走框架的 `app` 角色范围接口（读取当前角色再追加），已有的不重复，
 * 每页读一批直到读全；指派按用户逐个做，中途失败重跑可补。
 */
async function upgradeStaffAssignments(
  services: R026UpgradeServices,
  logger: UpgradeLogger,
): Promise<StaffUpgradeReport> {
  logger.info('[r026-staff] === staff assignments ===');
  const sets = services.authorization.permissionSets;
  if (!(await sets.get(STAFF))) {
    logger.info(`[r026-staff]: ${STAFF} permission set not found; nothing assigned`);
    return { assigned: [], already: [], failed: [] };
  }

  // 键集分页：按 id 升序，每次取一页，下一页从上一页最后一条之后开始。
  // 不用 offset —— 遍历期间有人建号时 offset 会漏行。软删的账号与服务账号都不补
  // （服务账号只经 API key 起作用，判定字段是 `kind`）。
  const pageSize = 100;
  let afterId: string | undefined;
  // 赋值键是 `user:<id>:staff`（框架的 createAssignmentId）。先查重再插：
  // `assign` 是插入，不是 upsert，同一个键插第二遍会撞唯一约束。
  const existing = new Set(
    (await sets.listAssignments(STAFF)).map((assignment) => assignment.id),
  );
  const assigned: string[] = [];
  const already: string[] = [];
  const failed: StaffFailure[] = [];
  for (;;) {
    let page = services.connection.query
      .selectFrom('user')
      .select(['id'])
      .where('deletedAt', 'is', null)
      .where('kind', '<>', 'service')
      .orderBy('id', 'asc')
      .limit(pageSize);
    if (afterId !== undefined) {
      page = page.where('id', '>', afterId);
    }
    const rows = (await page.execute()) as unknown as { id: unknown }[];
    if (rows.length === 0) {
      break;
    }
    for (const row of rows) {
      const userId = String(row.id);
      afterId = userId;
      const key = `user:${userId}:${STAFF}`;
      if (existing.has(key)) {
        already.push(userId);
        logger.info(`[r026-staff] ${userId}: already has ${STAFF}; skipped`);
        continue;
      }
      try {
        await sets.assign({
          subject: { type: 'user', id: userId },
          permissionSet: STAFF,
        });
        existing.add(key);
        assigned.push(userId);
        logger.info(`[r026-staff] ${userId}: assigned ${STAFF}`);
      } catch (error) {
        if (isUniqueConstraintViolation(error)) {
          // 建人初始化器可能刚插过同一条赋值。重新查一次：已经在就按
          // 「已有、跳过」处理，不算失败。
          const raced = (await sets.listAssignments(STAFF)).some(
            (assignment) => assignment.id === key,
          );
          if (raced) {
            existing.add(key);
            already.push(userId);
            logger.info(
              `[r026-staff] ${userId}: ${STAFF} was assigned concurrently; skipped`,
            );
            continue;
          }
        }
        // 单个账号失败不挡后面的账号，日志点名账号与原因，末尾汇总。
        const reason = error instanceof Error ? error.message : String(error);
        failed.push({ userId, reason });
        logger.info(
          `[r026-staff] ${userId}: FAILED to assign ${STAFF}: ${reason}`,
        );
      }
    }
    if (rows.length < pageSize) {
      break;
    }
  }

  logger.info(
    `[r026-staff] assigned ${assigned.length}: ${assigned.join(',') || '(none)'}`,
  );
  logger.info(
    `[r026-staff] skipped (already had staff) ${already.length}: ${already.join(',') || '(none)'}`,
  );
  logger.info(
    `[r026-staff] failed ${failed.length}: ` +
      (failed.map((entry) => `${entry.userId} (${entry.reason})`).join('; ') ||
        '(none)'),
  );
  logger.info(
    '[r026-staff] service accounts and deleted accounts were not considered',
  );
  return { assigned, already, failed };
}

/** 有账号没补上时让命令非零退出：授权那部分已经生效，重跑补齐即可。 */
export function assertStaffAssignmentsSucceeded(
  report: R026UpgradeReport,
): void {
  if (report.staff.failed.length === 0) {
    return;
  }
  throw new CommandError(
    `R-026: ${report.staff.failed.length} staff assignment(s) failed; see the [r026-staff] failed line above. Reload and rerun.`,
    {
      code: 'R026_STAFF_ASSIGNMENT_FAILED',
      suggestions: ['Reload and rerun pnpm nocobase authz upgrade-r026'],
      details: { failed: report.staff.failed },
    },
  );
}

/**
 * 加法只要有一条没做成就非零退出。判据是报告里的 `missing`（角色不存在）与 `invalid`
 * （声明对不上）；`unchanged`（本来就已经有了）不算失败。报告在 `upgradeR026` 里已经
 * 打印完，staff 指派照常进行；部署脚本按退出码判断升级是否完成，静默跳过会让它以为
 * 升级成功，而三个角色仍拿不到反馈单页与新动作。
 */
export function assertR026AdditionsSucceeded(report: R026UpgradeReport): void {
  const failed: string[] = [];
  if (report.grants.missing.length > 0) {
    failed.push(`role grants: missing ${report.grants.missing.join(', ')}`);
  }
  if (report.grants.invalid.length > 0) {
    failed.push(
      `role grants: declaration mismatch ${report.grants.invalid.join(', ')}`,
    );
  }
  if (failed.length === 0) {
    return;
  }
  throw new CommandError(
    `R-026: additive grants failed for ${failed.join(' and ')}; see the [r026] not found or declaration mismatch lines above. Fix the named roles or declarations, reload and rerun pnpm nocobase authz upgrade-r026.`,
    {
      code: 'R026_ADDITIONS_FAILED',
      suggestions: ['Reload and rerun pnpm nocobase authz upgrade-r026'],
      details: {
        missing: [...report.grants.missing],
        invalid: [...report.grants.invalid],
      },
    },
  );
}

/** `authz upgrade-r026` 的完整步骤：先补授权，再给存量的人补 `staff`。 */
export async function upgradeR026(
  services: R026UpgradeServices,
  logger: UpgradeLogger,
): Promise<R026UpgradeReport> {
  const grants = await upgradeGrants(services, logger);
  const staff = await upgradeStaffAssignments(services, logger);
  return { grants, staff };
}

export default class AuthzUpgradeR026 extends AppCommand {
  static summary =
    'Bring the three R-026 roles up to date: feedback page, submit and maintain grants, plus staff for existing people.';

  static description =
    'For staff, quality_manager and quality_inspector only. Adds the unconditional feedback page grant and fqc.submit (both tables recordsIOwn); the two quality roles also get fqc.maintain (three tables allRecords), each as its own grant. Grants that are already effective are left exactly as they are — a conditional page grant or a grant that cannot expand does not count as already granted. Nothing is added to the existing view/handle grant, and no other role is touched. Also assigns the staff permission set to every existing person who does not have it yet (service accounts are skipped); the framework gives new people member by default. Idempotent: a second run writes nothing and leaves revisions alone. Writes carry the revision that was read: if someone edits a role in the meantime the command reports that the set was changed after reading and exits without writing; reload and rerun. Roles are written one by one without a cross-role transaction, so a failed run can be rerun to finish.';

  static examples = ['<%= config.bin %> <%= command.id %>'];

  async run(): Promise<R026UpgradeReport> {
    // 和 export/import 一样先解析：oclif 的 _run() 收尾看到 parsed 为空会发 UnparsedCommand 告警。
    await this.parse(AuthzUpgradeR026);
    return this.withApp(async ({ app }) => {
      await app.start();
      // 命令树在 --help 时也会全部导入，重的东西留到真正执行时再加载。
      const { authorizationToken } =
        await import('@nocobase/app-plugin-authorization/server');
      const { databaseManagerToken } = await import('@nocobase/db');
      const services: R026UpgradeServices = {
        authorization: app.container.resolve(authorizationToken) as unknown as R026UpgradeServices['authorization'],
        connection: app.container.resolve(databaseManagerToken).connection(),
      };
      const report = await upgradeR026(services, {
        info: (message) => this.log(message),
      });
      assertR026AdditionsSucceeded(report);
      assertStaffAssignmentsSucceeded(report);
      return report;
    });
  }
}
