import type { AppAuthorization } from '@nocobase/app-plugin-authorization';
import { AppCommand } from '@nocobase/app-cli';
import {
  PermissionSetConflictError,
  type CreatePermissionSetInput,
} from '@nocobase/authorization/permission-sets';

/**
 * R-076 的升级步骤：`pnpm nocobase authz upgrade-r076`。
 *
 * seed 只对新建环境生效；已有环境的三个角色拿不到打印授权。这条命令按最窄粒度补：
 * - warehouse 拿三种单的 print，不给 printPrice；
 * - purchase 拿采购入库的 print + printPrice；
 * - sales 拿销售出库的 print + printPrice。
 * 不建角色、不给别的角色加授权、不补用户指派。每一条授权单独判「已有」，能按当前
 * 声明展开才算已有；带条件展不开的同名授权不算，另加一条正确的。
 * 写入带读到的 revision：读到之后有人改过角色就报错退出、重载重跑，不覆盖别人的改动。
 * 声明对不上时该角色整条跳过、不写库。幂等：第二遍什么都不写，revision 也不变。
 */
export const DOC_PRINT_RESOURCES = [
  'docPrintInternalIssue',
  'docPrintSalesIssue',
  'docPrintPurchaseReceipt',
] as const;

export interface DocPrintRequirement {
  readonly resource: string;
  readonly actions: readonly string[];
}

/** 与种子文件逐字一致的需要补的授权。 */
export const REQUIREMENTS: Readonly<Record<string, readonly DocPrintRequirement[]>> = {
  warehouse: [
    { resource: 'docPrintInternalIssue', actions: ['print'] },
    { resource: 'docPrintSalesIssue', actions: ['print'] },
    { resource: 'docPrintPurchaseReceipt', actions: ['print'] },
  ],
  purchase: [{ resource: 'docPrintPurchaseReceipt', actions: ['print', 'printPrice'] }],
  sales: [{ resource: 'docPrintSalesIssue', actions: ['print', 'printPrice'] }],
};

export interface UpgradeLogger {
  info(message: string): void;
}

export interface R076UpgradeReport {
  readonly targets: readonly string[];
  readonly changed: readonly string[];
  readonly unchanged: readonly string[];
  readonly missing: readonly string[];
  readonly invalid: readonly string[];
}

export interface R076UpgradeServices {
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

export function grantsFor(role: string): StoredGrant[] {
  return (REQUIREMENTS[role] ?? []).map((requirement) => ({
    resource: { type: 'composite', id: requirement.resource },
    actions: requirement.actions.map((action) => ({ action })),
  }));
}

function validateGrant(
  authz: R076UpgradeServices['authorization'],
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
    if (problem !== undefined) return problem;
  }
  return undefined;
}

function hasEffective(
  authz: R076UpgradeServices['authorization'],
  grants: readonly StoredGrant[],
  needed: StoredGrant,
): boolean {
  return grants.some(
    (grant) =>
      grant.resource.type === needed.resource.type &&
      grant.resource.id === needed.resource.id &&
      needed.actions.every((action) =>
        grant.actions.some(
          (entry) =>
            entry.action === action.action &&
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
  authz: R076UpgradeServices['authorization'],
  key: string,
  set: StoredSet,
  grants: CreatePermissionSetInput['grants'],
  logger: UpgradeLogger,
): Promise<void> {
  if (set.revision === undefined) {
    logger.info(`[r076] ${key}: no revision on the stored set; refusing to overwrite; nothing written`);
    throw new Error(`[r076] ${key}: permission set has no revision; reload and rerun`);
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
        ? `[r076] ${key}: 读后被改过（revision changed since it was read）; nothing written; 重载重跑（reload and rerun）`
        : `[r076] ${key}: update failed; nothing written; reload and rerun`,
    );
    throw error;
  }
}

function describe(grants: readonly StoredGrant[]): string {
  return grants
    .filter((grant) => DOC_PRINT_RESOURCES.includes(grant.resource.id as (typeof DOC_PRINT_RESOURCES)[number]))
    .flatMap((grant) => grant.actions.map((entry) => `${grant.resource.id}/${entry.action}`))
    .join('; ');
}

export async function upgradeR076(
  services: R076UpgradeServices,
  logger: UpgradeLogger,
): Promise<R076UpgradeReport> {
  const { authorization: authz } = services;
  const sets = await authz.permissionSets.list();
  const report: {
    targets: string[]; changed: string[]; unchanged: string[]; missing: string[]; invalid: string[];
  } = { targets: [], changed: [], unchanged: [], missing: [], invalid: [] };

  for (const key of Object.keys(REQUIREMENTS)) {
    report.targets.push(key);
    const set = sets.find((entry) => entry.key === key);
    if (!set) {
      logger.info(`[r076] ${key}: not found; skipped`);
      report.missing.push(key);
      continue;
    }
    const needed = grantsFor(key);
    const problem = needed.map((grant) => validateGrant(authz, grant)).find((value) => value !== undefined);
    if (problem !== undefined) {
      logger.info(`[r076] ${key}: declaration mismatch: ${problem}; nothing written`);
      report.invalid.push(key);
      continue;
    }
    const grants = structuredClone(set.grants) as unknown as StoredGrant[];
    logger.info(`[r076] ${key} before: ${describe(grants)}`);
    const additions = needed.filter((grant) => !hasEffective(authz, grants, grant));
    if (additions.length === 0) {
      logger.info(`[r076] ${key}: already has all print grants; nothing written`);
      report.unchanged.push(key);
      continue;
    }
    grants.push(...additions);
    await updateWithRevision(authz, key, set as StoredSet, grants as unknown as CreatePermissionSetInput['grants'], logger);
    const saved = await authz.permissionSets.get(key);
    logger.info(`[r076] ${key} after: ${describe(structuredClone(saved?.grants ?? []) as unknown as StoredGrant[])}`);
    report.changed.push(key);
  }

  return report;
}

export default class AuthzUpgradeR076 extends AppCommand {
  static summary = 'Give warehouse, purchase and sales the R-076 document print grants (existing installations).';

  static description =
    'Seed only runs on new installations. This command adds the narrowest print grants to three existing roles and nothing else: warehouse gets print on three document types without printPrice; purchase gets print and printPrice on purchase receipts; sales gets print and printPrice on sales issues. No new role, no other role, no user assignment, no delete action. Each grant is only added when it cannot be expanded from the current declarations. Idempotent: a second run writes nothing. Writes carry the revision that was read, so a concurrent edit is reported instead of overwritten. Reload and rerun after a conflict.';

  static examples = ['<%= config.bin %> <%= command.id %>'];

  async run(): Promise<R076UpgradeReport> {
    await this.parse(AuthzUpgradeR076);
    return this.withApp(async ({ app }) => {
      await app.start();
      const { authorizationToken } =
        await import('@nocobase/app-plugin-authorization/server');
      const services: R076UpgradeServices = {
        authorization: app.container.resolve(authorizationToken) as unknown as R076UpgradeServices['authorization'],
      };
      return await upgradeR076(services, { info: (message) => this.log(message) });
    });
  }
}
