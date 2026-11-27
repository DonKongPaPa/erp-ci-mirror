import type { AppAuthorization } from '@nocobase/app-plugin-authorization';
import { AppCommand } from '@nocobase/app-cli';
import {
  PermissionSetConflictError,
  type CreatePermissionSetInput,
} from '@nocobase/authorization/permission-sets';

/**
 * R-022 复刻波 1：`pnpm nocobase authz upgrade-r022-quotation`。
 *
 * seed 只对新建环境生效；已有环境的 sales 拿不到报价单的六个动作。这条命令只给 sales
 * 补 quotations 的六项授权，不碰别的角色、不补角色指派、不改既有授权（含 salesOrders.viewPrice）。
 * 幂等、带 revision、声明对不上整条跳过、只加不改。
 */
export const SALES_TARGET = 'sales';
export const TARGETS = [SALES_TARGET] as const;
export const ACTIONS = ['view', 'create', 'update', 'confirm', 'convert', 'void'] as const;

export interface UpgradeLogger { info(message: string): void; }
export interface R022QuotationUpgradeReport {
  readonly targets: readonly string[];
  readonly changed: readonly string[];
  readonly unchanged: readonly string[];
  readonly missing: readonly string[];
  readonly invalid: readonly string[];
}
export interface R022QuotationUpgradeServices {
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

/** 与 seed 的 salesQuotationGrant 一致。 */
export function neededGrants(): StoredGrant[] {
  return [grant('quotations', ACTIONS)];
}

function validateGrant(
  authz: R022QuotationUpgradeServices['authorization'],
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
  authz: R022QuotationUpgradeServices['authorization'],
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
  authz: R022QuotationUpgradeServices['authorization'],
  set: StoredSet,
  grants: CreatePermissionSetInput['grants'],
  logger: UpgradeLogger,
): Promise<void> {
  if (set.revision === undefined) {
    logger.info('[r022-quotation] sales: no revision; refusing to overwrite; nothing written');
    throw new Error('[r022-quotation] sales: permission set has no revision; reload and rerun');
  }
  try {
    await authz.permissionSets.update(
      SALES_TARGET,
      { key: SALES_TARGET, ...(set.title === undefined ? {} : { title: set.title }), grants },
      set.revision,
    );
  } catch (error) {
    logger.info(
      error instanceof PermissionSetConflictError
        ? '[r022-quotation] sales: revision changed since read; nothing written; reload and rerun'
        : '[r022-quotation] sales: update failed; nothing written; reload and rerun',
    );
    throw error;
  }
}

export async function upgradeR022Quotation(
  services: R022QuotationUpgradeServices,
  logger: UpgradeLogger,
): Promise<R022QuotationUpgradeReport> {
  const { authorization: authz } = services;
  const changed: string[] = [];
  const unchanged: string[] = [];
  const missing: string[] = [];
  const invalid: string[] = [];
  const sets = await authz.permissionSets.list();
  const set = sets.find((entry) => entry.key === SALES_TARGET);
  const needed = neededGrants();
  const problem = needed
    .map((candidate) => validateGrant(authz, candidate))
    .find((entry) => entry !== undefined);
  if (problem !== undefined) {
    logger.info(`[r022-quotation] sales: declaration mismatch: ${problem}; nothing written`);
    invalid.push(SALES_TARGET);
    return { targets: [...TARGETS], changed, unchanged, missing, invalid };
  }
  if (set === undefined) {
    logger.info('[r022-quotation] sales: role not found; skipped');
    missing.push(SALES_TARGET);
    return { targets: [...TARGETS], changed, unchanged, missing, invalid };
  }
  const stored = structuredClone(set.grants) as unknown as StoredGrant[];
  const absent = needed.filter((candidate) => !hasEffectiveGrant(authz, stored, candidate));
  if (absent.length === 0) {
    logger.info('[r022-quotation] sales: already has all six actions; nothing written');
    unchanged.push(SALES_TARGET);
    return { targets: [...TARGETS], changed, unchanged, missing, invalid };
  }
  const grants = [...stored, ...absent] as unknown as CreatePermissionSetInput['grants'];
  await updateWithRevision(authz, set as StoredSet, grants, logger);
  changed.push(SALES_TARGET);
  return { targets: [...TARGETS], changed, unchanged, missing, invalid };
}

export default class AuthzUpgradeR022Quotation extends AppCommand {
  static summary = 'Give the sales permission set the six quotation actions (existing installations).';

  static description =
    'Seed only runs on new installations. This command adds quotations.view, quotations.create, quotations.update, quotations.confirm, quotations.convert and quotations.void to sales and nothing else: no other role, no user assignment, no existing grant rewritten (salesOrders.viewPrice stays as it is). Idempotent: a second run writes nothing and leaves the revision alone. Writes carry the revision that was read. Reload and rerun after a conflict or a declaration mismatch.';

  static examples = ['<%= config.bin %> <%= command.id %>'];

  async run(): Promise<R022QuotationUpgradeReport> {
    await this.parse(AuthzUpgradeR022Quotation);
    return await this.withApp(async ({ app }) => {
      await app.start();
      const { authorizationToken } =
        await import('@nocobase/app-plugin-authorization/server');
      const services: R022QuotationUpgradeServices = {
        authorization: app.container.resolve(authorizationToken) as unknown as R022QuotationUpgradeServices['authorization'],
      };
      return await upgradeR022Quotation(services, { info: (message) => this.log(message) });
    });
  }
}
