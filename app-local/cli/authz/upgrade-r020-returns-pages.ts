import type { AppAuthorization } from '@nocobase/app-plugin-authorization';
import { AppCommand } from '@nocobase/app-cli';
import {
  PermissionSetConflictError,
  type CreatePermissionSetInput,
} from '@nocobase/authorization/permission-sets';

/**
 * R-020 波 2 加片二：`pnpm nocobase authz upgrade-r020-returns-pages`。
 *
 * seed 只对新建环境生效；已有环境要手动给四个现成角色补退货页面授权：
 * 采购拿采购退货页，销售拿销售退货页，仓管拿两页（待过账），财务只拿销售退货页（窄读）。
 * 业务动作由 `upgrade-r020-returns` 负责，这条命令只加页面 access，不建角色、
 * 不动别的角色、不改写已有授权、不补用户指派。
 *
 * 幂等：第二次什么都不写，revision 也不变。写入带读到的 revision：读到之后有人改过角色就报错退出、
 * 重载重跑，不覆盖别人的改动。
 */
export const PURCHASE_RETURNS_PAGE_ID = 'purchaseReturns';
export const SALES_RETURNS_PAGE_ID = 'salesReturns';

export interface R020ReturnsPagesUpgradeReport {
  readonly targets: readonly string[];
  readonly changed: readonly string[];
  readonly unchanged: readonly string[];
  readonly missing: readonly string[];
  readonly invalid: readonly string[];
}

export interface R020ReturnsPagesUpgradeServices {
  readonly authorization: Pick<
    AppAuthorization,
    'permissionSets' | 'pages'
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

export const RETURNS_PAGE_TARGETS = [
  { key: 'purchase', pages: [PURCHASE_RETURNS_PAGE_ID] },
  { key: 'sales', pages: [SALES_RETURNS_PAGE_ID] },
  { key: 'warehouse', pages: [PURCHASE_RETURNS_PAGE_ID, SALES_RETURNS_PAGE_ID] },
  { key: 'finance', pages: [SALES_RETURNS_PAGE_ID] },
] as const;

/** 带条件的页面授权框架不放行，只看动作名会误判成已补。 */
function hasPageAccess(grants: readonly StoredGrant[], id: string): boolean {
  return grants.some(
    (grant) =>
      grant.resource.type === 'page' &&
      grant.resource.id === id &&
      grant.actions.some(
        (entry) => entry.action === 'access' && entry.policy === undefined,
      ),
  );
}

export async function upgradeR020ReturnsPages(
  services: R020ReturnsPagesUpgradeServices,
  logger: { info(message: string): void },
): Promise<R020ReturnsPagesUpgradeReport> {
  const { authorization: authz } = services;
  const changed: string[] = [];
  const unchanged: string[] = [];
  const missing: string[] = [];
  const invalid: string[] = [];
  const sets = await authz.permissionSets.list();
  logger.info('[r020-returns-pages] === page grants ===');
  for (const { key, pages } of RETURNS_PAGE_TARGETS) {
    const set = sets.find((entry) => entry.key === key) as StoredSet | undefined;
    if (!set) {
      missing.push(key);
      logger.info(`[r020-returns-pages] ${key}: not found; skipped`);
      continue;
    }
    const next = structuredClone(set.grants) as unknown as StoredGrant[];
    const absent = pages.filter((id) => !hasPageAccess(next, id));
    if (absent.length === 0) {
      unchanged.push(key);
      logger.info(`[r020-returns-pages] ${key}: already has every page; nothing written`);
      continue;
    }
    if (set.revision === undefined) {
      invalid.push(key);
      logger.info(`[r020-returns-pages] ${key}: no revision; refusing to overwrite; nothing written`);
      continue;
    }
    for (const id of absent)
      next.push(authz.pages.grant(id) as unknown as StoredGrant);
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
          ? `[r020-returns-pages] ${key}: revision changed since read; nothing written; reload and rerun`
          : `[r020-returns-pages] ${key}: update failed; nothing written; reload and rerun`,
      );
      throw error;
    }
    logger.info(`[r020-returns-pages] ${key}: added pages ${absent.join(',')}`);
    changed.push(key);
  }
  return {
    targets: RETURNS_PAGE_TARGETS.map(({ key }) => key),
    changed,
    unchanged,
    missing,
    invalid,
  };
}

export default class AuthzUpgradeR020ReturnsPages extends AppCommand {
  static summary =
    'Give purchase, sales, warehouse and finance the purchase-returns and sales-returns pages (existing installations).';

  static description =
    'Seed only runs on new installations. This command gives purchase the purchaseReturns page, sales the salesReturns page, warehouse both pages (for awaiting-posting lists), and finance only the salesReturns page. It adds page access only: return business actions come from upgrade-r020-returns. No new role, no other role, no user assignment, no existing grant rewritten. Idempotent: a second run writes nothing and leaves revisions alone. Writes carry the revision that was read; a concurrent edit is reported instead of overwritten. Reload and rerun after a conflict.';

  static examples = ['<%= config.bin %> <%= command.id %>'];

  async run(): Promise<R020ReturnsPagesUpgradeReport> {
    await this.parse(AuthzUpgradeR020ReturnsPages);
    return await this.withApp(async ({ app }) => {
      await app.start();
      const { authorizationToken } =
        await import('@nocobase/app-plugin-authorization/server');
      const services: R020ReturnsPagesUpgradeServices = {
        authorization: app.container.resolve(authorizationToken) as unknown as R020ReturnsPagesUpgradeServices['authorization'],
      };
      return await upgradeR020ReturnsPages(services, {
        info: (message) => this.log(message),
      });
    });
  }
}
