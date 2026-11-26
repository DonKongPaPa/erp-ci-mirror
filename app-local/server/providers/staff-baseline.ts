import type { AppPluginApplication } from '@nocobase/app-server/plugins';
import { authenticationToken } from '@nocobase/app-plugin-authentication/server';
import {
  authorizationToken,
  type AppAuthorization,
} from '@nocobase/app-plugin-authorization/server';
import { loggingToken } from '@nocobase/app-server/logging';
import type { DatabaseConnection } from '@nocobase/db';
import { ServiceProvider } from '@nocobase/service-provider';

/**
 * R-026：`staff` 是提交反馈的基线角色，建「人」的账号时自动指派。
 *
 * 框架的 `addUserInitializer`（`app-plugin-authentication/dist/server/auth.js` 的
 * `addUserInitializer`，由 `app-plugin-authorization/dist/server/providers/authorization.js`
 * 用它给非服务账号指派 `member`）是唯一同时盖住自助注册与管理员建人的钩子。这里照同一处
 * 注册顺序再加一个初始化器，只做一件事：非服务账号补上 `staff`。
 *
 * 指派放在建人事务提交之后（`connection.afterCommit`），不在插入事务里，理由是
 * 用户管理服务的建人路径（`app-plugin-users/dist/server/services/users.js` 的 `create`）
 * 在插入之后还会按提交上来的 `roleScopes` **整体替换**直接角色；设置界面的角色选择器
 * 默认就把 `member` 一起提交，替换时会把插入事务里刚给的 `staff` 抹掉。放在提交之后，
 * 无论管理员建人（含界面默认提交）、自助注册还是接受邀请，都留下基线角色。
 *
 * 幂等：已有 `staff` 的不重复指派。失败不阻塞建人：记一条带用户标识的 error 就返回 ——
 * 「账号建不出来」比「暂时提交不了反馈、可补」更糟；存量账号由 `authz upgrade-r026` 补。
 */
export const STAFF_PERMISSION_SET = 'staff';

export interface StaffBaselineLogger {
  error(bindings: Record<string, unknown>, message: string): void;
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 没有就指派，已有就跳过。返回这次是否写了一条赋值。
 *
 * 单独成函数是为了能让测试直接调两次验证幂等，也让调用方不必重复失败处理：
 * 出错只记日志、不往外抛。
 */
export async function assignStaffBaseline(
  authz: Pick<AppAuthorization, 'permissionSets'>,
  userId: string,
  logger: StaffBaselineLogger,
): Promise<boolean> {
  try {
    const sets = authz.permissionSets;
    const existing = (await sets.listAssignments(STAFF_PERMISSION_SET)).some(
      (assignment) =>
        assignment.subject.type === 'user' && assignment.subject.id === userId,
    );
    if (existing) {
      return false;
    }
    await sets.assign({
      subject: { type: 'user', id: userId },
      permissionSet: STAFF_PERMISSION_SET,
    });
    return true;
  } catch (error) {
    logger.error(
      {
        userId,
        permissionSet: STAFF_PERMISSION_SET,
        reason: reasonOf(error),
      },
      'R-026: could not assign the staff baseline role at user creation; the account was created without it. Run "nocobase authz upgrade-r026" to fill it in.',
    );
    return false;
  }
}

export type StaffBaselineInitializer = (
  user: Record<string, unknown>,
  connection: DatabaseConnection,
) => Promise<void>;

/** 建人初始化器：服务账号跳过，其余账号在事务提交之后补基线角色。 */
export function createStaffBaselineInitializer(
  authz: Pick<AppAuthorization, 'permissionSets'>,
  logger: StaffBaselineLogger,
): StaffBaselineInitializer {
  return async (user, connection) => {
    if (user.kind === 'service') {
      return;
    }
    const userId = String(user.id);
    try {
      connection.afterCommit(async () => {
        await assignStaffBaseline(authz, userId, logger);
      });
    } catch (error) {
      // 连「提交后执行」都挂不上时也不能让建人失败。
      logger.error(
        {
          userId,
          permissionSet: STAFF_PERMISSION_SET,
          reason: reasonOf(error),
        },
        'R-026: could not schedule the staff baseline assignment after user creation; the account was created without it. Run "nocobase authz upgrade-r026" to fill it in.',
      );
    }
  };
}

export default class StaffBaselineProvider extends ServiceProvider<AppPluginApplication> {
  readonly name = 'app.staff-baseline';

  private removeUserInitializer?: () => void;

  override boot(): Promise<void> {
    // 认证插件或授权插件不在时没有可挂的钩子：模板允许把它们从组合里去掉。
    if (
      !this.app.container.has(authenticationToken) ||
      !this.app.container.has(authorizationToken)
    ) {
      return Promise.resolve();
    }
    const authz = this.app.container.resolve(authorizationToken);
    const logger: StaffBaselineLogger = this.app.container.has(loggingToken)
      ? this.app.container.resolve(loggingToken).getLogger('app')
      : {
          error: (bindings, message) => console.error(message, bindings),
        };
    const auth = this.app.container.resolve(authenticationToken);
    // boot() 可以被调用两次：先撤掉上一次的初始化器，避免同一条指派跑两遍。
    this.removeUserInitializer?.();
    this.removeUserInitializer = auth.addUserInitializer(
      createStaffBaselineInitializer(authz, logger),
    );
    return Promise.resolve();
  }
}
