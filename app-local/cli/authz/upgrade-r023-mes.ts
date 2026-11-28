import type { AppAuthorization } from '@nocobase/app-plugin-authorization';
import { AppCommand } from '@nocobase/app-cli';
import {
  PermissionSetConflictError,
  type CreatePermissionSetInput,
} from '@nocobase/authorization/permission-sets';

/**
 * R-023 W3-1 的升级步骤：`pnpm nocobase authz upgrade-r023-mes`。
 *
 * 已有环境建 production（同名只补授权、不覆盖），给五个角色补 mesSettings.view，
 * 给 finance 补 mesSettings.priceView；maintain 只给 root，不写任何权限集。
 * 幂等、带 revision、声明对不上整条跳过、只加不改、不补用户指派，重跑不写。
 */
export const PRODUCTION_TARGET = 'production';
export const TARGETS = [
  'craft', 'planning', PRODUCTION_TARGET, 'warehouse', 'quality_inspector', 'finance',
] as const;
export const RESOURCE = 'mesSettings';
export const ACTIONS_BY_ROLE: Readonly<Record<string, readonly string[]>> = {
  craft: ['view'],
  planning: ['view'],
  production: ['view'],
  warehouse: ['view'],
  quality_inspector: ['view'],
  finance: ['priceView'],
};
export const PRODUCTION_TITLE = {
  key: 'permissionSets.business.production',
  ns: 'app-local',
} as const;

export interface UpgradeLogger {
  info(message: string): void;
}
export interface R023MesUpgradeReport {
  readonly targets: readonly string[];
  readonly changed: readonly string[];
  readonly created: readonly string[];
  readonly unchanged: readonly string[];
  readonly missing: readonly string[];
  readonly invalid: readonly string[];
}
export interface R023MesUpgradeServices {
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

export function neededGrants(target: string): StoredGrant[] {
  const actions = ACTIONS_BY_ROLE[target];
  if (actions === undefined) return [];
  return [{
    resource: { type: 'composite', id: RESOURCE },
    actions: actions.map((action) => ({ action })),
  }];
}

function problemWith(
  authz: R023MesUpgradeServices['authorization'],
  candidate: StoredGrant,
): string | undefined {
  for (const action of candidate.actions) {
    if (!authz.compositeResources.getAction(RESOURCE, action.action)) {
      return `unknown ${RESOURCE} action ${action.action}`;
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

/** 只看能按当前声明展开的授权；带展不开的条件不算已经补过。 */
function hasEffectiveGrant(
  authz: R023MesUpgradeServices['authorization'],
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
            JSON.stringify(have.policy) === JSON.stringify(action.policy) &&
            authz.compositeResources.validateGrant({
              resource: candidate.resource, action: have.action, policy: have.policy,
            }) === undefined,
        ),
      ),
  );
}

async function updateWithRevision(
  authz: R023MesUpgradeServices['authorization'],
  target: string,
  set: StoredSet,
  grants: CreatePermissionSetInput['grants'],
  logger: UpgradeLogger,
): Promise<void> {
  if (set.revision === undefined) {
    logger.info(`[r023-mes] ${target}: no revision; refusing to overwrite; nothing written`);
    throw new Error(`[r023-mes] ${target}: permission set has no revision; reload and rerun`);
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
        ? `[r023-mes] ${target}: revision changed since read; nothing written; reload and rerun`
        : `[r023-mes] ${target}: update failed; nothing written; reload and rerun`,
    );
    throw error;
  }
}

export async function upgradeR023Mes(
  services: R023MesUpgradeServices,
  logger: UpgradeLogger,
): Promise<R023MesUpgradeReport> {
  const { authorization: authz } = services;
  const changed: string[] = [];
  const created: string[] = [];
  const unchanged: string[] = [];
  const missing: string[] = [];
  const invalid: string[] = [];
  const sets = await authz.permissionSets.list();
  const needed = TARGETS.flatMap((target) => neededGrants(target));
  const problem = needed
    .map((candidate) => problemWith(authz, candidate))
    .find((entry) => entry !== undefined);
  if (problem !== undefined) {
    for (const target of TARGETS) {
      logger.info(`[r023-mes] ${target}: declaration mismatch: ${problem}; nothing written`);
      invalid.push(target);
    }
    return { targets: [...TARGETS], changed, created, unchanged, missing, invalid };
  }

  for (const target of TARGETS) {
    const set = sets.find((entry) => entry.key === target);
    const candidate = neededGrants(target)[0]!;
    if (set === undefined) {
      if (target !== PRODUCTION_TARGET) {
        logger.info(`[r023-mes] ${target}: not found; skipped`);
        missing.push(target);
        continue;
      }
      await authz.permissionSets.create({
        key: target,
        title: PRODUCTION_TITLE,
        grants: [candidate] as unknown as CreatePermissionSetInput['grants'],
      });
      logger.info('[r023-mes] production: role created with the declared grant');
      created.push(target);
      continue;
    }
    const stored = structuredClone(set.grants) as unknown as StoredGrant[];
    if (hasEffectiveGrant(authz, stored, candidate)) {
      logger.info(`[r023-mes] ${target}: already has the grant; nothing written`);
      unchanged.push(target);
      continue;
    }
    const grants = [...stored, candidate] as unknown as CreatePermissionSetInput['grants'];
    await updateWithRevision(authz, target, set as StoredSet, grants, logger);
    changed.push(target);
  }

  return { targets: [...TARGETS], changed, created, unchanged, missing, invalid };
}

export default class AuthzUpgradeR023Mes extends AppCommand {
  static summary = 'Create the production role and grant mesSettings view/priceView to the designed roles (existing installations).';

  static description =
    'Seed only runs on new installations. This command creates production when missing and adds mesSettings.view to craft, planning, production, warehouse and quality_inspector, plus mesSettings.priceView to finance, and nothing else: no maintenance action, no other role, no user assignment, no existing grant rewritten. Idempotent: a second run writes nothing and leaves the revision alone. Writes carry the revision that was read. Reload and rerun after a conflict or a declaration mismatch.';

  static examples = ['<%= config.bin %> <%= command.id %>'];

  async run(): Promise<R023MesUpgradeReport> {
    await this.parse(AuthzUpgradeR023Mes);
    return await this.withApp(async ({ app }) => {
      await app.start();
      const { authorizationToken } =
        await import('@nocobase/app-plugin-authorization/server');
      const services: R023MesUpgradeServices = {
        authorization: app.container.resolve(authorizationToken) as unknown as R023MesUpgradeServices['authorization'],
      };
      return await upgradeR023Mes(services, { info: (message) => this.log(message) });
    });
  }
}
