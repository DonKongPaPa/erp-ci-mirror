import type { AppAuthorization } from '@nocobase/app-plugin-authorization';
import { AppCommand } from '@nocobase/app-cli';
import {
  PermissionSetConflictError,
  type CreatePermissionSetInput,
} from '@nocobase/authorization/permission-sets';

/**
 * R-066：已有环境跑 `pnpm nocobase authz upgrade-r066`。
 *
 * 只给 staff 补五个请款单动作（按建单人收窄）、给 finance 补 view 与 convert。
 * 幂等、带 revision、声明对不上整条跳过、只加不改、不建角色、不补用户指派，
 * 重跑不写。finance 角色由 upgrade-r065 建出，本命令不动它。
 */
export const TARGETS = ['staff', 'finance'] as const;
export const WRITER_ACTIONS = ['view', 'create', 'update', 'submit', 'void'] as const;
export const FINANCE_ACTIONS = ['view', 'convert'] as const;
export const RESOURCE = 'financeRequests';
const CREATOR_OWN = 'financeRequest.creatorOwn';

export interface UpgradeLogger { info(message: string): void; }
export interface R066UpgradeReport {
  readonly targets: readonly string[];
  readonly changed: readonly string[];
  readonly unchanged: readonly string[];
  readonly missing: readonly string[];
  readonly invalid: readonly string[];
}
export interface R066UpgradeServices {
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
  readonly grants: CreatePermissionSetInput['grants'];
}

const grant = (actions: readonly { action: string; policy?: unknown }[]): StoredGrant => ({
  resource: { type: 'composite', id: RESOURCE },
  actions: actions.map((entry) => ({
    action: entry.action,
    ...(entry.policy === undefined ? {} : { policy: entry.policy as StoredGrantAction['policy'] }),
  })),
});

/** 与种子 202611280008 的两条授权一致。 */
export function neededGrants(): Readonly<Record<string, StoredGrant>> {
  const scoped = (action: string) => ({
    action,
    // 作用域的键是集合名，不是资源 id。
    policy: { type: 'composite', scopes: { financeRequestDocs: CREATOR_OWN } },
  });
  return {
    staff: grant(WRITER_ACTIONS.map(scoped)),
    finance: grant(FINANCE_ACTIONS.map((action) => ({ action }))),
  };
}

function validateGrant(
  authz: R066UpgradeServices['authorization'],
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
  authz: R066UpgradeServices['authorization'],
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
  authz: R066UpgradeServices['authorization'],
  target: string,
  set: StoredSet,
  grants: CreatePermissionSetInput['grants'],
  logger: UpgradeLogger,
): Promise<void> {
  if (set.revision === undefined) {
    logger.info(`[r066] ${target}: no revision; refusing to overwrite; nothing written`);
    throw new Error(`[r066] ${target}: permission set has no revision; reload and rerun`);
  }
  try {
    await authz.permissionSets.update(target, { key: target, grants }, set.revision);
  } catch (error) {
    logger.info(
      error instanceof PermissionSetConflictError
        ? `[r066] ${target}: revision changed since read; nothing written`
        : `[r066] ${target}: update failed; nothing written`,
    );
    throw error;
  }
}

export async function upgradeR066(
  services: R066UpgradeServices,
  logger: UpgradeLogger,
): Promise<R066UpgradeReport> {
  const { authorization: authz } = services;
  const changed: string[] = [];
  const unchanged: string[] = [];
  const missing: string[] = [];
  const invalid: string[] = [];
  const need = neededGrants();
  const problem = TARGETS.map((target) => validateGrant(authz, need[target]!))
    .find((entry) => entry !== undefined);
  if (problem !== undefined) {
    logger.info(`[r066] declaration mismatch: ${problem}; nothing written`);
    return { targets: [...TARGETS], changed, unchanged, missing, invalid: [...TARGETS] };
  }
  const sets = await authz.permissionSets.list();
  for (const target of TARGETS) {
    const set = sets.find((entry) => entry.key === target);
    if (set === undefined) {
      logger.info(`[r066] ${target}: role missing; nothing written`);
      missing.push(target);
      continue;
    }
    const stored = structuredClone(set.grants) as unknown as StoredGrant[];
    const candidate = need[target]!;
    if (hasEffectiveGrant(authz, stored, candidate)) {
      logger.info(`[r066] ${target}: already has all grants; nothing written`);
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

export default class AuthzUpgradeR066 extends AppCommand {
  static summary = 'Grant finance-request actions to staff and finance (existing installations).';

  static description =
    'Seed only runs on new installations. This command grants financeRequests.view/create/update/submit/void to staff scoped to the creator, and financeRequests.view plus financeRequests.convert to finance. It creates no role, writes no user assignment, rewrites no existing grant, carries the revision it read, and writes nothing on a second run or a declaration mismatch.';

  static examples = ['<%= config.bin %> <%= command.id %>'];

  async run(): Promise<R066UpgradeReport> {
    await this.parse(AuthzUpgradeR066);
    return await this.withApp(async ({ app }) => {
      await app.start();
      const { authorizationToken } =
        await import('@nocobase/app-plugin-authorization/server');
      const services: R066UpgradeServices = {
        authorization: app.container.resolve(authorizationToken) as unknown as R066UpgradeServices['authorization'],
      };
      return await upgradeR066(services, { info: (message) => this.log(message) });
    });
  }
}
