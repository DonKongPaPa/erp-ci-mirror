import type { AppAuthorization } from '@nocobase/app-plugin-authorization';
import { AppCommand } from '@nocobase/app-cli';
import {
  PermissionSetConflictError,
  type CreatePermissionSetInput,
} from '@nocobase/authorization/permission-sets';

import {
  upgradeR020,
  WAREHOUSE_PERMISSION_SET,
  type R020UpgradeReport,
} from './upgrade-r020.js';
import {
  PURCHASE_TARGET,
  SALES_TARGET,
  upgradeR021,
  type R021UpgradeReport,
} from './upgrade-r021.js';

/**
 * R-020 页面片的升级步骤：`pnpm nocobase authz upgrade-r020-page`。
 *
 * seed 只对新建环境生效；已有环境里的仓管、采购、销售拿不到物料与库存四页的页面授权，谁也打不开。
 * 这条命令先跑 `upgrade-r020`（给仓管补 inventory.*，已有就什么都不写）与 `upgrade-r021`
 * （给采购、销售补订单授权与仓库只读），再给仓管补 `stock`、`inboundOrders`、`outboundOrders`、`warehouses`
 * 四页的 `access`，给采购、销售各补一条 `warehouses`。只加不改、不给其它角色加。
 *
 * 幂等：第二次什么都不写，revision 也不变。写入带读到的 revision：读到之后有人改过角色就报错退出、
 * 重载重跑，不覆盖别人的改动。角色在它的业务授权那一步被判成找不到或声明对不上时，整条跳过，页面授权也不写。
 */
/** 页面 id：与 `client/pages/stock-docs/page-id.ts`、`client/pages/warehouses/page-id.ts` 是同一组值，守门测试钉住。 */
export const STOCK_PAGE_ID = 'stock';
export const INBOUND_ORDERS_PAGE_ID = 'inboundOrders';
export const OUTBOUND_ORDERS_PAGE_ID = 'outboundOrders';
export const WAREHOUSES_PAGE_ID = 'warehouses';

export interface R020PageUpgradeReport {
  /** 仓管的业务授权那一步。 */
  readonly grants: R020UpgradeReport;
  /** 采购、销售的业务授权那一步。 */
  readonly orders: R021UpgradeReport;
  readonly pages: {
    readonly targets: readonly string[];
    readonly changed: readonly string[];
    readonly unchanged: readonly string[];
    readonly missing: readonly string[];
    readonly invalid: readonly string[];
  };
}

export interface R020PageUpgradeServices {
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

/** 每个角色该补的页面（《基座ERP前端设计》1.3）。 */
const TARGETS = [
  {
    key: WAREHOUSE_PERMISSION_SET,
    pages: [
      STOCK_PAGE_ID,
      INBOUND_ORDERS_PAGE_ID,
      OUTBOUND_ORDERS_PAGE_ID,
      WAREHOUSES_PAGE_ID,
    ],
  },
  { key: PURCHASE_TARGET, pages: [WAREHOUSES_PAGE_ID] },
  { key: SALES_TARGET, pages: [WAREHOUSES_PAGE_ID] },
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

export async function upgradeR020Page(
  services: R020PageUpgradeServices,
  logger: { info(message: string): void },
): Promise<R020PageUpgradeReport> {
  const { authorization: authz } = services;
  const grants = await upgradeR020(services, logger);
  const orders = await upgradeR021(services, logger);
  // 业务授权那一步判成找不到或声明对不上的角色，页面授权也整条跳过。
  const skipped = new Map<string, 'missing' | 'invalid'>();
  for (const key of grants.missing) skipped.set(key, 'missing');
  for (const key of grants.invalid) skipped.set(key, 'invalid');
  for (const key of orders.missing) skipped.set(key, 'missing');
  for (const key of orders.invalid) skipped.set(key, 'invalid');

  const changed: string[] = [];
  const unchanged: string[] = [];
  const missing: string[] = [];
  const invalid: string[] = [];
  logger.info('[r020-page] === page grants ===');
  const sets = await authz.permissionSets.list();
  for (const { key, pages } of TARGETS) {
    const skip = skipped.get(key);
    if (skip) {
      (skip === 'missing' ? missing : invalid).push(key);
      logger.info(
        `[r020-page] ${key}: ${skip === 'missing' ? 'not found' : 'declaration mismatch'} in the grant step; page grants not written`,
      );
      continue;
    }
    const set = sets.find((entry) => entry.key === key) as StoredSet | undefined;
    if (!set) {
      missing.push(key);
      logger.info(`[r020-page] ${key}: not found; skipped`);
      continue;
    }
    const next = structuredClone(set.grants) as unknown as StoredGrant[];
    const absent = pages.filter((id) => !hasPageAccess(next, id));
    if (absent.length === 0) {
      unchanged.push(key);
      logger.info(
        `[r020-page] ${key}: already has every page; nothing written`,
      );
      continue;
    }
    for (const id of absent)
      next.push(authz.pages.grant(id) as unknown as StoredGrant);
    if (set.revision === undefined) {
      logger.info(
        `[r020-page] ${key}: no revision on the stored set; refusing to overwrite; nothing written`,
      );
      throw new Error(
        `[r020-page] ${key}: permission set has no revision; reload and rerun`,
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
          ? `[r020-page] ${key}: 读后被改过（revision changed since it was read）; nothing written; 重载重跑（reload and rerun）`
          : `[r020-page] ${key}: update failed; nothing written; reload and rerun`,
      );
      throw error;
    }
    logger.info(`[r020-page] ${key}: added pages ${absent.join(',')}`);
    changed.push(key);
  }
  logger.info(`[r020-page] added: ${changed.join(',') || '(none)'}`);
  return {
    grants,
    orders,
    pages: {
      targets: TARGETS.map(({ key }) => key),
      changed,
      unchanged,
      missing,
      invalid,
    },
  };
}

export default class AuthzUpgradeR020Page extends AppCommand {
  static summary =
    'Give the warehouse keeper the stock, inbound orders, outbound orders and warehouses pages, and sales and purchase the warehouses page (existing installations).';

  static description =
    'Seed only runs on new installations. This command first applies upgrade-r020 (inventory.* to the warehouse keeper) and upgrade-r021 (order grants and warehouse read-only to purchase and sales), then adds the page grants "stock", "inboundOrders", "outboundOrders" and "warehouses" to the warehouse keeper and "warehouses" to purchase and sales. It never touches other roles or changes grants that already exist. Idempotent: a second run writes nothing and leaves revisions alone. A role the grant steps report missing or invalid is skipped as a whole, page grants included. Writes carry the revision that was read: a concurrent edit is reported instead of overwritten. Reload and rerun after a conflict.';

  static examples = ['<%= config.bin %> <%= command.id %>'];

  async run(): Promise<R020PageUpgradeReport> {
    await this.parse(AuthzUpgradeR020Page);
    return this.withApp(async ({ app }) => {
      await app.start();
      const { authorizationToken } =
        await import('@nocobase/app-plugin-authorization/server');
      const services: R020PageUpgradeServices = {
        authorization: app.container.resolve(authorizationToken) as unknown as R020PageUpgradeServices['authorization'],
      };
      return await upgradeR020Page(services, {
        info: (message) => this.log(message),
      });
    });
  }
}
