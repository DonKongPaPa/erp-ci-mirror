import type { AppAuthorization } from '@nocobase/app-plugin-authorization';
import { AppCommand } from '@nocobase/app-cli';
import {
  PermissionSetConflictError,
  type CreatePermissionSetInput,
} from '@nocobase/authorization/permission-sets';

/**
 * R-064 的升级步骤：`pnpm nocobase authz upgrade-r064`。
 *
 * seed 只对新建环境生效。没有 planning 角色就建出来（只建这一个），再给 planning
 * 补评审六个动作与 salesOrders.ledgerView，给 sales 补 orderReviews.view 与
 * salesOrders.ledgerView。只加不改、带 revision、声明对不上整条跳过、别的角色
 * 一行不动、不补用户指派、不给 planning 订单的 view（那会连价格一起放行）。
 * 重跑不写、revision 不变。
 */
export const PLANNING_TARGET = 'planning';
export const SALES_TARGET = 'sales';
export const TARGETS = [PLANNING_TARGET, SALES_TARGET] as const;
export const REVIEW_ACTIONS = [
  'view', 'create', 'update', 'submit', 'confirm', 'void',
] as const;
export const PLANNING_TITLE = {
  key: 'permissionSets.business.planning',
  ns: 'app-local',
} as const;

export interface UpgradeLogger { info(message: string): void; }
export interface R064UpgradeReport {
  readonly targets: readonly string[];
  readonly changed: readonly string[];
  readonly created: readonly string[];
  readonly unchanged: readonly string[];
  readonly missing: readonly string[];
  readonly invalid: readonly string[];
}
export interface R064UpgradeServices {
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

const grant = (id: 'orderReviews' | 'salesOrders', actions: readonly string[]): StoredGrant => ({
  resource: { type: 'composite', id },
  actions: actions.map((action) => ({ action })),
});

/** 与 seed 的 planningReviewGrant / ledgerViewGrant / salesReviewGrant 一致。 */
export function neededGrants(target: string): StoredGrant[] {
  return target === PLANNING_TARGET
    ? [grant('orderReviews', REVIEW_ACTIONS), grant('salesOrders', ['ledgerView'])]
    : [grant('orderReviews', ['view']), grant('salesOrders', ['ledgerView'])];
}

function validateGrant(
  authz: R064UpgradeServices['authorization'],
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

/** 整份授权的所有动作都能展开才算已有；带条件展不开的不算。 */
function hasEffectiveGrant(
  authz: R064UpgradeServices['authorization'],
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
  authz: R064UpgradeServices['authorization'],
  target: string,
  set: StoredSet,
  grants: CreatePermissionSetInput['grants'],
  logger: UpgradeLogger,
): Promise<void> {
  if (set.revision === undefined) {
    logger.info(`[r064] ${target}: no revision; refusing to overwrite; nothing written`);
    throw new Error(`[r064] ${target}: permission set has no revision; reload and rerun`);
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
        ? `[r064] ${target}: revision changed since read; nothing written; reload and rerun`
        : `[r064] ${target}: update failed; nothing written; reload and rerun`,
    );
    throw error;
  }
}

export async function upgradeR064(
  services: R064UpgradeServices,
  logger: UpgradeLogger,
): Promise<R064UpgradeReport> {
  const { authorization: authz } = services;
  const changed: string[] = [];
  const created: string[] = [];
  const unchanged: string[] = [];
  const missing: string[] = [];
  const invalid: string[] = [];
  const sets = await authz.permissionSets.list();

  for (const target of TARGETS) {
    const needed = neededGrants(target);
    const problem = needed
      .map((candidate) => validateGrant(authz, candidate))
      .find((entry) => entry !== undefined);
    if (problem !== undefined) {
      logger.info(`[r064] ${target}: declaration mismatch: ${problem}; nothing written`);
      invalid.push(target);
      continue;
    }
    const set = sets.find((entry) => entry.key === target);
    if (set === undefined) {
      if (target !== PLANNING_TARGET) {
        logger.info(`[r064] ${target}: not found; skipped`);
        missing.push(target);
        continue;
      }
      await authz.permissionSets.create({
        key: target,
        title: PLANNING_TITLE,
        grants: needed as unknown as CreatePermissionSetInput['grants'],
      });
      logger.info('[r064] planning: role created with the declared grants');
      created.push(target);
      continue;
    }
    const stored = structuredClone(set.grants) as unknown as StoredGrant[];
    const absent = needed.filter((candidate) => !hasEffectiveGrant(authz, stored, candidate));
    if (absent.length === 0) {
      logger.info(`[r064] ${target}: already has all grants; nothing written`);
      unchanged.push(target);
      continue;
    }
    const grants = [...stored, ...absent] as unknown as CreatePermissionSetInput['grants'];
    await updateWithRevision(authz, target, set as StoredSet, grants, logger);
    changed.push(target);
  }

  return {
    targets: [...TARGETS],
    changed, created, unchanged, missing, invalid,
  };
}

export default class AuthzUpgradeR064 extends AppCommand {
  static summary = 'Create the planning role and grant order reviews and the sales ledger view (existing installations).';

  static description =
    'Seed only runs on new installations. This command creates the planning role when missing and adds the six order-review actions plus salesOrders.ledgerView to planning, and orderReviews.view plus salesOrders.ledgerView to sales. Nothing else: no other role, no order view for planning, no user assignment, no existing grant rewritten. Idempotent: a second run writes nothing and leaves the revision alone. Writes carry the revision that was read. Reload and rerun after a conflict or a declaration mismatch.';

  static examples = ['<%= config.bin %> <%= command.id %>'];

  async run(): Promise<R064UpgradeReport> {
    await this.parse(AuthzUpgradeR064);
    return await this.withApp(async ({ app }) => {
      await app.start();
      const { authorizationToken } =
        await import('@nocobase/app-plugin-authorization/server');
      const services: R064UpgradeServices = {
        authorization: app.container.resolve(authorizationToken) as unknown as R064UpgradeServices['authorization'],
      };
      return await upgradeR064(services, { info: (message) => this.log(message) });
    });
  }
}
