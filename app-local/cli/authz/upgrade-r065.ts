import type { AppAuthorization } from '@nocobase/app-plugin-authorization';
import { AppCommand } from '@nocobase/app-cli';
import {
  PermissionSetConflictError,
  type CreatePermissionSetInput,
} from '@nocobase/authorization/permission-sets';

/**
 * R-065 第一片：已有环境跑 `pnpm nocobase authz upgrade-r065`。
 *
 * 没有 finance 角色就建出来，再有条件地补三份业务授权与字典、选项只读。
 * 幂等、带 revision、声明对不上整条跳过、只加不改、不碰别的角色、不补用户指派。
 */
export const FINANCE_TARGET = 'finance';
export const TARGETS = [FINANCE_TARGET] as const;
export const ACTIONS = ['view', 'create', 'update', 'confirm', 'void'] as const;
export const FINANCE_TITLE = { key: 'permissionSets.business.finance', ns: 'app-local' } as const;

export interface UpgradeLogger { info(message: string): void; }
export interface R065UpgradeReport {
  readonly targets: readonly string[];
  readonly changed: readonly string[];
  readonly created: readonly string[];
  readonly unchanged: readonly string[];
  readonly missing: readonly string[];
  readonly invalid: readonly string[];
}
export interface R065UpgradeServices {
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

/** 与 seed 的 financeExpensesGrant / financeInvoiceGrant / financeOrderGrant 一致。 */
export function neededGrants(): StoredGrant[] {
  return [
    grant('expenses', ACTIONS),
    grant('invoiceReceipts', ACTIONS),
    grant('purchaseOrders', ['financeView']),
    grant('bizDict', ['view']),
    grant('bizOptions', ['view']),
  ];
}

function validateGrant(authz: R065UpgradeServices['authorization'], candidate: StoredGrant): string | undefined {
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
  authz: R065UpgradeServices['authorization'],
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
  authz: R065UpgradeServices['authorization'],
  set: StoredSet,
  grants: CreatePermissionSetInput['grants'],
  logger: UpgradeLogger,
): Promise<void> {
  if (set.revision === undefined) {
    logger.info('[r065] finance: no revision; refusing to overwrite; nothing written');
    throw new Error('[r065] finance: permission set has no revision; reload and rerun');
  }
  try {
    await authz.permissionSets.update(
      FINANCE_TARGET,
      { key: FINANCE_TARGET, ...(set.title === undefined ? {} : { title: set.title }), grants },
      set.revision,
    );
  } catch (error) {
    logger.info(
      error instanceof PermissionSetConflictError
        ? '[r065] finance: revision changed since read; nothing written; reload and rerun'
        : '[r065] finance: update failed; nothing written; reload and rerun',
    );
    throw error;
  }
}

export async function upgradeR065(
  services: R065UpgradeServices,
  logger: UpgradeLogger,
): Promise<R065UpgradeReport> {
  const { authorization: authz } = services;
  const changed: string[] = [];
  const created: string[] = [];
  const unchanged: string[] = [];
  const invalid: string[] = [];
  const sets = await authz.permissionSets.list();
  const set = sets.find((entry) => entry.key === FINANCE_TARGET);
  const needed = neededGrants();
  const problem = needed.map((candidate) => validateGrant(authz, candidate)).find((entry) => entry !== undefined);
  if (problem !== undefined) {
    logger.info(`[r065] finance: declaration mismatch: ${problem}; nothing written`);
    invalid.push(FINANCE_TARGET);
    return { targets: [...TARGETS], changed, created, unchanged, missing: [], invalid };
  }
  if (set === undefined) {
    await authz.permissionSets.create({
      key: FINANCE_TARGET,
      title: FINANCE_TITLE,
      grants: needed as unknown as CreatePermissionSetInput['grants'],
    });
    logger.info('[r065] finance: role created with the declared grants');
    created.push(FINANCE_TARGET);
    return { targets: [...TARGETS], changed, created, unchanged, missing: [], invalid };
  }
  const stored = structuredClone(set.grants) as unknown as StoredGrant[];
  const absent = needed.filter((candidate) => !hasEffectiveGrant(authz, stored, candidate));
  if (absent.length === 0) {
    logger.info('[r065] finance: already has all grants; nothing written');
    unchanged.push(FINANCE_TARGET);
    return { targets: [...TARGETS], changed, created, unchanged, missing: [], invalid };
  }
  const grants = [...stored, ...absent] as unknown as CreatePermissionSetInput['grants'];
  await updateWithRevision(authz, set as StoredSet, grants, logger);
  changed.push(FINANCE_TARGET);
  return { targets: [...TARGETS], changed, created, unchanged, missing: [], invalid };
}

export default class AuthzUpgradeR065 extends AppCommand {
  static summary = 'Create the finance role and grant expense, invoice and payable-order access (existing installations).';

  static description =
    'Seed only runs on new installations. This command creates the finance role when missing and adds the five expense actions, the five invoice-receipt actions, purchaseOrders.financeView and the two dictionary read grants. Nothing else: no other role, no user assignment, no existing grant rewritten. Idempotent: a second run writes nothing and leaves the revision alone. Writes carry the revision that was read. Reload and rerun after a conflict or a declaration mismatch.';

  static examples = ['<%= config.bin %> <%= command.id %>'];

  async run(): Promise<R065UpgradeReport> {
    await this.parse(AuthzUpgradeR065);
    return await this.withApp(async ({ app }) => {
      await app.start();
      const { authorizationToken } =
        await import('@nocobase/app-plugin-authorization/server');
      const services: R065UpgradeServices = {
        authorization: app.container.resolve(authorizationToken) as unknown as R065UpgradeServices['authorization'],
      };
      return await upgradeR065(services, { info: (message) => this.log(message) });
    });
  }
}
