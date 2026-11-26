import { authenticationToken } from '@nocobase/app-plugin-authentication/server';
import { userManagementServiceToken } from '@nocobase/app-plugin-users/server';
import type { Application } from '@nocobase/app-server/application';
import { databaseManagerToken } from '@nocobase/db';
import { ServiceProvider } from '@nocobase/service-provider';
import { randomBytes } from 'node:crypto';

import { DEMO_ACCOUNTS, demoAccountEmail } from '../dev-tools/demo-accounts.js';
import {
  isDevAccountSwitcherConfigured,
  isDevAccountSwitcherEnabled,
} from '../dev-tools/settings.js';
import { STAFF_PERMISSION_SET } from './staff-baseline.js';

/**
 * R-037 开发工具的启动逻辑。
 *
 * 关着的时候什么都不做：不建账户。开着但环境不是开发时启动失败 —— 悄悄关掉会让人以为
 * 它在生效，宁可起不来。开着且是开发环境时建出演示账户；两个接口由路由贡献自己按同一个
 * 条件挂载（`server/routes/dev-account-switcher.ts`），框架不在启动之后接受新的路由贡献。
 */
export default class DevAccountSwitcherProvider extends ServiceProvider<Application> {
  public readonly name: string = 'app.dev-account-switcher';

  public override async boot(): Promise<void> {
    if (!isDevAccountSwitcherEnabled(this.app)) {
      if (isDevAccountSwitcherConfigured(this.app)) {
        throw new Error(
          '开发工具不能在生产环境开启：devTools.accountSwitcher.enabled 只在开发环境（NODE_ENV=development）可用。',
        );
      }
      return;
    }
    await this.ensureDemoAccounts();
  }

  /**
   * 按用户名查重，已存在就跳过；只建还没有的账户。
   * 查重不过滤停用与删除：按设计「管理员的删除要算数」，重启不自动恢复、也不另建同名用户。
   * 密码是启动时生成的长随机串，不记录、不输出：这些账户不能靠密码登录，只能靠切换进入。
   */
  private async ensureDemoAccounts(): Promise<void> {
    // 没有认证与用户插件就没有会话可签发、没有账户可建。宁可起不来，也不悄悄少挂一半。
    if (
      !this.app.container.has(authenticationToken) ||
      !this.app.container.has(userManagementServiceToken)
    ) {
      throw new Error(
        '开发工具不能启用：authentication 与 users 插件必须都在组合里。',
      );
    }
    const database = this.app.container.resolve(databaseManagerToken);
    const users = this.app.container.resolve(userManagementServiceToken);
    const connection = database.connection();

    for (const account of DEMO_ACCOUNTS) {
      const existing = await connection.query
        .selectFrom('user')
        .select('id')
        .where('username', '=', account.username)
        .executeTakeFirst();
      if (existing) {
        continue;
      }
      await users.create({
        name: account.name,
        username: account.username,
        email: demoAccountEmail(account.username),
        password: randomBytes(32).toString('base64url'),
        // R-026：演示账户里的「人」都带基线角色 staff。users.create 在建完之后按这份
        // 清单整体替换直接角色，所以不能只靠建人初始化器；显式写进来。重跑时账户已
        // 存在就跳过，不会重复指派。
        roleScopes: {
          app: [...new Set([account.role, STAFF_PERMISSION_SET])],
        },
      });
    }
  }
}
