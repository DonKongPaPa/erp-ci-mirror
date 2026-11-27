import type { AppAuthorization } from '@nocobase/app-plugin-authorization';
import { AppCommand } from '@nocobase/app-cli';
import {
  PermissionSetConflictError,
  type CreatePermissionSetInput,
} from '@nocobase/authorization/permission-sets';

import {
  PURCHASE_TARGET,
  SALES_TARGET,
  upgradeR021,
  type R021UpgradeReport,
} from './upgrade-r021.js';

/**
 * R-021 / R-022 页面片的升级步骤：`pnpm nocobase authz upgrade-r021-page`。
 *
 * seed 只对新建环境生效；已有环境里的采购、销售拿不到订单页的页面授权，谁也打不开这两页。
 * 这条命令先跑 `upgrade-r021`（补订单六个动作与只读引用，已有就什么都不写），再各补一条页面授权：
 * 采购拿 `purchaseOrders`，销售拿 `salesOrders`，互不相通（R-022 的理由第 1 条：禁止销售读采购单是授权事实）。
 * 只加不改、不给其它角色加。
 *
 * 幂等：第二次什么都不写，revision 也不变。写入带读到的 revision：读到之后有人改过角色就报错退出、
 * 重载重跑，不覆盖别人的改动。声明对不上（`upgrade-r021` 把这个角色判成 invalid）或找不到角色时，
 * 这个角色整条跳过，页面授权也不写。
 */
/** 采购订单页、销售订单页的页面 id：与 `client/pages/<kind>-orders/page-id.ts` 是同一个值，守门测试钉住。 */
export const PURCHASE_ORDERS_PAGE_ID = 'purchaseOrders';
export const SALES_ORDERS_PAGE_ID = 'salesOrders';

export interface R021PageUpgradeReport {
  readonly grants: R021UpgradeReport;
  readonly pages: {
    readonly targets: readonly string[];
    readonly changed: readonly string[];
    readonly unchanged: readonly string[];
    readonly missing: readonly string[];
    readonly invalid: readonly string[];
  };
}

export interface R021PageUpgradeServices {
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

const TARGETS = [
  { key: PURCHASE_TARGET, page: PURCHASE_ORDERS_PAGE_ID },
  { key: SALES_TARGET, page: SALES_ORDERS_PAGE_ID },
] as const;

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

export async function upgradeR021Page(
  services: R021PageUpgradeServices,
  logger: { info(message: string): void },
): Promise<R021PageUpgradeReport> {
  const { authorization: authz } = services;
  const grants = await upgradeR021(services, logger);
  const skipped = new Set([...grants.missing, ...grants.invalid]);
  const changed: string[] = [];
  const unchanged: string[] = [];
  const missing: string[] = [];
  const invalid: string[] = [];
  logger.info('[r021-page] === page grants ===');
  const sets = await authz.permissionSets.list();
  for (const { key, page } of TARGETS) {
    if (skipped.has(key)) {
      if (grants.missing.includes(key)) missing.push(key);
      else {
        invalid.push(key);
        logger.info(
          `[r021-page] ${key}: declaration mismatch in upgrade-r021; page grant not written`,
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
    if (hasPageAccess(next, page)) {
      unchanged.push(key);
      logger.info(
        `[r021-page] ${key}: already has the ${page} page; nothing written`,
      );
      continue;
    }
    // 页面授权用框架现成的函数造。
    next.push(authz.pages.grant(page) as unknown as StoredGrant);
    if (set.revision === undefined) {
      logger.info(
        `[r021-page] ${key}: no revision on the stored set; refusing to overwrite; nothing written`,
      );
      throw new Error(
        `[r021-page] ${key}: permission set has no revision; reload and rerun`,
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
          ? `[r021-page] ${key}: 读后被改过（revision changed since it was read）; nothing written; 重载重跑（reload and rerun）`
          : `[r021-page] ${key}: update failed; nothing written; reload and rerun`,
      );
      throw error;
    }
    logger.info(`[r021-page] ${key}: added the ${page} page`);
    changed.push(key);
  }
  logger.info(`[r021-page] added: ${changed.join(',') || '(none)'}`);
  return {
    grants,
    pages: {
      targets: TARGETS.map(({ key }) => key),
      changed,
      unchanged,
      missing,
      invalid,
    },
  };
}

export default class AuthzUpgradeR021Page extends AppCommand {
  static summary =
    'Give the purchase and sales permission sets their order pages (existing installations).';

  static description =
    'Seed only runs on new installations. This command first applies upgrade-r021 (purchaseOrders.* to purchase, salesOrders.* to sales, with the read-only item and warehouse grants), then adds the page grant "purchaseOrders" to the purchase set and "salesOrders" to the sales set. Neither set gets the other page. It never touches other roles or changes grants that already exist. Idempotent: a second run writes nothing and leaves revisions alone. A role the resource step reports missing or invalid is skipped as a whole, page grant included. Writes carry the revision that was read: a concurrent edit is reported instead of overwritten. Reload and rerun after a conflict.';

  static examples = ['<%= config.bin %> <%= command.id %>'];

  async run(): Promise<R021PageUpgradeReport> {
    await this.parse(AuthzUpgradeR021Page);
    return this.withApp(async ({ app }) => {
      await app.start();
      const { authorizationToken } =
        await import('@nocobase/app-plugin-authorization/server');
      const services: R021PageUpgradeServices = {
        authorization: app.container.resolve(
          authorizationToken,
        ) as unknown as R021PageUpgradeServices['authorization'],
      };
      return await upgradeR021Page(services, {
        info: (message) => this.log(message),
      });
    });
  }
}
