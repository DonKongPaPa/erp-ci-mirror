import type { AppAuthorization } from '@nocobase/app-plugin-authorization';
import { AppCommand } from '@nocobase/app-cli';
import {
  PermissionSetConflictError,
  type CreatePermissionSetInput,
} from '@nocobase/authorization/permission-sets';

/**
 * R-070 页面片的升级步骤：`pnpm nocobase authz upgrade-r070-iqc-pages`。
 *
 * seed 只对新建环境生效；已有环境里的质量员、质量主管、采购打不开检验单页。这条命令
 * 给这三个角色各补一条 `inspectionOrders` 页面授权，仓管刻意不补（他只用 receiveView
 * 窄读在建入库单时选单，开页面就宽了）。业务动作由 `upgrade-r070-iqc` 负责，本命令不碰。
 *
 * 幂等：第二次什么都不写，revision 也不变。只加不改、不建角色、不补用户指派。写入带读到的
 * revision：读到之后有人改过角色就报错退出、重载重跑，不覆盖别人的改动。
 */
/** 页面 id 与 `client/pages/inspections/page-id.ts` 是同一个值，守门测试钉住。 */
export const INSPECTIONS_PAGE_ID = 'inspectionOrders';
export const TARGETS = [
  'quality_inspector',
  'quality_manager',
  'purchase',
] as const;

export interface R070IqcPageUpgradeReport {
  readonly targets: readonly string[];
  readonly changed: readonly string[];
  readonly unchanged: readonly string[];
  readonly missing: readonly string[];
}

export interface R070IqcPageUpgradeServices {
  readonly authorization: Pick<
    AppAuthorization,
    'permissionSets' | 'pages'
  >;
}

interface StoredGrantAction {
  action: string;
  policy?: { type: string };
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

/** 「已有」必须是不带 policy 的 access：带条件的页面授权框架不放行。 */
function hasPageAccess(grants: readonly StoredGrant[], id: string): boolean {
  return grants.some(
    (grant) =>
      grant.resource.type === 'page' &&
      grant.resource.id === id &&
      grant.actions.some(
        (entry) => entry.action === 'access' && entry.policy === undefined,
      ),
  );
}

export async function upgradeR070IqcPage(
  services: R070IqcPageUpgradeServices,
  logger: { info(message: string): void },
): Promise<R070IqcPageUpgradeReport> {
  const { authorization: authz } = services;
  const changed: string[] = [];
  const unchanged: string[] = [];
  const missing: string[] = [];
  const sets = await authz.permissionSets.list();
  for (const target of TARGETS) {
    const set = sets.find((entry) => entry.key === target) as StoredSet | undefined;
    if (set === undefined) {
      logger.info(`[r070-iqc-pages] ${target}: role missing; nothing written`);
      missing.push(target);
      continue;
    }
    const next = structuredClone(set.grants) as unknown as StoredGrant[];
    if (hasPageAccess(next, INSPECTIONS_PAGE_ID)) {
      logger.info(
        `[r070-iqc-pages] ${target}: already has the ${INSPECTIONS_PAGE_ID} page; nothing written`,
      );
      unchanged.push(target);
      continue;
    }
    next.push(authz.pages.grant(INSPECTIONS_PAGE_ID) as unknown as StoredGrant);
    if (set.revision === undefined) {
      logger.info(
        `[r070-iqc-pages] ${target}: no revision on the stored set; refusing to overwrite; nothing written`,
      );
      throw new Error(
        `[r070-iqc-pages] ${target}: permission set has no revision; reload and rerun`,
      );
    }
    try {
      await authz.permissionSets.update(
        target,
        {
          key: target,
          ...(set.title === undefined ? {} : { title: set.title }),
          grants: next as unknown as CreatePermissionSetInput['grants'],
        },
        set.revision,
      );
    } catch (error) {
      logger.info(
        error instanceof PermissionSetConflictError
          ? `[r070-iqc-pages] ${target}: revision changed since read; nothing written; reload and rerun`
          : `[r070-iqc-pages] ${target}: update failed; nothing written; reload and rerun`,
      );
      throw error;
    }
    logger.info(`[r070-iqc-pages] ${target}: added the ${INSPECTIONS_PAGE_ID} page`);
    changed.push(target);
  }
  logger.info(`[r070-iqc-pages] added: ${changed.join(',') || '(none)'}`);
  return { targets: [...TARGETS], changed, unchanged, missing };
}

export default class AuthzUpgradeR070IqcPages extends AppCommand {
  static summary =
    'Give the quality and purchase permission sets the incoming-inspection page (existing installations).';

  static description =
    'Seed only runs on new installations. This command adds the inspectionOrders page grant to quality_inspector, quality_manager and purchase. The warehouse set is deliberately left out: it uses the receiveView narrow read to pick an inspection when creating a purchase receipt, and opening the page would be broader than needed. Business actions come from upgrade-r070-iqc and are not touched here. It creates no role, writes no user assignment, changes no existing grant, and writes nothing on a second run. Writes carry the revision that was read: a concurrent edit is reported instead of overwritten.';

  static examples = ['<%= config.bin %> <%= command.id %>'];

  async run(): Promise<R070IqcPageUpgradeReport> {
    await this.parse(AuthzUpgradeR070IqcPages);
    return await this.withApp(async ({ app }) => {
      await app.start();
      const { authorizationToken } =
        await import('@nocobase/app-plugin-authorization/server');
      const services: R070IqcPageUpgradeServices = {
        authorization: app.container.resolve(
          authorizationToken,
        ) as unknown as R070IqcPageUpgradeServices['authorization'],
      };
      return await upgradeR070IqcPage(services, {
        info: (message) => this.log(message),
      });
    });
  }
}
