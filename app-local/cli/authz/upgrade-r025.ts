import type { AppAuthorization } from '@nocobase/app-plugin-authorization';
import { AppCommand } from '@nocobase/app-cli';
import {
  PermissionSetConflictError,
  type CreatePermissionSetInput,
} from '@nocobase/authorization/permission-sets';

/**
 * R-025 的升级步骤：`pnpm nocobase authz upgrade-r025`。
 *
 * seed 只对新建环境生效；已有环境里的 `staff` 拿不到班次只读授权。这条命令只做一件事：
 * 给 `staff` 补 `shifts.view`。不补页面授权（班次页是管理页，默认只有 root），
 * 不补 `manage`（写只给 root），不给 `staff` 之外的角色加授权，也不补 `staff` 指派
 * （那是 R-026 的 upgrade-r026 与建人初始化器的事）。
 *
 * 只加不改：已有的、能按当前声明展开的授权原样留着；带条件且展开不了的同名授权
 * 不算「已有」，另加一条正确的。幂等：第二次什么都不写，revision 也不变。
 * 写入带读到的 revision：读到之后有人改过角色就报错退出、重载重跑，不覆盖别人的改动。
 */
export const SHIFTS_RESOURCE = 'shifts';
export const SHIFTS_VIEW_ACTION = 'view';
export const STAFF_PERMISSION_SET = 'staff';

export interface UpgradeLogger {
  info(message: string): void;
}

export interface R025UpgradeReport {
  readonly targets: readonly string[];
  readonly changed: readonly string[];
  readonly unchanged: readonly string[];
  readonly missing: readonly string[];
  readonly invalid: readonly string[];
}

export interface R025UpgradeServices {
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

/** 形状与 seed 的 `shiftsView` 一致：这张表没有记录范围键，授权不带 policy。 */
export function shiftsViewGrant(): StoredGrant {
  return {
    resource: { type: 'composite', id: SHIFTS_RESOURCE },
    actions: [{ action: SHIFTS_VIEW_ACTION }],
  };
}

/**
 * 写之前按当前声明核对：动作必须存在，授权必须能被服务层展开。
 * 对不上就整个跳过、不写库 —— 硬塞一条没声明的动作会让启动扫描拒掉整份授权。
 */
function validateShiftsGrant(
  authz: R025UpgradeServices['authorization'],
  grant: StoredGrant,
): string | undefined {
  const action = grant.actions[0]!;
  if (!authz.compositeResources.getAction(SHIFTS_RESOURCE, action.action)) {
    return `unknown ${SHIFTS_RESOURCE} action ${action.action}`;
  }
  return authz.compositeResources.validateGrant({
    resource: grant.resource,
    action: action.action,
    policy: action.policy,
  });
}

/** 「已有」必须是能按当前声明展开的授权，只看动作名会把无效授权误判成已补。 */
function hasEffectiveView(
  authz: R025UpgradeServices['authorization'],
  grants: readonly StoredGrant[],
): boolean {
  return grants.some(
    (grant) =>
      grant.resource.type === 'composite' &&
      grant.resource.id === SHIFTS_RESOURCE &&
      grant.actions.some(
        (entry) =>
          entry.action === SHIFTS_VIEW_ACTION &&
          authz.compositeResources.validateGrant({
            resource: grant.resource,
            action: entry.action,
            policy: entry.policy,
          }) === undefined,
      ),
  );
}

/** 带上读到的 revision，避免覆盖管理员在角色编辑器里同时做的改动。 */
async function updateWithRevision(
  authz: R025UpgradeServices['authorization'],
  key: string,
  set: StoredSet,
  grants: CreatePermissionSetInput['grants'],
  logger: UpgradeLogger,
): Promise<void> {
  if (set.revision === undefined) {
    logger.info(`[r025] ${key}: no revision on the stored set; refusing to overwrite; nothing written`);
    throw new Error(`[r025] ${key}: permission set has no revision; reload and rerun`);
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
        ? `[r025] ${key}: 读后被改过（revision changed since it was read）; nothing written; 重载重跑（reload and rerun）`
        : `[r025] ${key}: update failed; nothing written; reload and rerun`,
    );
    throw error;
  }
}

function describe(grants: readonly StoredGrant[]): string {
  return grants
    .filter(
      (grant) =>
        grant.resource.type === 'composite' &&
        grant.resource.id === SHIFTS_RESOURCE,
    )
    .flatMap((grant) =>
      grant.actions.map((entry) => {
        const keys = Object.keys(entry.policy?.scopes ?? {});
        return `${grant.resource.id}/${entry.action}${keys.length ? `[${keys.join(',')}]` : ''}`;
      }),
    )
    .join('; ');
}

export async function upgradeR025(
  services: R025UpgradeServices,
  logger: UpgradeLogger,
): Promise<R025UpgradeReport> {
  const { authorization: authz } = services;
  const sets = await authz.permissionSets.list();
  const set = sets.find((entry) => entry.key === STAFF_PERMISSION_SET);
  if (!set) {
    logger.info(`[r025] ${STAFF_PERMISSION_SET}: not found; skipped`);
    return {
      targets: [STAFF_PERMISSION_SET],
      changed: [],
      unchanged: [],
      missing: [STAFF_PERMISSION_SET],
      invalid: [],
    };
  }

  const before = structuredClone(set.grants) as unknown as StoredGrant[];
  logger.info(`[r025] ${STAFF_PERMISSION_SET} before: ${describe(before)}`);
  const needed = shiftsViewGrant();
  const problem = validateShiftsGrant(authz, needed);
  if (problem !== undefined) {
    logger.info(`[r025] ${STAFF_PERMISSION_SET}: declaration mismatch: ${problem}; nothing written`);
    return {
      targets: [STAFF_PERMISSION_SET],
      changed: [],
      unchanged: [],
      missing: [],
      invalid: [STAFF_PERMISSION_SET],
    };
  }

  const grants = structuredClone(set.grants) as unknown as StoredGrant[];
  if (hasEffectiveView(authz, grants)) {
    logger.info(`[r025] ${STAFF_PERMISSION_SET}: already has ${SHIFTS_RESOURCE}.${SHIFTS_VIEW_ACTION}; nothing written`);
    return {
      targets: [STAFF_PERMISSION_SET],
      changed: [],
      unchanged: [STAFF_PERMISSION_SET],
      missing: [],
      invalid: [],
    };
  }
  grants.push(needed);
  await updateWithRevision(
    authz,
    STAFF_PERMISSION_SET,
    set as StoredSet,
    grants as unknown as CreatePermissionSetInput['grants'],
    logger,
  );
  const saved = await authz.permissionSets.get(STAFF_PERMISSION_SET);
  logger.info(
    `[r025] ${STAFF_PERMISSION_SET} after: ${describe(
      structuredClone(saved?.grants ?? []) as unknown as StoredGrant[],
    )}`,
  );
  return {
    targets: [STAFF_PERMISSION_SET],
    changed: [STAFF_PERMISSION_SET],
    unchanged: [],
    missing: [],
    invalid: [],
  };
}

export default class AuthzUpgradeR025 extends AppCommand {
  static summary =
    'Give the staff permission set read-only access to shift definitions (existing installations).';

  static description =
    'Seed only runs on new installations. This command adds shifts.view to the staff permission set and nothing else: no manage grant, no page grant, no other role and no staff assignment (R-026 owns that). An effective grant is left exactly as it is; a conditional grant that cannot expand does not count as already granted. Idempotent: a second run writes nothing and leaves the revision alone. Writes carry the revision that was read, so a concurrent edit is reported instead of overwritten. Reload and rerun after a conflict.';

  static examples = ['<%= config.bin %> <%= command.id %>'];

  async run(): Promise<R025UpgradeReport> {
    await this.parse(AuthzUpgradeR025);
    return this.withApp(async ({ app }) => {
      await app.start();
      const { authorizationToken } =
        await import('@nocobase/app-plugin-authorization/server');
      const services: R025UpgradeServices = {
        authorization: app.container.resolve(authorizationToken) as unknown as R025UpgradeServices['authorization'],
      };
      return await upgradeR025(services, { info: (message) => this.log(message) });
    });
  }
}
