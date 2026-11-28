import type { AppAuthorization } from '@nocobase/app-plugin-authorization';
import { AppCommand } from '@nocobase/app-cli';
import {
  PermissionSetConflictError,
  type CreatePermissionSetInput,
} from '@nocobase/authorization/permission-sets';

/**
 * R-019 波 2 页面片的升级步骤：`pnpm nocobase authz upgrade-r019-bom-pages`。
 *
 * seed 只对新建环境生效；已有环境里 craft 与 planning 拿不到 BOM 页，谁也打不开。
 * 这条命令只给这两个角色各补一条页面授权 `boms`（页面授权 id 与页面一致），
 * 维护入口由 boms 业务资源动作裁定，只有管理员有，这里一行都不写。
 * 只加不改、不给其它角色加。幂等：第二次什么都不写，revision 也不变。
 * 声明对不上（boms.view 未登记）或找不到角色时这个角色整条跳过。
 * 写入带读到的 revision：读到之后有人改过角色就报错退出、重载重跑，不覆盖别人的改动。
 */
export const CRAFT_TARGET = 'craft';
export const PLANNING_TARGET = 'planning';
export const BOMS_PAGE_ID = 'boms';
const TARGETS = [CRAFT_TARGET, PLANNING_TARGET] as const;

export interface R019BomPagesUpgradeReport {
  readonly pages: {
    readonly targets: readonly string[];
    readonly changed: readonly string[];
    readonly unchanged: readonly string[];
    readonly missing: readonly string[];
    readonly invalid: readonly string[];
  };
}

export interface R019BomPagesUpgradeServices {
  readonly authorization: Pick<
    AppAuthorization,
    'permissionSets' | 'compositeResources' | 'pages'
  >;
}

interface StoredGrantAction {
  action: string;
  policy?: { type: string };
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

/** 「已有」必须是不带 policy 的 access；带条件的页面授权框架不放行，只看动作名会误判。 */
function hasPageAccess(grants: readonly StoredGrant[]): boolean {
  return grants.some(
    (grant) =>
      grant.resource.type === 'page' &&
      grant.resource.id === BOMS_PAGE_ID &&
      grant.actions.some(
        (entry) => entry.action === 'access' && entry.policy === undefined,
      ),
  );
}

export async function upgradeR019BomPages(
  services: R019BomPagesUpgradeServices,
  logger: { info(message: string): void },
): Promise<R019BomPagesUpgradeReport> {
  const { authorization: authz } = services;
  const changed: string[] = [];
  const unchanged: string[] = [];
  const missing: string[] = [];
  const invalid: string[] = [];
  logger.info('[r019-bom-pages] === page grants ===');

  // 页面授权要落在 BOM 业务资源上；声明对不上就整条跳过，不写半个角色。
  if (!authz.compositeResources.getAction('boms', 'view')) {
    logger.info(
      '[r019-bom-pages] boms.view is not declared; skipping both targets',
    );
    return {
      pages: { targets: [...TARGETS], changed, unchanged, missing, invalid: [...TARGETS] },
    };
  }

  const sets = await authz.permissionSets.list();
  for (const key of TARGETS) {
    const set = sets.find((entry) => entry.key === key) as StoredSet | undefined;
    if (!set) {
      missing.push(key);
      continue;
    }
    const next = structuredClone(set.grants) as unknown as StoredGrant[];
    if (hasPageAccess(next)) {
      unchanged.push(key);
      logger.info(`[r019-bom-pages] ${key}: already has the ${BOMS_PAGE_ID} page; nothing written`);
      continue;
    }
    next.push(authz.pages.grant(BOMS_PAGE_ID) as unknown as StoredGrant);
    if (set.revision === undefined) {
      logger.info(`[r019-bom-pages] ${key}: no revision; refusing to overwrite; nothing written`);
      throw new Error(`[r019-bom-pages] ${key}: permission set has no revision; reload and rerun`);
    }
    try {
      await authz.permissionSets.update(
        key,
        {
          key,
          ...(set.title === undefined ? {} : { title: set.title }),
          grants: next as unknown as CreatePermissionSetInput['grants'],
        },
        set.revision,
      );
    } catch (error) {
      logger.info(
        error instanceof PermissionSetConflictError
          ? `[r019-bom-pages] ${key}: 读后被改过（revision changed since it was read）; nothing written; 重载重跑`
          : `[r019-bom-pages] ${key}: update failed; nothing written; reload and rerun`,
      );
      throw error;
    }
    logger.info(`[r019-bom-pages] ${key}: added the ${BOMS_PAGE_ID} page`);
    changed.push(key);
  }
  logger.info(`[r019-bom-pages] added: ${changed.join(',') || '(none)'}`);
  return { pages: { targets: [...TARGETS], changed, unchanged, missing, invalid } };
}

export default class AuthzUpgradeR019BomPages extends AppCommand {
  static summary =
    'Give the craft and planning permission sets the BOM page (existing installations).';

  static description =
    'Seed only runs on new installations. This command adds the page grant "boms" to the craft and planning permission sets. Maintenance entrances are gated by the boms resource actions, which only root holds. It never touches other roles or changes grants that already exist. Idempotent: a second run writes nothing and leaves revisions alone. A role whose boms.view declaration does not resolve, or that is missing, is skipped as a whole. Writes carry the revision that was read: a concurrent edit is reported instead of overwritten. Reload and rerun after a conflict.';

  static examples = ['<%= config.bin %> <%= command.id %>'];

  async run(): Promise<R019BomPagesUpgradeReport> {
    await this.parse(AuthzUpgradeR019BomPages);
    return this.withApp(async ({ app }) => {
      await app.start();
      const { authorizationToken } =
        await import('@nocobase/app-plugin-authorization/server');
      const services: R019BomPagesUpgradeServices = {
        authorization: app.container.resolve(
          authorizationToken,
        ) as unknown as R019BomPagesUpgradeServices['authorization'],
      };
      return await upgradeR019BomPages(services, {
        info: (message) => this.log(message),
      });
    });
  }
}
