import type { AppAuthorization } from '@nocobase/app-plugin-authorization';
import { AppCommand } from '@nocobase/app-cli';
import {
  PermissionSetConflictError,
  type CreatePermissionSetInput,
} from '@nocobase/authorization/permission-sets';

import {
  TARGETS,
  upgradeR021,
  type R021UpgradeReport,
} from './upgrade-r021.js';

/**
 * R-019 页面片的升级步骤：`pnpm nocobase authz upgrade-r019-page`。
 *
 * seed 只对新建环境生效；已有环境里的销售、采购拿不到物料页的页面授权，谁也打不开这一页。
 * 这条命令先跑 `upgrade-r021`（补订单授权与 items.view、inventory.warehouseView，已有就什么都不写），
 * 再给两个角色各补一条 `items` 页面的 `access`。只加不改、不给其它角色加，也不给任何角色 items.manage。
 *
 * 幂等：第二次什么都不写，revision 也不变。写入带读到的 revision：读到之后有人改过角色就报错退出、
 * 重载重跑，不覆盖别人的改动。声明对不上（`upgrade-r021` 把这个角色判成 invalid）或找不到角色时，
 * 这个角色整条跳过，页面授权也不写。
 */
/** 物料页的页面 id：与 `client/pages/items/page-id.ts` 是同一个值，守门测试钉住。 */
export const ITEMS_PAGE_ID = 'items';

export interface R019PageUpgradeReport {
  readonly grants: R021UpgradeReport;
  readonly pages: {
    readonly targets: readonly string[];
    readonly changed: readonly string[];
    readonly unchanged: readonly string[];
    readonly missing: readonly string[];
    readonly invalid: readonly string[];
  };
}

export interface R019PageUpgradeServices {
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

export async function upgradeR019Page(
  services: R019PageUpgradeServices,
  logger: { info(message: string): void },
): Promise<R019PageUpgradeReport> {
  const { authorization: authz } = services;
  const grants = await upgradeR021(services, logger);
  const skipped = new Set([...grants.missing, ...grants.invalid]);
  const changed: string[] = [];
  const unchanged: string[] = [];
  const missing: string[] = [];
  const invalid: string[] = [];
  logger.info('[r019-page] === page grants ===');
  const sets = await authz.permissionSets.list();
  for (const key of TARGETS) {
    if (skipped.has(key)) {
      if (grants.missing.includes(key)) missing.push(key);
      else {
        invalid.push(key);
        logger.info(
          `[r019-page] ${key}: declaration mismatch in upgrade-r021; page grant not written`,
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
    if (hasPageAccess(next, ITEMS_PAGE_ID)) {
      unchanged.push(key);
      logger.info(
        `[r019-page] ${key}: already has the items page; nothing written`,
      );
      continue;
    }
    // 页面授权用框架现成的函数造。
    next.push(authz.pages.grant(ITEMS_PAGE_ID) as unknown as StoredGrant);
    if (set.revision === undefined) {
      logger.info(
        `[r019-page] ${key}: no revision on the stored set; refusing to overwrite; nothing written`,
      );
      throw new Error(
        `[r019-page] ${key}: permission set has no revision; reload and rerun`,
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
          ? `[r019-page] ${key}: 读后被改过（revision changed since it was read）; nothing written; 重载重跑（reload and rerun）`
          : `[r019-page] ${key}: update failed; nothing written; reload and rerun`,
      );
      throw error;
    }
    logger.info(`[r019-page] ${key}: added the items page`);
    changed.push(key);
  }
  logger.info(`[r019-page] added: ${changed.join(',') || '(none)'}`);
  return {
    grants,
    pages: { targets: TARGETS, changed, unchanged, missing, invalid },
  };
}

export default class AuthzUpgradeR019Page extends AppCommand {
  static summary =
    'Give the sales and purchase permission sets the items page (existing installations).';

  static description =
    'Seed only runs on new installations. This command first applies upgrade-r021 (order grants and the read-only items.view / inventory.warehouseView to purchase and sales), then adds the page grant "items" to both. It never touches other roles, never grants items.manage, and never changes grants that already exist. Idempotent: a second run writes nothing and leaves revisions alone. A role the resource step reports missing or invalid is skipped as a whole, page grant included. Writes carry the revision that was read: a concurrent edit is reported instead of overwritten. Reload and rerun after a conflict.';

  static examples = ['<%= config.bin %> <%= command.id %>'];

  async run(): Promise<R019PageUpgradeReport> {
    await this.parse(AuthzUpgradeR019Page);
    return this.withApp(async ({ app }) => {
      await app.start();
      const { authorizationToken } =
        await import('@nocobase/app-plugin-authorization/server');
      const services: R019PageUpgradeServices = {
        authorization: app.container.resolve(
          authorizationToken,
        ) as unknown as R019PageUpgradeServices['authorization'],
      };
      return await upgradeR019Page(services, {
        info: (message) => this.log(message),
      });
    });
  }
}
