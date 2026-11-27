import type { AppAuthorization } from '@nocobase/app-plugin-authorization';
import { AppCommand } from '@nocobase/app-cli';
import {
  PermissionSetConflictError,
  type CreatePermissionSetInput,
} from '@nocobase/authorization/permission-sets';

/**
 * R-020 波 1：`pnpm nocobase authz upgrade-r020-stocktake`。
 *
 * 只给已有的 warehouse 补盘点四动作与调拨五动作，给 finance 补盘点读与监盘结束；
 * 不建角色、不动别的角色、不补用户指派。幂等、带 revision、声明对不上整条跳过。
 */
export const WAREHOUSE_TARGET = 'warehouse';
export const FINANCE_TARGET = 'finance';
export const TARGETS = [WAREHOUSE_TARGET, FINANCE_TARGET] as const;

export interface UpgradeLogger { info(message: string): void; }
export interface R020StocktakeUpgradeReport {
  readonly targets: readonly string[];
  readonly changed: readonly string[];
  readonly unchanged: readonly string[];
  readonly missing: readonly string[];
  readonly invalid: readonly string[];
}
export interface R020StocktakeUpgradeServices {
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

/** 与 seed 的 warehouseStocktakingTransferGrants / financeStocktakingGrant 一致。 */
export function neededGrants(target: string): StoredGrant[] {
  if (target === WAREHOUSE_TARGET) {
    return [
      grant('stocktakings', ['view', 'create', 'update', 'void']),
      grant('transfers', ['view', 'create', 'update', 'post', 'void']),
    ];
  }
  if (target === FINANCE_TARGET) return [grant('stocktakings', ['view', 'finish'])];
  return [];
}

function validateGrant(
  authz: R020StocktakeUpgradeServices['authorization'],
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
  authz: R020StocktakeUpgradeServices['authorization'],
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
  authz: R020StocktakeUpgradeServices['authorization'],
  target: string,
  set: StoredSet,
  grants: CreatePermissionSetInput['grants'],
  logger: UpgradeLogger,
): Promise<void> {
  if (set.revision === undefined) {
    logger.info(`[r020-stocktake] ${target}: no revision; refusing to overwrite; nothing written`);
    throw new Error(`[r020-stocktake] ${target}: permission set has no revision; reload and rerun`);
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
        ? `[r020-stocktake] ${target}: revision changed since read; nothing written; reload and rerun`
        : `[r020-stocktake] ${target}: update failed; nothing written; reload and rerun`,
    );
    throw error;
  }
}

export async function upgradeR020Stocktake(
  services: R020StocktakeUpgradeServices,
  logger: UpgradeLogger,
): Promise<R020StocktakeUpgradeReport> {
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
      logger.info(`[r020-stocktake] ${target}: declaration mismatch: ${problem}; nothing written`);
      invalid.push(target);
      continue;
    }
    const stored = structuredClone(set.grants) as unknown as StoredGrant[];
    const absent = needed.filter((candidate) => !hasEffectiveGrant(authz, stored, candidate));
    if (absent.length === 0) {
      logger.info(`[r020-stocktake] ${target}: already has all grants; nothing written`);
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

export default class AuthzUpgradeR020Stocktake extends AppCommand {
  static summary = 'Grant the warehouse and finance roles the stocktaking and transfer actions (existing installations).';

  static description =
    'Seed only runs on new installations. This command adds the stocktakings.view/create/update/void and transfers.view/create/update/post/void grants to warehouse, plus stocktakings.view/finish to finance. Nothing else: no new role, no other role, no user assignment, no existing grant rewritten. Idempotent: a second run writes nothing and leaves the revision alone. Writes carry the revision that was read. Reload and rerun after a conflict or a declaration mismatch.';

  static examples = ['<%= config.bin %> <%= command.id %>'];

  async run(): Promise<R020StocktakeUpgradeReport> {
    await this.parse(AuthzUpgradeR020Stocktake);
    return await this.withApp(async ({ app }) => {
      await app.start();
      const { authorizationToken } =
        await import('@nocobase/app-plugin-authorization/server');
      const services: R020StocktakeUpgradeServices = {
        authorization: app.container.resolve(authorizationToken) as unknown as R020StocktakeUpgradeServices['authorization'],
      };
      return await upgradeR020Stocktake(services, { info: (message) => this.log(message) });
    });
  }
}
