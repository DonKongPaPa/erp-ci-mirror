import type { AppAuthorization } from '@nocobase/app-plugin-authorization';
import { AppCommand } from '@nocobase/app-cli';
import {
  PermissionSetConflictError,
  type CreatePermissionSetInput,
} from '@nocobase/authorization/permission-sets';
import { databaseManagerToken, type DatabaseManager } from '@nocobase/db';
import type { Knex } from 'knex';

import { REPORT_DEFINITIONS } from '../../server/providers/report-definitions.js';

/**
 * R-078：已有环境跑 `pnpm nocobase authz upgrade-r078-reports`。
 *
 * 给五个现成角色补报表中心四个入口动作，并把第一批 23 张定义补进定义表。
 * 幂等、带 revision、声明对不上整条跳过、只加不改；不建角色、不写用户指派，
 * 重跑一个字不写。数据权限仍由每张定义的 baseActions 与列动作裁定。
 */
export const TARGETS = [
  'finance', 'purchase', 'sales', 'warehouse', 'planning',
] as const;
export const RESOURCE = 'reports';
export const ACTIONS = ['view', 'run', 'export', 'favorite'] as const;

export interface UpgradeLogger { info(message: string): void }
export interface R078UpgradeReport {
  readonly targets: readonly string[];
  readonly changed: readonly string[];
  readonly unchanged: readonly string[];
  readonly missing: readonly string[];
  readonly invalid: readonly string[];
  readonly definitionsInserted: number;
}
export interface R078UpgradeServices {
  readonly authorization: Pick<AppAuthorization, 'permissionSets' | 'compositeResources'>;
  readonly database?: DatabaseManager;
}
interface StoredGrantAction { action: string; policy?: unknown }
interface StoredGrant { resource: { type: string; id: string }; actions: StoredGrantAction[] }
interface StoredSet { readonly revision?: string; readonly grants: CreatePermissionSetInput['grants'] }

export function neededGrants(): StoredGrant[] {
  return [{
    resource: { type: 'composite', id: RESOURCE },
    actions: ACTIONS.map((action) => ({ action })),
  }];
}

function validate(authz: R078UpgradeServices['authorization']): string | undefined {
  for (const action of ACTIONS) {
    if (!authz.compositeResources.getAction(RESOURCE, action)) return `unknown ${RESOURCE} action ${action}`;
    const problem = authz.compositeResources.validateGrant({
      resource: { type: 'composite', id: RESOURCE }, action, policy: undefined,
    });
    if (problem !== undefined) return problem;
  }
  return undefined;
}

function hasAll(stored: readonly StoredGrant[], candidate: StoredGrant): boolean {
  return stored.some((entry) =>
    entry.resource.type === candidate.resource.type &&
    entry.resource.id === candidate.resource.id &&
    candidate.actions.every((action) => entry.actions.some((have) =>
      have.action === action.action &&
      JSON.stringify(have.policy) === JSON.stringify(action.policy))));
}

async function updateWithRevision(
  authz: R078UpgradeServices['authorization'], target: string,
  set: StoredSet, grants: CreatePermissionSetInput['grants'], logger: UpgradeLogger,
): Promise<void> {
  if (set.revision === undefined) {
    logger.info(`[r078] ${target}: no revision; refusing to overwrite; nothing written`);
    throw new Error(`[r078] ${target}: permission set has no revision; reload and rerun`);
  }
  try {
    await authz.permissionSets.update(target, { key: target, grants }, set.revision);
  } catch (error) {
    logger.info(error instanceof PermissionSetConflictError
      ? `[r078] ${target}: revision changed since read; nothing written`
      : `[r078] ${target}: update failed; nothing written`);
    throw error;
  }
}

async function upsertDefinitions(database: DatabaseManager, logger: UpgradeLogger): Promise<number> {
  const knex = await database.connection().client<Knex>();
  let inserted = 0;
  for (const definition of REPORT_DEFINITIONS) {
    const exists = await knex<{ key: string }>('report_definitions').where({ key: definition.key }).first();
    if (exists !== undefined) continue;
    await knex('report_definitions').insert({
      id: definition.id, key: definition.key, title_key: definition.titleKey,
      category: definition.category, dimensions: JSON.stringify(definition.dimensions),
      measures: JSON.stringify(definition.measures), columns: JSON.stringify(definition.columns),
      base_actions: JSON.stringify(definition.baseActions), source: definition.source,
      status: definition.status, created_at: new Date(), updated_at: new Date(),
    });
    inserted += 1;
  }
  logger.info(`[r078] definitions inserted: ${inserted}`);
  return inserted;
}

export async function upgradeReports(
  services: R078UpgradeServices, logger: UpgradeLogger,
): Promise<R078UpgradeReport> {
  const { authorization: authz } = services;
  const changed: string[] = [];
  const unchanged: string[] = [];
  const missing: string[] = [];
  const invalid: string[] = [];
  const problem = validate(authz);
  if (problem !== undefined) {
    logger.info(`[r078] declaration mismatch: ${problem}; nothing written`);
    return { targets: [...TARGETS], changed, unchanged, missing, invalid: [...TARGETS], definitionsInserted: 0 };
  }
  const candidate = neededGrants()[0]!;
  const sets = await authz.permissionSets.list();
  for (const target of TARGETS) {
    const set = sets.find((entry) => entry.key === target);
    if (set === undefined) {
      logger.info(`[r078] ${target}: role missing; nothing written`);
      missing.push(target);
      continue;
    }
    const stored = structuredClone(set.grants) as unknown as StoredGrant[];
    if (hasAll(stored, candidate)) {
      logger.info(`[r078] ${target}: already has all grants; nothing written`);
      unchanged.push(target);
      continue;
    }
    await updateWithRevision(
      authz, target, set as StoredSet,
      [...stored, candidate] as unknown as CreatePermissionSetInput['grants'], logger,
    );
    changed.push(target);
  }
  const definitionsInserted = services.database === undefined
    ? 0 : await upsertDefinitions(services.database, logger);
  return { targets: [...TARGETS], changed, unchanged, missing, invalid, definitionsInserted };
}

export default class AuthzUpgradeR078Reports extends AppCommand {
  static summary = 'Grant report-center entry actions to the five business roles (existing installations).';

  static description =
    'Seed only runs on new installations. This command grants reports.view/run/export/favorite to finance, purchase, sales, warehouse and planning, and inserts the first batch of report definitions. It creates no role, writes no user assignment, rewrites no existing grant, carries the revision it read, and writes nothing on a second run or a declaration mismatch.';

  static examples = ['<%= config.bin %> <%= command.id %>'];

  async run(): Promise<R078UpgradeReport> {
    await this.parse(AuthzUpgradeR078Reports);
    return await this.withApp(async ({ app }) => {
      await app.start();
      const { authorizationToken } =
        await import('@nocobase/app-plugin-authorization/server');
      return await upgradeReports({
        authorization: app.container.resolve(authorizationToken) as unknown as R078UpgradeServices['authorization'],
        database: app.container.resolve(databaseManagerToken),
      }, { info: (message) => this.log(message) });
    });
  }
}
