import type { AppAuthorization } from '@nocobase/app-plugin-authorization';
import { AppCommand } from '@nocobase/app-cli';
import {
  PermissionSetConflictError,
  type CreatePermissionSetInput,
} from '@nocobase/authorization/permission-sets';

/**
 * R-021/R-022 的升级步骤：`pnpm nocobase authz upgrade-r021`。
 *
 * seed 只对新建环境生效；已有环境里的采购、销售拿不到订单授权与只读引用。
 * 这条命令逐个角色补三份授权（订单六动作、items.view、inventory.warehouseView），
 * 只加不改、不碰别的角色、不补角色指派。
 *
 * 「已有」必须整份授权的所有动作都能按当前声明展开；带条件展不开的不算已有。
 * 三份里只要有一份声明对不上，这个角色整条跳过、不写库。写入带读到的 revision：
 * 读到之后有人改过角色就报错退出、重载重跑，不覆盖别人的改动。
 */
export const PURCHASE_TARGET = 'purchase';
export const SALES_TARGET = 'sales';
export const TARGETS = [PURCHASE_TARGET, SALES_TARGET] as const;

const ORDER_ACTIONS = ['view', 'create', 'update', 'submit', 'cancel'] as const;
export const PURCHASE_ORDER_ACTIONS = [...ORDER_ACTIONS, 'createReceipt'] as const;
export const SALES_ORDER_ACTIONS = [...ORDER_ACTIONS, 'createIssue'] as const;

export interface UpgradeLogger {
  info(message: string): void;
}

export interface R021UpgradeReport {
  readonly targets: readonly string[];
  readonly changed: readonly string[];
  readonly unchanged: readonly string[];
  readonly missing: readonly string[];
  readonly invalid: readonly string[];
}

export interface R021UpgradeServices {
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

/** 与 seed 的 purchaseOrderGrant / salesOrderGrant / orderItemRead / orderWarehouseRead 一致。 */
export function neededGrants(target: string): StoredGrant[] {
  if (target === PURCHASE_TARGET) {
    return [
      grant('purchaseOrders', PURCHASE_ORDER_ACTIONS),
      grant('items', ['view']),
      grant('inventory', ['warehouseView']),
    ];
  }
  return [
    grant('salesOrders', SALES_ORDER_ACTIONS),
    grant('items', ['view']),
    grant('inventory', ['warehouseView']),
  ];
}

function validateGrant(
  authz: R021UpgradeServices['authorization'],
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

/** 整份授权的所有动作都能展开才算已有；只看动作名会把展不开的授权误判成已补。 */
function hasEffectiveGrant(
  authz: R021UpgradeServices['authorization'],
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
  authz: R021UpgradeServices['authorization'],
  key: string,
  set: StoredSet,
  grants: CreatePermissionSetInput['grants'],
  logger: UpgradeLogger,
): Promise<void> {
  if (set.revision === undefined) {
    logger.info(`[r021] ${key}: no revision on the stored set; refusing to overwrite; nothing written`);
    throw new Error(`[r021] ${key}: permission set has no revision; reload and rerun`);
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
        ? `[r021] ${key}: 读后被改过（revision changed since it was read）; nothing written; 重载重跑（reload and rerun）`
        : `[r021] ${key}: update failed; nothing written; reload and rerun`,
    );
    throw error;
  }
}

const DESCRIBED = ['purchaseOrders', 'salesOrders', 'items', 'inventory'] as const;

function describe(grants: readonly StoredGrant[]): string {
  return grants
    .filter((entry) => DESCRIBED.some((id) => id === entry.resource.id))
    .flatMap((entry) => entry.actions.map((action) => `${entry.resource.id}/${action.action}`))
    .join('; ');
}

export async function upgradeR021(
  services: R021UpgradeServices,
  logger: UpgradeLogger,
): Promise<R021UpgradeReport> {
  const { authorization: authz } = services;
  const changed: string[] = [];
  const unchanged: string[] = [];
  const missing: string[] = [];
  const invalid: string[] = [];
  const sets = await authz.permissionSets.list();

  for (const target of TARGETS) {
    const set = sets.find((entry) => entry.key === target);
    if (!set) {
      logger.info(`[r021] ${target}: not found; skipped`);
      missing.push(target);
      continue;
    }
    const needed = neededGrants(target);
    const problem = needed
      .map((candidate) => validateGrant(authz, candidate))
      .find((entry) => entry !== undefined);
    if (problem !== undefined) {
      logger.info(`[r021] ${target}: declaration mismatch: ${problem}; nothing written`);
      invalid.push(target);
      continue;
    }
    const stored = structuredClone(set.grants) as unknown as StoredGrant[];
    logger.info(`[r021] ${target} before: ${describe(stored)}`);
    const absent = needed.filter((candidate) => !hasEffectiveGrant(authz, stored, candidate));
    if (absent.length === 0) {
      logger.info(`[r021] ${target}: already has all order grants; nothing written`);
      unchanged.push(target);
      continue;
    }
    const grants = [...stored, ...absent] as unknown as CreatePermissionSetInput['grants'];
    await updateWithRevision(authz, target, set as StoredSet, grants, logger);
    const saved = await authz.permissionSets.get(target);
    logger.info(
      `[r021] ${target} after: ${describe(
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

export default class AuthzUpgradeR021 extends AppCommand {
  static summary = 'Give the purchase and sales permission sets order access (existing installations).';

  static description =
    'Seed only runs on new installations. This command adds the purchaseOrders / salesOrders grants and the read-only item/warehouse grants to the purchase and sales sets and nothing else: no stock document write, no page grant, no other role and no user assignment. Effective grants are left exactly as they are; a conditional grant that cannot expand does not count as already granted. Idempotent: a second run writes nothing and leaves the revision alone. Writes carry the revision that was read, so a concurrent edit is reported instead of overwritten. Reload and rerun after a conflict.';

  static examples = ['<%= config.bin %> <%= command.id %>'];

  async run(): Promise<R021UpgradeReport> {
    await this.parse(AuthzUpgradeR021);
    return this.withApp(async ({ app }) => {
      await app.start();
      const { authorizationToken } =
        await import('@nocobase/app-plugin-authorization/server');
      const services: R021UpgradeServices = {
        authorization: app.container.resolve(authorizationToken) as unknown as R021UpgradeServices['authorization'],
      };
      return await upgradeR021(services, { info: (message) => this.log(message) });
    });
  }
}
