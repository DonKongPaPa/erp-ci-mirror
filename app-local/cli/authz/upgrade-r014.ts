import type { AppAuthorization } from '@nocobase/app-plugin-authorization';
import { AppCommand } from '@nocobase/app-cli';
import {
  PermissionSetConflictError,
  type CreatePermissionSetInput,
} from '@nocobase/authorization/permission-sets';

/**
 * R-014 的升级步骤：`pnpm nocobase authz upgrade-r014`。
 *
 * seed 只对新建环境生效；已有环境里的销售、采购拿不到客户/供应商授权。这条命令
 * 只给 `sales` 补 `customers.*`、给 `purchase` 补 `suppliers.*`，三个动作一条授权：
 * 不补页面授权（页面由前端片登记）、不给其它角色加、不改已有授权。
 *
 * 只加不改：已有的、能按当前声明展开的授权原样留着；带条件且展开不了的同名授权
 * 不算「已有」，另加一条正确的。幂等：第二次什么都不写，revision 也不变。
 * 写入带读到的 revision：读到之后有人改过角色就报错退出、重载重跑，不覆盖别人的改动。
 * 写之前按当前声明核对每个动作；任何一个对不上就整个角色跳过、不写库。
 */
export const CUSTOMERS_RESOURCE = 'customers';
export const SUPPLIERS_RESOURCE = 'suppliers';
export const SALES_PERMISSION_SET = 'sales';
export const PURCHASE_PERMISSION_SET = 'purchase';
export const PARTNER_ACTIONS = ['view', 'create', 'update'] as const;

/** 每个角色对应的资源。 */
const TARGETS: Readonly<
  Record<typeof SALES_PERMISSION_SET | typeof PURCHASE_PERMISSION_SET, string>
> = {
  [SALES_PERMISSION_SET]: CUSTOMERS_RESOURCE,
  [PURCHASE_PERMISSION_SET]: SUPPLIERS_RESOURCE,
};

export interface UpgradeLogger {
  info(message: string): void;
}

export interface R014UpgradeReport {
  readonly targets: readonly string[];
  readonly changed: readonly string[];
  readonly unchanged: readonly string[];
  readonly missing: readonly string[];
  /** 因为声明对不上而整个跳过的角色。 */
  readonly invalid: readonly string[];
}

export interface R014UpgradeServices {
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

/** 形状与 seed 的 `partnerGrant` 一致：数据范围初期用全部，不带 policy。 */
export function partnerGrant(
  resource: string,
  actions: readonly string[] = PARTNER_ACTIONS,
): StoredGrant {
  return {
    resource: { type: 'composite', id: resource },
    actions: actions.map((action) => ({ action })),
  };
}

/** 声明核对：动作必须存在，整条授权还得能被服务层展开。 */
function validatePartnerGrant(
  authz: R014UpgradeServices['authorization'],
  grant: StoredGrant,
): string | undefined {
  for (const action of grant.actions) {
    if (!authz.compositeResources.getAction(grant.resource.id, action.action)) {
      return `unknown ${grant.resource.id} action ${action.action}`;
    }
    const problem = authz.compositeResources.validateGrant({
      resource: grant.resource,
      action: action.action,
      policy: action.policy,
    });
    if (problem !== undefined) {
      return problem;
    }
  }
  return undefined;
}

/** 「已有」必须是三个动作都能按当前声明展开的授权，只看资源名会误判。 */
function hasEffectiveGrant(
  authz: R014UpgradeServices['authorization'],
  grants: readonly StoredGrant[],
  needed: StoredGrant,
): boolean {
  return grants.some((grant) => {
    if (
      grant.resource.type !== needed.resource.type ||
      grant.resource.id !== needed.resource.id
    ) {
      return false;
    }
    return needed.actions.every((entry) =>
      grant.actions.some(
        (candidate) =>
          candidate.action === entry.action &&
          authz.compositeResources.validateGrant({
            resource: grant.resource,
            action: candidate.action,
            policy: candidate.policy,
          }) === undefined,
      ),
    );
  });
}

/** 带上读到的 revision，避免覆盖管理员在角色编辑器里同时做的改动。 */
async function updateWithRevision(
  authz: R014UpgradeServices['authorization'],
  key: string,
  set: StoredSet,
  grants: CreatePermissionSetInput['grants'],
  logger: UpgradeLogger,
): Promise<void> {
  if (set.revision === undefined) {
    logger.info(`[r014] ${key}: no revision on the stored set; refusing to overwrite; nothing written`);
    throw new Error(`[r014] ${key}: permission set has no revision; reload and rerun`);
  }
  try {
    await authz.permissionSets.update(
      key,
      {
        key,
        ...(set.title === undefined ? {} : { title: set.title }),
        grants,
      },
      set.revision,
    );
  } catch (error) {
    logger.info(
      error instanceof PermissionSetConflictError
        ? `[r014] ${key}: 读后被改过（revision changed since it was read）; nothing written; 重载重跑（reload and rerun）`
        : `[r014] ${key}: update failed; nothing written; reload and rerun`,
    );
    throw error;
  }
}

function describe(grants: readonly StoredGrant[]): string {
  return grants
    .filter((grant) =>
      [CUSTOMERS_RESOURCE, SUPPLIERS_RESOURCE].includes(grant.resource.id),
    )
    .flatMap((grant) =>
      grant.actions.map((entry) => `${grant.resource.id}/${entry.action}`),
    )
    .join('; ');
}

export async function upgradeR014(
  services: R014UpgradeServices,
  logger: UpgradeLogger,
): Promise<R014UpgradeReport> {
  const { authorization: authz } = services;
  const sets = await authz.permissionSets.list();
  const changed: string[] = [];
  const unchanged: string[] = [];
  const missing: string[] = [];
  const invalid: string[] = [];

  for (const [key, resource] of Object.entries(TARGETS)) {
    const set = sets.find((entry) => entry.key === key);
    if (!set) {
      missing.push(key);
      logger.info(`[r014] ${key}: not found; skipped`);
      continue;
    }
    logger.info(
      `[r014] ${key} before: ${describe(
        structuredClone(set.grants) as unknown as StoredGrant[],
      )}`,
    );
    const needed = partnerGrant(resource);
    const problem = validatePartnerGrant(authz, needed);
    if (problem !== undefined) {
      invalid.push(key);
      logger.info(`[r014] ${key}: declaration mismatch: ${problem}; nothing written`);
      continue;
    }
    const grants = structuredClone(set.grants) as unknown as StoredGrant[];
    if (hasEffectiveGrant(authz, grants, needed)) {
      unchanged.push(key);
      logger.info(`[r014] ${key}: already has ${resource} actions; nothing written`);
      continue;
    }
    grants.push(needed);
    await updateWithRevision(
      authz,
      key,
      set as StoredSet,
      grants as unknown as CreatePermissionSetInput['grants'],
      logger,
    );
    const saved = await authz.permissionSets.get(key);
    logger.info(
      `[r014] ${key} after: ${describe(
        structuredClone(saved?.grants ?? []) as unknown as StoredGrant[],
      )}`,
    );
    changed.push(key);
  }

  logger.info(`[r014] added: ${changed.join(',') || '(none)'}`);
  logger.info(
    `[r014] skipped (already current): ${unchanged.join(',') || '(none)'}; ` +
      `missing: ${missing.join(',') || '(none)'}; ` +
      `invalid: ${invalid.join(',') || '(none)'}`,
  );
  return {
    targets: Object.keys(TARGETS),
    changed,
    unchanged,
    missing,
    invalid,
  };
}

export default class AuthzUpgradeR014 extends AppCommand {
  static summary =
    'Give the sales and purchase permission sets their customer and supplier grants (existing installations).';

  static description =
    'Seed only runs on new installations. This command adds customers.view/create/update to sales and suppliers.view/create/update to purchase, each as one grant with no data scope. It never adds page grants, touches other roles or changes grants that already expand under the current declaration. Idempotent: a second run writes nothing and leaves revisions alone. Writes carry the revision that was read: if someone edits a role in the meantime the command reports that the set was changed after reading and exits without writing; reload and rerun.';

  static examples = ['<%= config.bin %> <%= command.id %>'];

  async run(): Promise<R014UpgradeReport> {
    await this.parse(AuthzUpgradeR014);
    return this.withApp(async ({ app }) => {
      await app.start();
      const { authorizationToken } =
        await import('@nocobase/app-plugin-authorization/server');
      const services: R014UpgradeServices = {
        authorization: app.container.resolve(authorizationToken) as unknown as R014UpgradeServices['authorization'],
      };
      return await upgradeR014(services, { info: (message) => this.log(message) });
    });
  }
}
