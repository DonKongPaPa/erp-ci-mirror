import type { AppAuthorization } from '@nocobase/app-plugin-authorization';
import { AppCommand } from '@nocobase/app-cli';
import {
  PermissionSetConflictError,
  type CreatePermissionSetInput,
} from '@nocobase/authorization/permission-sets';

/**
 * R-020 波 2 加片二：`pnpm nocobase authz upgrade-r020-returns`。
 *
 * 给已有环境的四个现成角色补退货动作：purchase / sales 发起，warehouse 过账，
 * finance 只读销售退货；仓管另拿两张单的 postView 窄读。不建角色、不动别的角色、不补用户指派。幂等、带 revision、
 * 声明对不上整条跳过；重跑不写，revision 不动。
 */
export const PURCHASE_TARGET = 'purchase';
export const SALES_TARGET = 'sales';
export const WAREHOUSE_TARGET = 'warehouse';
export const FINANCE_TARGET = 'finance';
export const TARGETS = [
  PURCHASE_TARGET, SALES_TARGET, WAREHOUSE_TARGET, FINANCE_TARGET,
] as const;

export interface UpgradeLogger { info(message: string): void; }
export interface R020ReturnsUpgradeReport {
  readonly targets: readonly string[];
  readonly changed: readonly string[];
  readonly unchanged: readonly string[];
  readonly missing: readonly string[];
  readonly invalid: readonly string[];
}
export interface R020ReturnsUpgradeServices {
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

/** 与种子 returnPermissionSets 逐条一致。 */
export function neededGrants(target: string): StoredGrant[] {
  if (target === PURCHASE_TARGET) return [grant('purchaseReturns', ['view', 'create', 'update', 'void'])];
  if (target === SALES_TARGET) return [grant('salesReturns', ['view', 'create', 'update', 'void'])];
  if (target === WAREHOUSE_TARGET) {
    return [
      grant('purchaseReturns', ['post']), grant('salesReturns', ['post']),
      grant('purchaseReturns', ['postView']), grant('salesReturns', ['postView']),
    ];
  }
  if (target === FINANCE_TARGET) return [grant('salesReturns', ['financeView'])];
  return [];
}

function validateGrant(
  authz: R020ReturnsUpgradeServices['authorization'],
  candidate: StoredGrant,
): string | undefined {
  for (const action of candidate.actions) {
    if (!authz.compositeResources.getAction(candidate.resource.id, action.action)) {
      return `unknown ${candidate.resource.id} action ${action.action}`;
    }
    const problem = authz.compositeResources.validateGrant({
      resource: candidate.resource, action: action.action, policy: action.policy,
    });
    if (problem !== undefined) return problem;
  }
  return undefined;
}

function hasEffectiveGrant(
  authz: R020ReturnsUpgradeServices['authorization'],
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
              resource: candidate.resource, action: have.action, policy: have.policy,
            }) === undefined,
        ),
      ),
  );
}

async function updateWithRevision(
  authz: R020ReturnsUpgradeServices['authorization'],
  target: string,
  set: StoredSet,
  grants: CreatePermissionSetInput['grants'],
  logger: UpgradeLogger,
): Promise<void> {
  if (set.revision === undefined) {
    logger.info(`[r020-returns] ${target}: no revision; refusing to overwrite; nothing written`);
    throw new Error(`[r020-returns] ${target}: permission set has no revision; reload and rerun`);
  }
  try {
    await authz.permissionSets.update(
      target,
      { key: target, ...(set.title === undefined ? {} : { title: set.title }), grants },
      set.revision,
    );
  } catch (error) {
    logger.info(
      error instanceof PermissionSetConflictError
        ? `[r020-returns] ${target}: revision changed since read; nothing written; reload and rerun`
        : `[r020-returns] ${target}: update failed; nothing written; reload and rerun`,
    );
    throw error;
  }
}

export async function upgradeR020Returns(
  services: R020ReturnsUpgradeServices,
  logger: UpgradeLogger,
): Promise<R020ReturnsUpgradeReport> {
  const { authorization: authz } = services;
  const changed: string[] = [];
  const unchanged: string[] = [];
  const missing: string[] = [];
  const invalid: string[] = [];
  const sets = await authz.permissionSets.list();
  for (const target of TARGETS) {
    const set = sets.find((entry) => entry.key === target);
    if (set === undefined) {
      missing.push(target);
      continue;
    }
    const needed = neededGrants(target);
    const problem = needed
      .map((candidate) => validateGrant(authz, candidate))
      .find((entry) => entry !== undefined);
    if (problem !== undefined) {
      logger.info(`[r020-returns] ${target}: declaration mismatch: ${problem}; nothing written`);
      invalid.push(target);
      continue;
    }
    const stored = structuredClone(set.grants) as unknown as StoredGrant[];
    const absent = needed.filter((candidate) => !hasEffectiveGrant(authz, stored, candidate));
    if (absent.length === 0) {
      logger.info(`[r020-returns] ${target}: already has all grants; nothing written`);
      unchanged.push(target);
      continue;
    }
    await updateWithRevision(
      authz, target, set as StoredSet,
      [...stored, ...absent] as unknown as CreatePermissionSetInput['grants'], logger,
    );
    changed.push(target);
  }
  return { targets: [...TARGETS], changed, unchanged, missing, invalid };
}

export default class AuthzUpgradeR020Returns extends AppCommand {
  static summary = 'Grant the purchase, sales, warehouse and finance roles the return actions (existing installations).';

  static description =
    'Seed only runs on new installations. This command adds purchaseReturns.view/create/update/void to purchase, the same four on salesReturns to sales, purchaseReturns.post/salesReturns.post and both postView narrow reads to warehouse, and salesReturns.financeView to finance. Nothing else: no new role, no other role, no user assignment, no existing grant rewritten. Idempotent: a second run writes nothing and leaves the revision alone. Writes carry the revision that was read. Reload and rerun after a conflict or a declaration mismatch.';

  static examples = ['<%= config.bin %> <%= command.id %>'];

  async run(): Promise<R020ReturnsUpgradeReport> {
    await this.parse(AuthzUpgradeR020Returns);
    return await this.withApp(async ({ app }) => {
      await app.start();
      const { authorizationToken } =
        await import('@nocobase/app-plugin-authorization/server');
      const services: R020ReturnsUpgradeServices = {
        authorization: app.container.resolve(authorizationToken) as unknown as R020ReturnsUpgradeServices['authorization'],
      };
      return await upgradeR020Returns(services, { info: (message) => this.log(message) });
    });
  }
}
