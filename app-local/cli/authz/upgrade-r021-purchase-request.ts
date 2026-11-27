import type { AppAuthorization } from '@nocobase/app-plugin-authorization';
import { AppCommand } from '@nocobase/app-cli';
import {
  PermissionSetConflictError,
  type CreatePermissionSetInput,
} from '@nocobase/authorization/permission-sets';

/**
 * R-021 波 1 加片：已有环境跑 `pnpm nocobase authz upgrade-r021-purchase-request`。
 *
 * 只给 planning / staff / purchase 补请购单动作：staff 带「仅本人」范围，其余不带。
 * 幂等、带 revision、声明对不上整条跳过、只加不改、不建角色、不补用户指派，重跑不写。
 */
export const TARGETS = ['planning', 'staff', 'purchase'] as const;
export const WRITER_ACTIONS = ['view', 'create', 'update', 'submit', 'void'] as const;
export const RESOURCE = 'purchaseRequests';
const CREATOR_OWN = 'purchaseRequest.creatorOwn';

export interface UpgradeLogger { info(message: string): void; }
export interface R021PurchaseRequestUpgradeReport {
  readonly targets: readonly string[];
  readonly changed: readonly string[];
  readonly unchanged: readonly string[];
  readonly missing: readonly string[];
  readonly invalid: readonly string[];
}
export interface R021PurchaseRequestUpgradeServices {
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

/** 与种子 202611280007 的三条授权一致。 */
export function neededGrants(): Readonly<Record<string, StoredGrant>> {
  const scoped = (action: string) => ({
    action,
    policy: { type: 'composite', scopes: { [RESOURCE]: CREATOR_OWN } },
  });
  return {
    planning: grant(WRITER_ACTIONS.map((action) => ({ action }))),
    staff: grant(WRITER_ACTIONS.map(scoped)),
    purchase: grant([{ action: 'view' }, { action: 'convert' }]),
  };
}

function validateGrant(
  authz: R021PurchaseRequestUpgradeServices['authorization'],
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
  authz: R021PurchaseRequestUpgradeServices['authorization'],
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
  authz: R021PurchaseRequestUpgradeServices['authorization'],
  target: string,
  set: StoredSet,
  grants: CreatePermissionSetInput['grants'],
  logger: UpgradeLogger,
): Promise<void> {
  if (set.revision === undefined) {
    logger.info(`[r021-pr] ${target}: no revision; refusing to overwrite; nothing written`);
    throw new Error(`[r021-pr] ${target}: permission set has no revision; reload and rerun`);
  }
  try {
    await authz.permissionSets.update(
      target,
      { key: target, grants },
      set.revision,
    );
  } catch (error) {
    logger.info(
      error instanceof PermissionSetConflictError
        ? `[r021-pr] ${target}: revision changed since read; nothing written`
        : `[r021-pr] ${target}: update failed; nothing written`,
    );
    throw error;
  }
}

export async function upgradeR021PurchaseRequest(
  services: R021PurchaseRequestUpgradeServices,
  logger: UpgradeLogger,
): Promise<R021PurchaseRequestUpgradeReport> {
  const { authorization: authz } = services;
  const changed: string[] = [];
  const unchanged: string[] = [];
  const missing: string[] = [];
  const invalid: string[] = [];
  const need = neededGrants();
  const problem = TARGETS.map((target) => validateGrant(authz, need[target]!))
    .find((entry) => entry !== undefined);
  if (problem !== undefined) {
    logger.info(`[r021-pr] declaration mismatch: ${problem}; nothing written`);
    return { targets: [...TARGETS], changed, unchanged, missing, invalid: [...TARGETS] };
  }
  const sets = await authz.permissionSets.list();
  for (const target of TARGETS) {
    const set = sets.find((entry) => entry.key === target);
    if (set === undefined) {
      logger.info(`[r021-pr] ${target}: role missing; nothing written`);
      missing.push(target);
      continue;
    }
    const stored = structuredClone(set.grants) as unknown as StoredGrant[];
    const candidate = need[target]!;
    if (hasEffectiveGrant(authz, stored, candidate)) {
      logger.info(`[r021-pr] ${target}: already has all grants; nothing written`);
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

export default class AuthzUpgradeR021PurchaseRequest extends AppCommand {
  static summary = 'Grant purchase-request actions to planning, staff and purchase (existing installations).';

  static description =
    'Seed only runs on new installations. This command grants purchaseRequests.view/create/update/submit/void to planning, the same five scoped to the creator to staff, and purchaseRequests.view plus purchaseRequests.convert to purchase. It creates no role, writes no user assignment, rewrites no existing grant, carries the revision it read, and writes nothing on a second run or a declaration mismatch.';

  static examples = ['<%= config.bin %> <%= command.id %>'];

  async run(): Promise<R021PurchaseRequestUpgradeReport> {
    await this.parse(AuthzUpgradeR021PurchaseRequest);
    return await this.withApp(async ({ app }) => {
      await app.start();
      const { authorizationToken } =
        await import('@nocobase/app-plugin-authorization/server');
      const services: R021PurchaseRequestUpgradeServices = {
        authorization: app.container.resolve(authorizationToken) as unknown as R021PurchaseRequestUpgradeServices['authorization'],
      };
      return await upgradeR021PurchaseRequest(services, { info: (message) => this.log(message) });
    });
  }
}
