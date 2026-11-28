import type { AppAuthorization } from '@nocobase/app-plugin-authorization';
import { AppCommand } from '@nocobase/app-cli';
import {
  PermissionSetConflictError,
  type CreatePermissionSetInput,
} from '@nocobase/authorization/permission-sets';

/**
 * R-065 复刻波 2：已有环境跑 `pnpm nocobase authz upgrade-r065-reconcile`。
 *
 * 给 finance 角色补四张财务单各五个动作与 salesOrders.financeView。
 * 幂等、带 revision、声明对不上整条跳过、只加不改、不碰别的角色、不补用户指派。
 * 与 017 种子同一口径：只看本条授权在不在，不比对整份授权。
 */
export const FINANCE_TARGET = 'finance';
export const TARGETS = [FINANCE_TARGET] as const;
export const DOC_ACTIONS = ['view', 'create', 'update', 'confirm', 'void'] as const;
export const FINANCE_TITLE = { key: 'permissionSets.business.finance', ns: 'app-local' } as const;

export interface UpgradeLogger { info(message: string): void; }
export interface R065ReconcileUpgradeReport {
  readonly targets: readonly string[];
  readonly changed: readonly string[];
  readonly created: readonly string[];
  readonly unchanged: readonly string[];
  readonly missing: readonly string[];
  readonly invalid: readonly string[];
}
export interface R065ReconcileUpgradeServices {
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

/** 与种子 019 的 financeReconciliationGrants 一致。 */
export function neededGrants(): StoredGrant[] {
  return [
    grant('incomeRecords', DOC_ACTIONS),
    grant('saleInvoiceRecords', DOC_ACTIONS),
    grant('receivableRecons', DOC_ACTIONS),
    grant('payableRecons', DOC_ACTIONS),
    grant('salesOrders', ['financeView']),
  ];
}

function validateGrant(
  authz: R065ReconcileUpgradeServices['authorization'],
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

function missingActions(
  authz: R065ReconcileUpgradeServices['authorization'],
  stored: readonly StoredGrant[],
  candidate: StoredGrant,
): StoredGrantAction[] {
  return candidate.actions.filter((action) => !stored.some(
    (entry) =>
      entry.resource.type === candidate.resource.type &&
      entry.resource.id === candidate.resource.id &&
      entry.actions.some(
        (have) =>
          have.action === action.action &&
          authz.compositeResources.validateGrant({
            resource: candidate.resource, action: have.action, policy: have.policy,
          }) === undefined,
      ),
  ));
}

async function updateWithRevision(
  authz: R065ReconcileUpgradeServices['authorization'],
  set: StoredSet,
  grants: CreatePermissionSetInput['grants'],
  logger: UpgradeLogger,
): Promise<void> {
  if (set.revision === undefined) {
    logger.info('[r065-reconcile] finance: no revision; refusing to overwrite; nothing written');
    throw new Error('[r065-reconcile] finance: permission set has no revision; reload and rerun');
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
        ? '[r065-reconcile] finance: revision changed since read; nothing written; reload and rerun'
        : '[r065-reconcile] finance: update failed; nothing written; reload and rerun',
    );
    throw error;
  }
}

export async function upgradeR065Reconcile(
  services: R065ReconcileUpgradeServices,
  logger: UpgradeLogger,
): Promise<R065ReconcileUpgradeReport> {
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
    logger.info(`[r065-reconcile] finance: declaration mismatch: ${problem}; nothing written`);
    invalid.push(FINANCE_TARGET);
    return { targets: [...TARGETS], changed, created, unchanged, missing: [], invalid };
  }
  if (set === undefined) {
    await authz.permissionSets.create({
      key: FINANCE_TARGET,
      title: FINANCE_TITLE,
      grants: needed as unknown as CreatePermissionSetInput['grants'],
    });
    logger.info('[r065-reconcile] finance: role created with the declared grants');
    created.push(FINANCE_TARGET);
    return { targets: [...TARGETS], changed, created, unchanged, missing: [], invalid };
  }
  const stored = structuredClone(set.grants) as unknown as StoredGrant[];
  const absent = needed
    .map((candidate) => ({ candidate, actions: missingActions(authz, stored, candidate) }))
    .filter((entry) => entry.actions.length > 0);
  if (absent.length === 0) {
    logger.info('[r065-reconcile] finance: already has all grants; nothing written');
    unchanged.push(FINANCE_TARGET);
    return { targets: [...TARGETS], changed, created, unchanged, missing: [], invalid };
  }
  const addition = absent.map(({ candidate, actions }) => ({
    resource: candidate.resource, actions,
  })) as unknown as CreatePermissionSetInput['grants'];
  const grants = [...stored, ...addition] as unknown as CreatePermissionSetInput['grants'];
  await updateWithRevision(authz, set as StoredSet, grants, logger);
  changed.push(FINANCE_TARGET);
  return { targets: [...TARGETS], changed, created, unchanged, missing: [], invalid };
}

export default class AuthzUpgradeR065Reconcile extends AppCommand {
  static summary = 'Grant the finance role reconciliation, income and sale-invoice access (existing installations).';

  static description =
    'Seed only runs on new installations. This command adds the four finance document resources with five actions each and the narrow salesOrders.financeView to the finance role. Nothing else: no other role, no user assignment, no existing grant rewritten. Idempotent: a second run writes nothing and leaves the revision alone. Writes carry the revision that was read. Reload and rerun after a conflict or a declaration mismatch.';

  static examples = ['<%= config.bin %> <%= command.id %>'];

  async run(): Promise<R065ReconcileUpgradeReport> {
    await this.parse(AuthzUpgradeR065Reconcile);
    return await this.withApp(async ({ app }) => {
      await app.start();
      const { authorizationToken } =
        await import('@nocobase/app-plugin-authorization/server');
      const services: R065ReconcileUpgradeServices = {
        authorization: app.container.resolve(authorizationToken) as unknown as R065ReconcileUpgradeServices['authorization'],
      };
      return await upgradeR065Reconcile(services, { info: (message) => this.log(message) });
    });
  }
}
