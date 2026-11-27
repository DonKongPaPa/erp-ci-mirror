import type { AppAuthorization } from '@nocobase/app-plugin-authorization';
import { AppCommand } from '@nocobase/app-cli';
import {
  PermissionSetConflictError,
  type CreatePermissionSetInput,
} from '@nocobase/authorization/permission-sets';

/**
 * R-021/R-022 加片的升级步骤：`pnpm nocobase authz upgrade-r021-price`。
 *
 * seed 只对新建环境生效；已有环境里的采购、销售拿不到新拆出来的价格动作。
 * 这条命令给 purchase 补 purchaseOrders.viewPrice、给 sales 补 salesOrders.viewPrice，
 * 不碰 warehouse、不碰别的角色、不补角色指派、不改既有授权。
 *
 * 照 upgrade-r021 的规矩：声明对不上整条跳过；已有必须能按当前声明展开才算；
 * 写入带读到的 revision，读到之后有人改过就报错退出、重载重跑，不覆盖别人的改动。
 */
export const PURCHASE_TARGET = 'purchase';
export const SALES_TARGET = 'sales';
export const TARGETS = [PURCHASE_TARGET, SALES_TARGET] as const;
export const PRICE_ACTION = 'viewPrice';

export interface UpgradeLogger {
  info(message: string): void;
}

export interface R021PriceUpgradeReport {
  readonly targets: readonly string[];
  readonly changed: readonly string[];
  readonly unchanged: readonly string[];
  readonly missing: readonly string[];
  readonly invalid: readonly string[];
}

export interface R021PriceUpgradeServices {
  readonly authorization: Pick<AppAuthorization, 'permissionSets' | 'compositeResources'>;
}

interface StoredGrantAction {
  action: string;
  policy?: { type: string; scopes?: Record<string, unknown> };
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

const grant = (id: string, actions: readonly string[]): StoredGrant => ({
  resource: { type: 'composite', id },
  actions: actions.map((action) => ({ action })),
});

/** 与 seed 的 purchaseOrderPriceView / salesOrderPriceView 一致。 */
export function neededGrants(target: string): StoredGrant[] {
  return [
    grant(target === PURCHASE_TARGET ? 'purchaseOrders' : 'salesOrders', [PRICE_ACTION]),
  ];
}

function validateGrant(
  authz: R021PriceUpgradeServices['authorization'],
  candidate: StoredGrant,
): string | undefined {
  for (const action of candidate.actions) {
    if (!authz.compositeResources.getAction(candidate.resource.id, action.action)) {
      return `unknown ${candidate.resource.id} action ${action.action}`;
    }
    const problem = authz.compositeResources.validateGrant({
      resource: candidate.resource,
      action: action.action,
      policy: action.policy,
    });
    if (problem !== undefined) return problem;
  }
  return undefined;
}

/** 只看能按当前声明展开的授权；带展开不了的条件不算已经补过。 */
function hasEffectiveGrant(
  authz: R021PriceUpgradeServices['authorization'],
  stored: readonly StoredGrant[],
  candidate: StoredGrant,
): boolean {
  return stored.some(
    (entry) =>
      entry.resource.type === candidate.resource.type &&
      entry.resource.id === candidate.resource.id &&
      candidate.actions.every((action) =>
        entry.actions.some(
          (have) =>
            have.action === action.action &&
            authz.compositeResources.validateGrant({
              resource: candidate.resource,
              action: have.action,
              policy: have.policy,
            }) === undefined,
        ),
      ),
  );
}

async function updateWithRevision(
  authz: R021PriceUpgradeServices['authorization'],
  key: string,
  set: StoredSet,
  grants: CreatePermissionSetInput['grants'],
  logger: UpgradeLogger,
): Promise<void> {
  if (set.revision === undefined) {
    logger.info(
      `[r021-price] ${key}: no revision on the stored set; refusing to overwrite; nothing written`,
    );
    throw new Error(`[r021-price] ${key}: permission set has no revision; reload and rerun`);
  }
  try {
    await authz.permissionSets.update(
      key,
      { key, ...(set.title === undefined ? {} : { title: set.title }), grants },
      set.revision,
    );
  } catch (error) {
    logger.info(
      error instanceof PermissionSetConflictError
        ? `[r021-price] ${key}: 读后被改过（revision changed since it was read）; nothing written; 重载重跑（reload and rerun）`
        : `[r021-price] ${key}: update failed; nothing written; reload and rerun`,
    );
    throw error;
  }
}

function describe(grants: readonly StoredGrant[]): string {
  return grants
    .filter((entry) => ['purchaseOrders', 'salesOrders'].includes(entry.resource.id))
    .flatMap((entry) => entry.actions.map((action) => `${entry.resource.id}/${action.action}`))
    .join('; ');
}

export async function upgradeR021Price(
  services: R021PriceUpgradeServices,
  logger: UpgradeLogger,
): Promise<R021PriceUpgradeReport> {
  const { authorization: authz } = services;
  const changed: string[] = [];
  const unchanged: string[] = [];
  const missing: string[] = [];
  const invalid: string[] = [];
  const sets = await authz.permissionSets.list();

  for (const target of TARGETS) {
    const set = sets.find((entry) => entry.key === target);
    if (!set) {
      logger.info(`[r021-price] ${target}: not found; skipped`);
      missing.push(target);
      continue;
    }
    const needed = neededGrants(target);
    const problem = needed
      .map((candidate) => validateGrant(authz, candidate))
      .find((entry) => entry !== undefined);
    if (problem !== undefined) {
      logger.info(`[r021-price] ${target}: declaration mismatch: ${problem}; nothing written`);
      invalid.push(target);
      continue;
    }
    const stored = structuredClone(set.grants) as unknown as StoredGrant[];
    logger.info(`[r021-price] ${target} before: ${describe(stored)}`);
    const absent = needed.filter((candidate) => !hasEffectiveGrant(authz, stored, candidate));
    if (absent.length === 0) {
      logger.info(`[r021-price] ${target}: already has the order price action; nothing written`);
      unchanged.push(target);
      continue;
    }
    const grants = [...stored, ...absent] as unknown as CreatePermissionSetInput['grants'];
    await updateWithRevision(authz, target, set as StoredSet, grants, logger);
    const saved = await authz.permissionSets.get(target);
    logger.info(
      `[r021-price] ${target} after: ${describe(
        structuredClone(saved?.grants ?? []) as unknown as StoredGrant[],
      )}`,
    );
    changed.push(target);
  }

  return {
    targets: [...TARGETS],
    changed,
    unchanged,
    missing,
    invalid,
  };
}

export default class AuthzUpgradeR021Price extends AppCommand {
  static summary = 'Give the purchase and sales permission sets the order price-view action (existing installations).';

  static description =
    'Seed only runs on new installations. This command grants purchaseOrders.viewPrice to purchase and salesOrders.viewPrice to sales and nothing else: no item price, no other role, no other action, no user assignment. Effective grants are left exactly as they are; a conditional grant that cannot expand does not count as already granted. Idempotent: a second run writes nothing and leaves the revision alone. Writes carry the revision that was read, so a concurrent edit is reported instead of overwritten. Reload and rerun after a conflict.';

  static examples = ['<%= config.bin %> <%= command.id %>'];

  async run(): Promise<R021PriceUpgradeReport> {
    await this.parse(AuthzUpgradeR021Price);
    return this.withApp(async ({ app }) => {
      await app.start();
      const { authorizationToken } =
        await import('@nocobase/app-plugin-authorization/server');
      const services: R021PriceUpgradeServices = {
        authorization: app.container.resolve(authorizationToken) as unknown as R021PriceUpgradeServices['authorization'],
      };
      return await upgradeR021Price(services, { info: (message) => this.log(message) });
    });
  }
}
