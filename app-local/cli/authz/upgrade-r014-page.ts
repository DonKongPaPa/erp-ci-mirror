import type { AppAuthorization } from '@nocobase/app-plugin-authorization';
import { AppCommand } from '@nocobase/app-cli';
import {
  PermissionSetConflictError,
  type CreatePermissionSetInput,
} from '@nocobase/authorization/permission-sets';

import {
  PURCHASE_PERMISSION_SET,
  SALES_PERMISSION_SET,
  upgradeR014,
  type R014UpgradeReport,
} from './upgrade-r014.js';

/**
 * R-014 页面片的升级步骤：`pnpm nocobase authz upgrade-r014-page`。
 *
 * seed 只对新建环境生效；已有环境里的销售、采购拿不到客户与供应商页的页面授权，谁也打不开这一页。
 * 这条命令先跑 `upgrade-r014`（补 customers.* / suppliers.*，已有就什么都不写），再给两个角色各补一条
 * `partners` 页面的 `access`。只加不改、不给其它角色加。
 *
 * 幂等：第二次什么都不写，revision 也不变。写入带读到的 revision：读到之后有人改过角色就报错退出、
 * 重载重跑，不覆盖别人的改动。声明对不上（`upgrade-r014` 把这个角色判成 invalid）或找不到角色时，
 * 这个角色整条跳过，页面授权也不写。
 */
/** 客户与供应商页的页面 id：与 `client/pages/partners/page-id.ts` 是同一个值，守门测试钉住。 */
export const PARTNERS_PAGE_ID = 'partners';

export interface R014PageUpgradeReport {
  readonly grants: R014UpgradeReport;
  readonly pages: {
    readonly targets: readonly string[];
    readonly changed: readonly string[];
    readonly unchanged: readonly string[];
    readonly missing: readonly string[];
    readonly invalid: readonly string[];
  };
}

export interface R014PageUpgradeServices {
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

const TARGETS = [SALES_PERMISSION_SET, PURCHASE_PERMISSION_SET] as const;

/** 「已有」必须是不带 policy 的 `access`：带条件的页面授权框架不放行，只看动作名会误判成已补。 */
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

export async function upgradeR014Page(
  services: R014PageUpgradeServices,
  logger: { info(message: string): void },
): Promise<R014PageUpgradeReport> {
  const { authorization: authz } = services;
  const grants = await upgradeR014(services, logger);
  const skipped = new Set([...grants.missing, ...grants.invalid]);
  const changed: string[] = [];
  const unchanged: string[] = [];
  const missing: string[] = [];
  const invalid: string[] = [];
  logger.info('[r014-page] === page grants ===');
  const sets = await authz.permissionSets.list();
  for (const key of TARGETS) {
    if (skipped.has(key)) {
      if (grants.missing.includes(key)) missing.push(key);
      else {
        invalid.push(key);
        logger.info(
          `[r014-page] ${key}: declaration mismatch in upgrade-r014; page grant not written`,
        );
      }
      continue;
    }
    const set = sets.find((entry) => entry.key === key) as
      StoredSet | undefined;
    if (!set) {
      missing.push(key);
      continue;
    }
    const next = structuredClone(set.grants) as unknown as StoredGrant[];
    if (hasPageAccess(next, PARTNERS_PAGE_ID)) {
      unchanged.push(key);
      logger.info(
        `[r014-page] ${key}: already has the partners page; nothing written`,
      );
      continue;
    }
    // 页面授权用框架现成的函数造。
    next.push(authz.pages.grant(PARTNERS_PAGE_ID) as unknown as StoredGrant);
    if (set.revision === undefined) {
      logger.info(
        `[r014-page] ${key}: no revision on the stored set; refusing to overwrite; nothing written`,
      );
      throw new Error(
        `[r014-page] ${key}: permission set has no revision; reload and rerun`,
      );
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
          ? `[r014-page] ${key}: 读后被改过（revision changed since it was read）; nothing written; 重载重跑（reload and rerun）`
          : `[r014-page] ${key}: update failed; nothing written; reload and rerun`,
      );
      throw error;
    }
    logger.info(`[r014-page] ${key}: added the partners page`);
    changed.push(key);
  }
  logger.info(`[r014-page] added: ${changed.join(',') || '(none)'}`);
  return {
    grants,
    pages: { targets: TARGETS, changed, unchanged, missing, invalid },
  };
}

export default class AuthzUpgradeR014Page extends AppCommand {
  static summary =
    'Give the sales and purchase permission sets the customers and suppliers page (existing installations).';

  static description =
    'Seed only runs on new installations. This command first applies upgrade-r014 (customers.* to sales, suppliers.* to purchase), then adds the page grant "partners" to both. It never touches other roles or changes grants that already exist. Idempotent: a second run writes nothing and leaves revisions alone. A role the resource step reports missing or invalid is skipped as a whole, page grant included. Writes carry the revision that was read: a concurrent edit is reported instead of overwritten. Reload and rerun after a conflict.';

  static examples = ['<%= config.bin %> <%= command.id %>'];

  async run(): Promise<R014PageUpgradeReport> {
    await this.parse(AuthzUpgradeR014Page);
    return this.withApp(async ({ app }) => {
      await app.start();
      const { authorizationToken } =
        await import('@nocobase/app-plugin-authorization/server');
      const services: R014PageUpgradeServices = {
        authorization: app.container.resolve(
          authorizationToken,
        ) as unknown as R014PageUpgradeServices['authorization'],
      };
      return await upgradeR014Page(services, {
        info: (message) => this.log(message),
      });
    });
  }
}
