import type { AppAuthorization } from '@nocobase/app-plugin-authorization';
import { AppCommand } from '@nocobase/app-cli';
import {
  PermissionSetConflictError,
  type CreatePermissionSetInput,
} from '@nocobase/authorization/permission-sets';

/**
 * R-020 的升级步骤：`pnpm nocobase authz upgrade-r020`。
 *
 * seed 只对新建环境生效；已有环境里的仓管拿不到库存授权。这条命令只做一件事：
 * 给 `warehouse` 补一条 `inventory` 授权，含五个动作（仓库读、单据读写、过账、作废），
 * 不补 `warehouseManage`（建改仓库只给 root），不给别的角色加授权，也不补角色指派。
 *
 * 「已有」必须五个动作都能按当前声明展开；带条件展不开的不算已有，另加一条正确的。
 * 写入带读到的 revision：读到之后有人改过角色就报错退出、重载重跑，不覆盖别人的改动。
 * 声明对不上时整条跳过、不写库（硬塞没声明的动作会让启动扫描拒掉整份授权）。
 */
export const INVENTORY_RESOURCE = 'inventory';
export const WAREHOUSE_PERMISSION_SET = 'warehouse';
export const WAREHOUSE_ACTIONS = [
  'warehouseView',
  'stockView',
  'stockWrite',
  'stockPost',
  'stockVoid',
] as const;

export interface UpgradeLogger {
  info(message: string): void;
}

export interface R020UpgradeReport {
  readonly targets: readonly string[];
  readonly changed: readonly string[];
  readonly unchanged: readonly string[];
  readonly missing: readonly string[];
  readonly invalid: readonly string[];
}

export interface R020UpgradeServices {
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

/** 形状与 seed 的 `inventoryGrant` 一致：这张表没有记录范围键，授权不带 policy。 */
export function inventoryGrant(): StoredGrant {
  return {
    resource: { type: 'composite', id: INVENTORY_RESOURCE },
    actions: WAREHOUSE_ACTIONS.map((action) => ({ action })),
  };
}

function validateInventoryGrant(
  authz: R020UpgradeServices['authorization'],
  grant: StoredGrant,
): string | undefined {
  for (const action of grant.actions) {
    if (!authz.compositeResources.getAction(INVENTORY_RESOURCE, action.action)) {
      return `unknown ${INVENTORY_RESOURCE} action ${action.action}`;
    }
    const problem = authz.compositeResources.validateGrant({
      resource: grant.resource,
      action: action.action,
      policy: action.policy,
    });
    if (problem !== undefined) return problem;
  }
  return undefined;
}

/** 五个动作都有效才算已有；只看动作名会把展不开的授权误判成已补。 */
function hasEffectiveGrant(
  authz: R020UpgradeServices['authorization'],
  grants: readonly StoredGrant[],
): boolean {
  return grants.some(
    (grant) =>
      grant.resource.type === 'composite' &&
      grant.resource.id === INVENTORY_RESOURCE &&
      WAREHOUSE_ACTIONS.every((action) =>
        grant.actions.some(
          (entry) =>
            entry.action === action &&
            authz.compositeResources.validateGrant({
              resource: grant.resource,
              action: entry.action,
              policy: entry.policy,
            }) === undefined,
        ),
      ),
  );
}

async function updateWithRevision(
  authz: R020UpgradeServices['authorization'],
  key: string,
  set: StoredSet,
  grants: CreatePermissionSetInput['grants'],
  logger: UpgradeLogger,
): Promise<void> {
  if (set.revision === undefined) {
    logger.info(`[r020] ${key}: no revision on the stored set; refusing to overwrite; nothing written`);
    throw new Error(`[r020] ${key}: permission set has no revision; reload and rerun`);
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
        ? `[r020] ${key}: 读后被改过（revision changed since it was read）; nothing written; 重载重跑（reload and rerun）`
        : `[r020] ${key}: update failed; nothing written; reload and rerun`,
    );
    throw error;
  }
}

function describe(grants: readonly StoredGrant[]): string {
  return grants
    .filter(
      (grant) =>
        grant.resource.type === 'composite' &&
        grant.resource.id === INVENTORY_RESOURCE,
    )
    .flatMap((grant) =>
      grant.actions.map((entry) => `${grant.resource.id}/${entry.action}`),
    )
    .join('; ');
}

export async function upgradeR020(
  services: R020UpgradeServices,
  logger: UpgradeLogger,
): Promise<R020UpgradeReport> {
  const { authorization: authz } = services;
  const sets = await authz.permissionSets.list();
  const set = sets.find((entry) => entry.key === WAREHOUSE_PERMISSION_SET);
  if (!set) {
    logger.info(`[r020] ${WAREHOUSE_PERMISSION_SET}: not found; skipped`);
    return {
      targets: [WAREHOUSE_PERMISSION_SET],
      changed: [], unchanged: [], missing: [WAREHOUSE_PERMISSION_SET], invalid: [],
    };
  }

  const before = structuredClone(set.grants) as unknown as StoredGrant[];
  logger.info(`[r020] ${WAREHOUSE_PERMISSION_SET} before: ${describe(before)}`);
  const needed = inventoryGrant();
  const problem = validateInventoryGrant(authz, needed);
  if (problem !== undefined) {
    logger.info(`[r020] ${WAREHOUSE_PERMISSION_SET}: declaration mismatch: ${problem}; nothing written`);
    return {
      targets: [WAREHOUSE_PERMISSION_SET],
      changed: [], unchanged: [], missing: [], invalid: [WAREHOUSE_PERMISSION_SET],
    };
  }

  const grants = structuredClone(set.grants) as unknown as StoredGrant[];
  if (hasEffectiveGrant(authz, grants)) {
    logger.info(`[r020] ${WAREHOUSE_PERMISSION_SET}: already has ${INVENTORY_RESOURCE} grant; nothing written`);
    return {
      targets: [WAREHOUSE_PERMISSION_SET],
      changed: [], unchanged: [WAREHOUSE_PERMISSION_SET], missing: [], invalid: [],
    };
  }
  grants.push(needed);
  await updateWithRevision(
    authz,
    WAREHOUSE_PERMISSION_SET,
    set as StoredSet,
    grants as unknown as CreatePermissionSetInput['grants'],
    logger,
  );
  const saved = await authz.permissionSets.get(WAREHOUSE_PERMISSION_SET);
  logger.info(
    `[r020] ${WAREHOUSE_PERMISSION_SET} after: ${describe(
      structuredClone(saved?.grants ?? []) as unknown as StoredGrant[],
    )}`,
  );
  return {
    targets: [WAREHOUSE_PERMISSION_SET],
    changed: [WAREHOUSE_PERMISSION_SET],
    unchanged: [], missing: [], invalid: [],
  };
}

export default class AuthzUpgradeR020 extends AppCommand {
  static summary = 'Give the warehouse permission set inventory access (existing installations).';

  static description =
    'Seed only runs on new installations. This command adds one inventory grant with five actions to the warehouse set and nothing else: no warehouseManage, no page grant, no other role and no user assignment. An effective grant is left exactly as it is; a conditional grant that cannot expand does not count as already granted. Idempotent: a second run writes nothing and leaves the revision alone. Writes carry the revision that was read, so a concurrent edit is reported instead of overwritten. Reload and rerun after a conflict.';

  static examples = ['<%= config.bin %> <%= command.id %>'];

  async run(): Promise<R020UpgradeReport> {
    await this.parse(AuthzUpgradeR020);
    return this.withApp(async ({ app }) => {
      await app.start();
      const { authorizationToken } =
        await import('@nocobase/app-plugin-authorization/server');
      const services: R020UpgradeServices = {
        authorization: app.container.resolve(authorizationToken) as unknown as R020UpgradeServices['authorization'],
      };
      return await upgradeR020(services, { info: (message) => this.log(message) });
    });
  }
}
