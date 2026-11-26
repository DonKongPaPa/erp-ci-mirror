import type { AppAuthorization } from '@nocobase/app-plugin-authorization';
import { AppCommand } from '@nocobase/app-cli';
import {
  PermissionSetConflictError,
  type CreatePermissionSetInput,
} from '@nocobase/authorization/permission-sets';

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
 * 同一条命令还补知识库（R-002 的另一半）：给这两个角色加上 seed 对新环境给的
 * `knowledge` 页面，以及 `{ type: 'kb', id: 'kb.knowledge' }` 的档位 —— 质量主管
 * `manage.related`、质量员 `propose.related`。只加缺失的那两样，已有授权与别的角色
 * 一律不动；形状的写法与 `database/main/seeds/202611240001_seed_business_permission_sets.ts`
 * 一致。已初始化的环境 seed 会跳过已有角色，所以侧栏没有知识库入口、页面也进不去。
 *
 * 为什么是命令而不是迁移或 seed：迁移只能跑一次、seed 明确不动已有的角色；这条
 * 命令可以单独跑、可以单独重跑，管理员在已有环境里跑它就能把状态补上。漏跑不致命，
 * 只是两个质量角色确认时被拒（403）、看不到知识库，补跑即恢复。
 */
const REVIEW_TABLE = 'fqcScreeningReviews';
const ALL_RECORDS = 'allRecords';
/** 只补这两个角色：其余角色按「没配就是拒绝」。 */
const TARGET_ROLES = ['quality_manager', 'quality_inspector'] as const;
type TargetRole = (typeof TARGET_ROLES)[number];

const KNOWLEDGE_PAGE = { type: 'page', id: 'knowledge' } as const;
const KNOWLEDGE_RESOURCE = { type: 'kb', id: 'kb.knowledge' } as const;
/** 与 seed 一致：质量主管管、质量员提案，都用 `.related` 不用 `.all`。 */
const KNOWLEDGE_ACTIONS: Readonly<Record<TargetRole, string>> = {
  quality_manager: 'manage.related',
  quality_inspector: 'propose.related',
};

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

interface StoredPermissionSetLike {
  readonly revision?: string;
  readonly title?: CreatePermissionSetInput['title'];
  readonly grants: CreatePermissionSetInput['grants'];
}

/**
 * 写权限集时带上读到的版本号。框架 `permissionSets.update(key, input, expectedRevision)`
 * 在版本不匹配时抛 `PermissionSetConflictError`，整份 grants 不会被覆盖 —— 管理员同时在
 * 角色编辑器里保存时，命令报错退出、重跑即可，不静默吞掉别人的改动。
 */
async function updateSetWithRevision(
  authz: UpgradeAuthorization,
  key: string,
  set: StoredPermissionSetLike,
  grants: CreatePermissionSetInput['grants'],
  tag: string,
  logger: ReviewScopeUpgradeLogger,
): Promise<void> {
  if (set.revision === undefined) {
    logger.info(
      `[${tag}] ${key}: no revision on the stored set; refusing to overwrite a concurrent edit; nothing written`,
    );
    throw new Error(`[${tag}] ${key}: permission set has no revision; reload and rerun`);
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
        ? `[${tag}] ${key}: revision changed since it was read; nothing written; reload and rerun`
        : `[${tag}] ${key}: update failed; nothing written; reload and rerun`,
    );
    throw error;
  }
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

    await updateSetWithRevision(
      authz,
      key,
      set,
      grants as unknown as CreatePermissionSetInput['grants'],
      'r002-review-scope',
      logger,
    );
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

interface KnowledgeActionLike {
  action: string;
  [key: string]: unknown;
}

interface KnowledgeGrantLike {
  resource: { type: string; id: string };
  actions: KnowledgeActionLike[];
  [key: string]: unknown;
}

/** 把知识库页面与档位压成一行，给改前改后的日志用。 */
function describeKnowledgeGrants(grants: readonly KnowledgeGrantLike[]): string {
  return grants
    .filter(
      (grant) =>
        (grant.resource.type === KNOWLEDGE_PAGE.type &&
          grant.resource.id === KNOWLEDGE_PAGE.id) ||
        (grant.resource.type === KNOWLEDGE_RESOURCE.type &&
          grant.resource.id === KNOWLEDGE_RESOURCE.id),
    )
    .flatMap((grant) =>
      grant.actions.map((action) => `${grant.resource.id}/${action.action}`),
    )
    .join('; ');
}

export interface KnowledgeAccessUpgradeReport {
  readonly targets: readonly string[];
  readonly changed: readonly string[];
  readonly unchanged: readonly string[];
  readonly missing: readonly string[];
}

/**
 * 给两个质量角色补上知识库页面与档位，形状照 seed 对新环境给的写法。
 *
 * 只补缺的那两样：页面授权必须有「不带 policy 的 access」才算已有，kb 档位也必须有
 * 「不带 policy 的同动作」才算已有 —— 框架 `grantBacked` 会过滤带条件的授权，只看动作名
 * 会报「已补」却什么都放不开。缺的就补一条干净的，已有的授权与别的键原样保留；两样都齐了
 * 就不写库（版本号不动）。两次写入都带读到的 revision，冲突时报错退出、不覆盖别人的改动。
 * 日志逐角色写「改前 / 改后 / 已经有 / 不存在」。
 */
export async function upgradeR002KnowledgeAccess(
  authz: UpgradeAuthorization,
  logger: ReviewScopeUpgradeLogger,
): Promise<KnowledgeAccessUpgradeReport> {
  const sets = await authz.permissionSets.list();
  const changed: string[] = [];
  const unchanged: string[] = [];
  const missing: string[] = [];

  for (const key of TARGET_ROLES) {
    const set = sets.find((entry) => entry.key === key);
    if (!set) {
      missing.push(key);
      logger.info(`[r002-knowledge] ${key}: not found; skipped`);
      continue;
    }
    const before = structuredClone(set.grants) as unknown as KnowledgeGrantLike[];
    logger.info(
      `[r002-knowledge] ${key} before: ${describeKnowledgeGrants(before)}`,
    );

    const grants = structuredClone(set.grants) as unknown as KnowledgeGrantLike[];
    let touched = false;
    // 页面授权：框架只认不带 policy 的那条（`grantBacked` 过滤带条件的）。旧环境里
    // 只有带条件的 access 时，光看动作名会误判成「已有」，角色还是打不开页面（PR #114）。
    const hasUnconditionalPageAccess = grants.some(
      (grant) =>
        grant.resource.type === KNOWLEDGE_PAGE.type &&
        grant.resource.id === KNOWLEDGE_PAGE.id &&
        grant.actions.some(
          (entry) => entry.action === 'access' && entry.policy === undefined,
        ),
    );
    if (!hasUnconditionalPageAccess) {
      grants.push({
        resource: { ...KNOWLEDGE_PAGE },
        actions: [{ action: 'access' }],
      });
      touched = true;
    }

    // kb 档位与页面同理：只有「不带 policy 的同动作」才算已有。框架
    // `grantBacked` 过滤带条件的 grant，只看动作名会报「已补」却什么都放不开。
    const action = KNOWLEDGE_ACTIONS[key];
    const hasUnconditionalKbAction = grants.some(
      (grant) =>
        grant.resource.type === KNOWLEDGE_RESOURCE.type &&
        grant.resource.id === KNOWLEDGE_RESOURCE.id &&
        grant.actions.some(
          (entry) => entry.action === action && entry.policy === undefined,
        ),
    );
    if (!hasUnconditionalKbAction) {
      grants.push({
        resource: { ...KNOWLEDGE_RESOURCE },
        actions: [{ action }],
      });
      touched = true;
    }

    if (!touched) {
      unchanged.push(key);
      logger.info(
        `[r002-knowledge] ${key}: already has the knowledge page and ${KNOWLEDGE_ACTIONS[key]}; nothing written`,
      );
      continue;
    }

    await updateSetWithRevision(
      authz,
      key,
      set,
      grants as unknown as CreatePermissionSetInput['grants'],
      'r002-knowledge',
      logger,
    );
    const saved = await authz.permissionSets.get(key);
    logger.info(
      `[r002-knowledge] ${key} after: ${describeKnowledgeGrants(
        structuredClone(saved?.grants ?? []) as unknown as KnowledgeGrantLike[],
      )}`,
    );
    changed.push(key);
  }

  logger.info(
    `[r002-knowledge] changed: ${changed.join(',') || '(none)'}; ` +
      `already current: ${unchanged.join(',') || '(none)'}; ` +
      `missing: ${missing.join(',') || '(none)'}`,
  );
  return { targets: [...TARGET_ROLES], changed, unchanged, missing };
}

export interface R002UpgradeReport {
  readonly reviewScope: ReviewScopeUpgradeReport;
  readonly knowledgeAccess: KnowledgeAccessUpgradeReport;
}

/** `authz upgrade-r002` 的完整步骤：先补确认记录的范围，再补知识库页面与档位。 */
export async function upgradeR002(
  authz: UpgradeAuthorization,
  logger: ReviewScopeUpgradeLogger,
): Promise<R002UpgradeReport> {
  const reviewScope = await upgradeR002ReviewScope(authz, logger);
  const knowledgeAccess = await upgradeR002KnowledgeAccess(authz, logger);
  return { reviewScope, knowledgeAccess };
}

export default class AuthzUpgradeR002 extends AppCommand {
  static summary =
    'Bring the two quality roles up to date with R-002: confirmation-record scope and knowledge access.';

  static description =
    'Does two things for quality_manager and quality_inspector only. (1) Adds fqcScreeningReviews: allRecords to their fqc grants: the confirmation-record table has no default scope, so a grant that does not name it is denied, which keeps department managers from reading the quality staff’s decisions. (2) Adds an unconditional knowledge page access and an unconditional kb.knowledge grant — manage.related for the manager, propose.related for the inspector — that the seed gives new environments, because the seed skips roles that already exist. A conditional grant is filtered out by the framework and does not count as already granted. An environment initialized before R-002 needs this command once; until it runs those two roles get 403 on confirmation and cannot open the knowledge page. It is idempotent: a second run writes nothing and leaves revisions alone. Writes carry the revision that was read: if someone edits a role in the meantime the command exits with a conflict rather than overwriting that edit; rerun after reloading. It logs each role before and after, and it never touches other roles or other grant keys. It does not grant read.related to the delivery service account: where the WeChat adapter is installed, an administrator must give that service account read.related on { type: "kb", id: "kb.knowledge" } at go-live; without it automatic intake succeeds but never uses knowledge.';

  static examples = ['<%= config.bin %> <%= command.id %>'];

  async run(): Promise<R002UpgradeReport> {
    // 和 export/import 一样先解析：oclif 的 _run() 收尾看到 parsed 为空会发 UnparsedCommand 告警。
    await this.parse(AuthzUpgradeR002);
    return this.withApp(async ({ app }) => {
      await app.start();
      // 命令树在 --help 时也会全部导入，重的东西留到真正执行时再加载。
      const { authorizationToken } =
        await import('@nocobase/app-plugin-authorization/server');
      const authz = app.container.resolve(
        authorizationToken,
      ) as unknown as UpgradeAuthorization;
      return upgradeR002(authz, {
        info: (message) => this.log(message),
      });
    });
  }
}
