import type { AppAuthorization } from '@nocobase/app-plugin-authorization';
import { AppCommand } from '@nocobase/app-cli';

/**
 * R-002 的升级步骤：`pnpm nocobase authz upgrade-r002`。
 *
 * 确认记录表的范围在声明里**没有缺省**：没配就是拒绝。这是 R-003 要的收窄（部门主管
 * 不该读到质量人员确认成什么）。代价是已经初始化的环境里，存好的 `fqc` 授权没有这个
 * 数据范围的键，升级之后旧角色的确认会 403 —— 所以合并之后要跑一次这条命令：
 *
 * - 只动两个质量角色（`quality_manager` / `quality_inspector`）；
 * - 只给它们已有的 `fqc` 授权里**缺这个键的动作**补上 `fqcScreeningReviews: 'allRecords'`；
 *   别的角色、别的键、别的值一律不动；
 * - 幂等：第二次跑什么都不写，权限集的版本号也不变；
 * - 每个被改的角色改前、改后各记一行；没改的角色记一行「已经有」；角色不存在记一行。
 *
 * 为什么是命令而不是迁移或 seed：迁移只能跑一次、seed 明确不动已有的角色；这条
 * 命令可以单独跑、可以单独重跑，管理员在已有环境里跑它就能把状态补上。漏跑不致命，
 * 只是两个质量角色确认时被拒（403），补跑即恢复。
 */
const REVIEW_TABLE = 'fqcScreeningReviews';
const ALL_RECORDS = 'allRecords';
/** 只补这两个角色：其余角色按「没配就是拒绝」。 */
const TARGET_ROLES = ['quality_manager', 'quality_inspector'] as const;

export interface ReviewScopeUpgradeLogger {
  info(message: string): void;
}

export interface ReviewScopeUpgradeReport {
  /** 这条命令看过的角色。 */
  readonly targets: readonly string[];
  /** 这次补了范围的角色。 */
  readonly changed: readonly string[];
  /** 已经有这个范围（或没有可补的 fqc 授权）的角色。 */
  readonly unchanged: readonly string[];
  /** 库里没有这个角色。 */
  readonly missing: readonly string[];
}

type UpgradeAuthorization = Pick<
  AppAuthorization,
  'permissionSets' | 'compositeResources'
>;

interface FqcActionLike {
  action: string;
  policy?: { type: string; scopes?: Record<string, unknown> };
}

interface FqcGrantLike {
  resource: { type: string; id: string };
  actions: FqcActionLike[];
}

/** 把一份授权里 fqc 动作的范围压成一行，给改前改后的日志用。 */
function describeScopes(grants: readonly FqcGrantLike[]): string {
  return grants
    .filter(
      (grant) =>
        grant.resource.type === 'composite' && grant.resource.id === 'fqc',
    )
    .flatMap((grant) =>
      grant.actions.map((action) => {
        const keys = Object.keys(action.policy?.scopes ?? {});
        return `${action.action}=[${keys.join(',')}]`;
      }),
    )
    .join('; ');
}

/**
 * 只给两个质量角色的 `fqc` 授权补上确认记录表的全量范围。
 *
 * 返回值是这次看到的角色与结果；日志逐角色写「改前 / 改后 / 已经有 / 不存在」。
 * 可以直接在应用容器已启动的环境里调用（测试与 CLI 共用这一处实现）。
 */
export async function upgradeR002ReviewScope(
  authz: UpgradeAuthorization,
  logger: ReviewScopeUpgradeLogger,
): Promise<ReviewScopeUpgradeReport> {
  const sets = await authz.permissionSets.list();
  const changed: string[] = [];
  const unchanged: string[] = [];
  const missing: string[] = [];

  for (const key of TARGET_ROLES) {
    const set = sets.find((entry) => entry.key === key);
    if (!set) {
      missing.push(key);
      logger.info(`[r002-review-scope] ${key}: not found; skipped`);
      continue;
    }
    const before = structuredClone(set.grants) as unknown as FqcGrantLike[];
    logger.info(`[r002-review-scope] ${key} before: ${describeScopes(before)}`);

    let touched = false;
    const grants = structuredClone(set.grants) as unknown as FqcGrantLike[];
    for (const grant of grants) {
      if (grant.resource.type !== 'composite' || grant.resource.id !== 'fqc') {
        continue;
      }
      for (const action of grant.actions) {
        if (
          action.policy?.type !== 'composite' ||
          action.policy.scopes === undefined
        ) {
          continue;
        }
        if (Object.hasOwn(action.policy.scopes, REVIEW_TABLE)) {
          continue;
        }
        // 只补这个动作真的有的数据范围：投递的动作没有确认记录表，硬塞会被
        // 启动扫描/展开拒成「未知数据范围」。
        const definition = authz.compositeResources.getAction(
          'fqc',
          action.action,
        );
        if (
          !definition?.dataScopes?.some((scope) => scope.key === REVIEW_TABLE)
        ) {
          continue;
        }
        action.policy.scopes[REVIEW_TABLE] = ALL_RECORDS;
        touched = true;
      }
    }

    if (!touched) {
      unchanged.push(key);
      logger.info(
        `[r002-review-scope] ${key}: already has ${REVIEW_TABLE} on every action that supports it; nothing written`,
      );
      continue;
    }

    await authz.permissionSets.update(key, {
      key,
      ...(set.title === undefined ? {} : { title: set.title }),
      grants: grants as unknown as typeof set.grants,
    });
    const saved = await authz.permissionSets.get(key);
    logger.info(
      `[r002-review-scope] ${key} after: ${describeScopes(
        structuredClone(saved?.grants ?? []) as unknown as FqcGrantLike[],
      )}`,
    );
    changed.push(key);
  }

  logger.info(
    `[r002-review-scope] changed: ${changed.join(',') || '(none)'}; ` +
      `already current: ${unchanged.join(',') || '(none)'}; ` +
      `missing: ${missing.join(',') || '(none)'}`,
  );
  return { targets: [...TARGET_ROLES], changed, unchanged, missing };
}

export default class AuthzUpgradeR002 extends AppCommand {
  static summary =
    'Grant the two quality roles the R-002 confirmation-record scope.';

  static description =
    'Adds fqcScreeningReviews: allRecords to the fqc grants of quality_manager and quality_inspector only. The confirmation-record table has no default scope: a grant that does not name it is denied, which is what keeps department managers from reading the quality staff’s decisions. An environment initialized before R-002 therefore needs this command once; until it runs, those two roles get 403 on confirmation. It is idempotent: a second run writes nothing and leaves the revisions alone, and it logs every role’s scopes before and after. It does not touch other roles or other grant keys.';

  static examples = ['<%= config.bin %> <%= command.id %>'];

  async run(): Promise<ReviewScopeUpgradeReport> {
    return this.withApp(async ({ app }) => {
      await app.start();
      // 命令树在 --help 时也会全部导入，重的东西留到真正执行时再加载。
      const { authorizationToken } =
        await import('@nocobase/app-plugin-authorization/server');
      const authz = app.container.resolve(
        authorizationToken,
      ) as unknown as UpgradeAuthorization;
      return upgradeR002ReviewScope(authz, {
        info: (message) => this.log(message),
      });
    });
  }
}
