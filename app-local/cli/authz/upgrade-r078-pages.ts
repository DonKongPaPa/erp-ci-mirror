import type { AppAuthorization } from '@nocobase/app-plugin-authorization';
import { AppCommand } from '@nocobase/app-cli';
import {
  PermissionSetConflictError,
  type CreatePermissionSetInput,
} from '@nocobase/authorization/permission-sets';

/**
 * R-078 页面片：`pnpm nocobase authz upgrade-r078-pages`。
 *
 * 给五个现成角色补报表中心的页面授权；root 天然全通。入口动作（reports.view/run/export/favorite）
 * 由 023 种子与 `upgrade-r078-reports` 负责，这条命令不碰，也不碰每张报表的 baseActions。
 * 只加不改、幂等：第二次什么都不写，revision 不变；找不到角色时整条跳过。
 * 写入带读到的 revision，读到之后有人改过角色就报错退出、重载重跑，不覆盖别人的改动。
 */
/** 与 023 号种子的 REPORT_ROLES 是同一组岗位；命令不读种子文件，避免运行时跨目录解析。 */
export const TARGETS = [
  'finance', 'purchase', 'sales', 'warehouse', 'planning',
] as const;
export const PAGE_ID = 'reports';

export interface UpgradeLogger { info(message: string): void }
export interface R078PagesUpgradeReport {
  readonly targets: readonly string[];
  readonly changed: readonly string[];
  readonly unchanged: readonly string[];
  readonly missing: readonly string[];
}
export interface R078PagesUpgradeServices {
  readonly authorization: Pick<
    AppAuthorization,
    'permissionSets' | 'pages'
  >;
}
interface StoredGrantAction { action: string; policy?: unknown }
interface StoredGrant { resource: { type: string; id: string }; actions: StoredGrantAction[] }
interface StoredSet {
  readonly revision?: string;
  readonly title?: CreatePermissionSetInput['title'];
  readonly grants: CreatePermissionSetInput['grants'];
}

/** 「已有」必须是不带 policy 的 access：带条件的页面授权框架不放行，只看动作名会误判。 */
export function hasPageAccess(grants: readonly StoredGrant[]): boolean {
  return grants.some(
    (grant) =>
      grant.resource.type === 'page' &&
      grant.resource.id === PAGE_ID &&
      grant.actions.some(
        (entry) => entry.action === 'access' && entry.policy === undefined,
      ),
  );
}

export async function upgradeReportsPages(
  services: R078PagesUpgradeServices,
  logger: UpgradeLogger,
): Promise<R078PagesUpgradeReport> {
  const { authorization: authz } = services;
  const changed: string[] = [];
  const unchanged: string[] = [];
  const missing: string[] = [];
  const sets = await authz.permissionSets.list();
  for (const target of TARGETS) {
    const set = sets.find((entry) => entry.key === target) as StoredSet | undefined;
    if (set === undefined) {
      logger.info(`[r078-pages] ${target}: role missing; nothing written`);
      missing.push(target);
      continue;
    }
    const next = structuredClone(set.grants) as unknown as StoredGrant[];
    if (hasPageAccess(next)) {
      logger.info(`[r078-pages] ${target}: already has the ${PAGE_ID} page; nothing written`);
      unchanged.push(target);
      continue;
    }
    next.push(authz.pages.grant(PAGE_ID) as unknown as StoredGrant);
    if (set.revision === undefined) {
      logger.info(
        `[r078-pages] ${target}: no revision on the stored set; refusing to overwrite; nothing written`,
      );
      throw new Error(`[r078-pages] ${target}: permission set has no revision; reload and rerun`);
    }
    try {
      await authz.permissionSets.update(
        target,
        {
          key: target,
          ...(set.title === undefined ? {} : { title: set.title }),
          grants: next as unknown as CreatePermissionSetInput['grants'],
        },
        set.revision,
      );
    } catch (error) {
      logger.info(
        error instanceof PermissionSetConflictError
          ? `[r078-pages] ${target}: revision changed since it was read; nothing written`
          : `[r078-pages] ${target}: update failed; nothing written`,
      );
      throw error;
    }
    logger.info(`[r078-pages] ${target}: added the ${PAGE_ID} page`);
    changed.push(target);
  }
  logger.info(`[r078-pages] added: ${changed.join(',') || '(none)'}`);
  return { targets: [...TARGETS], changed, unchanged, missing };
}

export default class AuthzUpgradeR078Pages extends AppCommand {
  static summary =
    'Give the five business roles the report-center page (existing installations).';

  static description =
    'Seed only runs on new installations. This command adds the page grant "reports" to finance, purchase, sales, warehouse and planning. Root is unrestricted. Entry actions come from upgrade-r078-reports and are not touched here; neither are the per-report base actions. It creates no role, writes no user assignment, rewrites no existing grant, carries the revision it read, and writes nothing on a second run or for a missing role.';

  static examples = ['<%= config.bin %> <%= command.id %>'];

  async run(): Promise<R078PagesUpgradeReport> {
    await this.parse(AuthzUpgradeR078Pages);
    return await this.withApp(async ({ app }) => {
      await app.start();
      const { authorizationToken } =
        await import('@nocobase/app-plugin-authorization/server');
      return await upgradeReportsPages({
        authorization: app.container.resolve(
          authorizationToken,
        ) as unknown as R078PagesUpgradeServices['authorization'],
      }, { info: (message) => this.log(message) });
    });
  }
}
