import type { AppAuthorization } from '@nocobase/app-plugin-authorization';
import { AppCommand } from '@nocobase/app-cli';
import {
  PermissionSetConflictError,
  type CreatePermissionSetInput,
} from '@nocobase/authorization/permission-sets';

/**
 * R-070：已有环境跑 `pnpm nocobase authz upgrade-r070-iqc`。
 *
 * 只给四个现成角色补检验动作：质量员建改完成、质量主管查看与作废、采购查看、
 * 仓管只拿窄读 receiveView。幂等、带 revision、声明对不上整条跳过、只加不改、
 * 不建角色、不补用户指派，重跑不写。root 直通，不写进任何权限集。
 */
export const TARGETS = [
  'quality_inspector', 'quality_manager', 'purchase', 'warehouse',
] as const;
export const RESOURCE = 'inspectionOrders';
export const ACTIONS_BY_ROLE: Readonly<Record<string, readonly string[]>> = {
  quality_inspector: ['view', 'create', 'update', 'complete'],
  quality_manager: ['view', 'void'],
  purchase: ['view'],
  warehouse: ['receiveView'],
};

export interface UpgradeLogger { info(message: string): void; }
export interface R070IqcUpgradeReport {
  readonly targets: readonly string[];
  readonly changed: readonly string[];
  readonly unchanged: readonly string[];
  readonly missing: readonly string[];
  readonly invalid: readonly string[];
}
export interface R070IqcUpgradeServices {
  readonly authorization: Pick<AppAuthorization, 'permissionSets' | 'compositeResources'>;
}
interface StoredGrantAction { action: string; policy?: { type: string; scopes?: Record<string, unknown> }; }
interface StoredGrant {
  resource: { type: string; id: string };
  actions: StoredGrantAction[];
}
interface StoredSet {
  readonly revision?: string;
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

function validateGrant(
  authz: R070IqcUpgradeServices['authorization'],
  candidate: StoredGrant,
): string | undefined {
  for (const action of candidate.actions) {
    if (!authz.compositeResources.getAction(RESOURCE, action.action)) {
      return `unknown ${RESOURCE} action ${action.action}`;
    }
    const problem = authz.compositeResources.validateGrant({
      resource: candidate.resource, action: action.action, policy: action.policy,
    });
    if (problem !== undefined) return problem;
  }
  return undefined;
}

function hasEffectiveGrant(
  authz: R070IqcUpgradeServices['authorization'],
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
  authz: R070IqcUpgradeServices['authorization'],
  target: string,
  set: StoredSet,
  grants: CreatePermissionSetInput['grants'],
  logger: UpgradeLogger,
): Promise<void> {
  if (set.revision === undefined) {
    logger.info(`[r070-iqc] ${target}: no revision; refusing to overwrite; nothing written`);
    throw new Error(`[r070-iqc] ${target}: permission set has no revision; reload and rerun`);
  }
  try {
    await authz.permissionSets.update(target, { key: target, grants }, set.revision);
  } catch (error) {
    logger.info(
      error instanceof PermissionSetConflictError
        ? `[r070-iqc] ${target}: revision changed since read; nothing written`
        : `[r070-iqc] ${target}: update failed; nothing written`,
    );
    throw error;
  }
}

export async function upgradeIqc(
  services: R070IqcUpgradeServices,
  logger: UpgradeLogger,
): Promise<R070IqcUpgradeReport> {
  const { authorization: authz } = services;
  const changed: string[] = [];
  const unchanged: string[] = [];
  const missing: string[] = [];
  const invalid: string[] = [];
  const need = TARGETS.flatMap((target) => neededGrants(target));
  const problem = need.map((candidate) => validateGrant(authz, candidate))
    .find((entry) => entry !== undefined);
  if (problem !== undefined) {
    logger.info(`[r070-iqc] declaration mismatch: ${problem}; nothing written`);
    return { targets: [...TARGETS], changed, unchanged, missing, invalid: [...TARGETS] };
  }
  const sets = await authz.permissionSets.list();
  for (const target of TARGETS) {
    const set = sets.find((entry) => entry.key === target);
    if (set === undefined) {
      logger.info(`[r070-iqc] ${target}: role missing; nothing written`);
      missing.push(target);
      continue;
    }
    const stored = structuredClone(set.grants) as unknown as StoredGrant[];
    const candidate = neededGrants(target)[0]!;
    if (hasEffectiveGrant(authz, stored, candidate)) {
      logger.info(`[r070-iqc] ${target}: already has all grants; nothing written`);
      unchanged.push(target);
      continue;
    }
    await updateWithRevision(
      authz, target, set as StoredSet,
      [...stored, candidate] as unknown as CreatePermissionSetInput['grants'], logger,
    );
    changed.push(target);
  }
  return { targets: [...TARGETS], changed, unchanged, missing, invalid };
}

export default class AuthzUpgradeR070Iqc extends AppCommand {
  static summary = 'Grant purchase-inspection actions to the quality, purchase and warehouse roles (existing installations).';

  static description =
    'Seed only runs on new installations. This command grants inspectionOrders.view/create/update/complete to quality_inspector, view and void to quality_manager, view to purchase, and the receiveView narrow read to warehouse. It creates no role, writes no user assignment, rewrites no existing grant, carries the revision it read, and writes nothing on a second run or a declaration mismatch.';

  static examples = ['<%= config.bin %> <%= command.id %>'];

  async run(): Promise<R070IqcUpgradeReport> {
    await this.parse(AuthzUpgradeR070Iqc);
    return await this.withApp(async ({ app }) => {
      await app.start();
      const { authorizationToken } =
        await import('@nocobase/app-plugin-authorization/server');
      const services: R070IqcUpgradeServices = {
        authorization: app.container.resolve(authorizationToken) as unknown as R070IqcUpgradeServices['authorization'],
      };
      return await upgradeIqc(services, { info: (message) => this.log(message) });
    });
  }
}
