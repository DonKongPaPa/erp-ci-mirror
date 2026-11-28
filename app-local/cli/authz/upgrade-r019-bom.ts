import type { AppAuthorization } from '@nocobase/app-plugin-authorization';
import { AppCommand } from '@nocobase/app-cli';
import {
  PermissionSetConflictError,
  type CreatePermissionSetInput,
} from '@nocobase/authorization/permission-sets';

/**
 * R-019 波 2 的升级步骤：`pnpm nocobase authz upgrade-r019-bom`。
 *
 * seed 只对新建环境生效。这条命令在已有环境建 craft（同名只补授权、不覆盖），
 * 给 craft 与 planning 补 BOM 的 view / explode 两个只读动作；维护动作不写、
 * 别的角色一行不动、不补用户指派。重跑不写、revision 不变；
 * 声明对不上整条跳过；写入带读到的 revision，读后被改过就报错退出、重载重跑。
 */
export const CRAFT_TARGET = 'craft';
export const PLANNING_TARGET = 'planning';
export const TARGETS = [CRAFT_TARGET, PLANNING_TARGET] as const;
export const BOM_ACTIONS = ['view', 'explode'] as const;
export const CRAFT_TITLE = {
  key: 'permissionSets.business.craft',
  ns: 'app-local',
} as const;

export interface UpgradeLogger {
  info(message: string): void;
}
export interface R019BomUpgradeReport {
  readonly targets: readonly string[];
  readonly changed: readonly string[];
  readonly created: readonly string[];
  readonly unchanged: readonly string[];
  readonly missing: readonly string[];
  readonly invalid: readonly string[];
}
export interface R019BomUpgradeServices {
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

export function neededGrants(): StoredGrant[] {
  return [{
    resource: { type: 'composite', id: 'boms' },
    actions: BOM_ACTIONS.map((action) => ({ action })),
  }];
}

function problemWith(
  authz: R019BomUpgradeServices['authorization'],
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

/** 只看能按当前声明展开的授权；带展不开的条件不算已经补过。 */
function hasEffectiveGrant(
  authz: R019BomUpgradeServices['authorization'],
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
  authz: R019BomUpgradeServices['authorization'],
  target: string,
  set: StoredSet,
  grants: CreatePermissionSetInput['grants'],
  logger: UpgradeLogger,
): Promise<void> {
  if (set.revision === undefined) {
    logger.info(`[r019-bom] ${target}: no revision; refusing to overwrite; nothing written`);
    throw new Error(`[r019-bom] ${target}: permission set has no revision; reload and rerun`);
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
        ? `[r019-bom] ${target}: revision changed since read; nothing written; reload and rerun`
        : `[r019-bom] ${target}: update failed; nothing written; reload and rerun`,
    );
    throw error;
  }
}

export async function upgradeR019Bom(
  services: R019BomUpgradeServices,
  logger: UpgradeLogger,
): Promise<R019BomUpgradeReport> {
  const { authorization: authz } = services;
  const changed: string[] = [];
  const created: string[] = [];
  const unchanged: string[] = [];
  const missing: string[] = [];
  const invalid: string[] = [];
  const sets = await authz.permissionSets.list();
  const needed = neededGrants();
  const problem = needed
    .map((candidate) => problemWith(authz, candidate))
    .find((entry) => entry !== undefined);
  if (problem !== undefined) {
    for (const target of TARGETS) {
      logger.info(`[r019-bom] ${target}: declaration mismatch: ${problem}; nothing written`);
      invalid.push(target);
    }
    return { targets: [...TARGETS], changed, created, unchanged, missing, invalid };
  }

  for (const target of TARGETS) {
    const set = sets.find((entry) => entry.key === target);
    if (set === undefined) {
      if (target !== CRAFT_TARGET) {
        logger.info(`[r019-bom] ${target}: not found; skipped`);
        missing.push(target);
        continue;
      }
      await authz.permissionSets.create({
        key: target,
        title: CRAFT_TITLE,
        grants: needed as unknown as CreatePermissionSetInput['grants'],
      });
      logger.info('[r019-bom] craft: role created with the declared grants');
      created.push(target);
      continue;
    }
    const stored = structuredClone(set.grants) as unknown as StoredGrant[];
    const absent = needed.filter(
      (candidate) => !hasEffectiveGrant(authz, stored, candidate),
    );
    if (absent.length === 0) {
      logger.info(`[r019-bom] ${target}: already has both read actions; nothing written`);
      unchanged.push(target);
      continue;
    }
    const grants = [...stored, ...absent] as unknown as CreatePermissionSetInput['grants'];
    await updateWithRevision(authz, target, set as StoredSet, grants, logger);
    changed.push(target);
  }

  return { targets: [...TARGETS], changed, created, unchanged, missing, invalid };
}

export default class AuthzUpgradeR019Bom extends AppCommand {
  static summary = 'Create the craft role and grant BOM view/explode to craft and planning (existing installations).';

  static description =
    'Seed only runs on new installations. This command creates craft when missing and adds boms.view and boms.explode to craft and planning, and nothing else: no maintenance action, no other role, no user assignment, no existing grant rewritten. Idempotent: a second run writes nothing and leaves the revision alone. Writes carry the revision that was read. Reload and rerun after a conflict or a declaration mismatch.';

  static examples = ['<%= config.bin %> <%= command.id %>'];

  async run(): Promise<R019BomUpgradeReport> {
    await this.parse(AuthzUpgradeR019Bom);
    return await this.withApp(async ({ app }) => {
      await app.start();
      const { authorizationToken } =
        await import('@nocobase/app-plugin-authorization/server');
      const services: R019BomUpgradeServices = {
        authorization: app.container.resolve(authorizationToken) as unknown as R019BomUpgradeServices['authorization'],
      };
      return await upgradeR019Bom(services, { info: (message) => this.log(message) });
    });
  }
}
