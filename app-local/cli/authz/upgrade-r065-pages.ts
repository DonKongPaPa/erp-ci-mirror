import type { AppAuthorization } from '@nocobase/app-plugin-authorization';
import { AppCommand } from '@nocobase/app-cli';
import {
  PermissionSetConflictError,
  type CreatePermissionSetInput,
} from '@nocobase/authorization/permission-sets';

/**
 * R-065 第二片页面片的升级步骤：`pnpm nocobase authz upgrade-r065-pages`。
 *
 * seed 只对新建环境生效；已有环境里的 finance 拿不到这四张财务页面的页面授权，谁也打不开。
 * 本命令只给 finance 补四条 `access`，不建角色、不补用户指派、不碰别的表与别的角色。
 * 业务动作由 `upgrade-r065-reconcile` 负责；本命令先跑它，业务那一步判成缺失或声明对不上时页面授权整条跳过。
 *
 * 幂等：第二次什么都不写，revision 也不变。写入带读到的 revision：读到之后有人改过角色就报错退出、
 * 重载重跑，不覆盖别人的改动。页面授权按「本条在不在」逐条判，已有授权与管理员改过的部分不动。
 */
import {
  upgradeR065Reconcile,
  type R065ReconcileUpgradeReport,
} from './upgrade-r065-reconcile.js';

export const FINANCE_TARGET = 'finance';
export const TARGETS = [FINANCE_TARGET] as const;
export const FINANCE_RECONCILIATION_PAGE_IDS = [
  'incomeRecords', 'saleInvoiceRecords', 'receivableRecons', 'payableRecons',
] as const;

export interface R065PagesUpgradeReport {
  readonly reconcile: R065ReconcileUpgradeReport;
  readonly pages: {
    readonly targets: readonly string[];
    readonly changed: readonly string[];
    readonly unchanged: readonly string[];
    readonly missing: readonly string[];
    readonly invalid: readonly string[];
  };
}

export interface R065PagesUpgradeServices {
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

/** 带条件的 access 框架不放行，只看动作名会误判成已补。 */
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

export async function upgradeR065Pages(
  services: R065PagesUpgradeServices,
  logger: { info(message: string): void },
): Promise<R065PagesUpgradeReport> {
  const { authorization: authz } = services;
  const reconcile = await upgradeR065Reconcile(services, logger);
  const skipped = new Set([...reconcile.missing, ...reconcile.invalid]);
  const changed: string[] = [];
  const unchanged: string[] = [];
  const missing: string[] = [];
  const invalid: string[] = [];
  logger.info('[r065-pages] === page grants ===');
  const sets = await authz.permissionSets.list();
  for (const key of TARGETS) {
    if (skipped.has(key)) {
      if (reconcile.missing.includes(key)) missing.push(key);
      else invalid.push(key);
      logger.info(`[r065-pages] ${key}: reconcile step skipped; page grant not written`);
      continue;
    }
    const set = sets.find((entry) => entry.key === key) as StoredSet | undefined;
    if (!set) { missing.push(key); continue; }
    const next = structuredClone(set.grants) as unknown as StoredGrant[];
    const absent = FINANCE_RECONCILIATION_PAGE_IDS.filter((id) => !hasPageAccess(next, id));
    if (absent.length === 0) {
      unchanged.push(key);
      logger.info(`[r065-pages] ${key}: already has all four pages; nothing written`);
      continue;
    }
    for (const id of absent) {
      next.push(authz.pages.grant(id) as unknown as StoredGrant);
    }
    if (set.revision === undefined) {
      logger.info(`[r065-pages] ${key}: no revision; refusing to overwrite; nothing written`);
      throw new Error(`[r065-pages] ${key}: permission set has no revision; reload and rerun`);
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
          ? `[r065-pages] ${key}: revision changed since read; nothing written; reload and rerun`
          : `[r065-pages] ${key}: update failed; nothing written; reload and rerun`,
      );
      throw error;
    }
    changed.push(key);
  }
  return { reconcile, pages: { targets: [...TARGETS], changed, unchanged, missing, invalid } };
}

export default class AuthzUpgradeR065Pages extends AppCommand {
  static summary = 'Grant the finance role the four reconciliation finance pages (existing installations).';

  static description =
    'Seed only runs on new installations. This command runs upgrade-r065-reconcile first, then adds the incomeRecords, saleInvoiceRecords, receivableRecons and payableRecons page access grants to the finance role. Nothing else: no other role, no user assignment, no existing grant rewritten. Idempotent: a second run writes nothing and leaves the revision alone. Writes carry the revision that was read. Reload and rerun after a conflict or a declaration mismatch.';

  static examples = ['<%= config.bin %> <%= command.id %>'];

  async run(): Promise<R065PagesUpgradeReport> {
    await this.parse(AuthzUpgradeR065Pages);
    return await this.withApp(async ({ app }) => {
      await app.start();
      const { authorizationToken } =
        await import('@nocobase/app-plugin-authorization/server');
      const services: R065PagesUpgradeServices = {
        authorization: app.container.resolve(authorizationToken) as unknown as R065PagesUpgradeServices['authorization'],
      };
      return await upgradeR065Pages(services, { info: (message) => this.log(message) });
    });
  }
}
