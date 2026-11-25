import { scopedApiKeysToken } from '@nocobase/app-plugin-api-keys/server';
import {
  authorizationToken,
  type AppAuthorization,
} from '@nocobase/app-plugin-authorization/server';
import type { AppPluginApplication } from '@nocobase/app-server/plugins';
import { ServiceProvider } from '@nocobase/service-provider';

import {
  ownKeyPolicyToken,
  type OwnKeyPolicyCheck,
} from '../own-key-endpoint-guard.js';

/**
 * R-032：个人 API 密钥的「创建」与「轮换」收紧到 root（`ScopedApiKeys.setOwnKeyPolicy`）。
 *
 * 列出与吊销不受影响：丢了权限的人仍然能清理自己已有的密钥。放开给某些角色时只改
 * 这一个策略。
 *
 * 「是 root」不写死键名：授权插件把配置里的 root 集声明为 `unrestricted`（`rootSet`），
 * 所以持有任一 `unrestricted` 权限集的人就是 root。root 集只能分配给 `user` 主体，
 * 因此按用户主体读有效权限集即可，不会把 `authenticated` 的公共授予误判成 root。
 *
 * 这个策略只管应用自己的 `/api/apiKeys`。同一个插件挂在 Better Auth 下的端点
 * （`POST /api/auth/api-key/create`、`POST /api/auth/api-key/update`）读不到它：框架把策略槽
 * 存在插件对象的不可枚举 symbol 属性上（`app-plugin-api-keys` 的 `OWN_KEY_POLICY_SLOT`），
 * 配置管道每次读取都按 `Object.entries` 克隆对象（`@nocobase/config` 的
 * `cloneConfigValue`），symbol 属性在那一步被丢掉。`connectOwnKeyPolicy` 于是在
 * `auth.administrationContext()` 的插件列表里找不到槽，`/api-key/create` 的钩子读到的策略
 * 是空、直接放行。补上的守卫是 `server/own-key-endpoint-guard.ts`：应用贡献的 Better Auth
 * `hooks.before` 中间件，问的是同一个判定，管 `/api-key/create` 与 `/api-key/update` 两条
 * 端点；列表、读取、吊销不管，密钥换来的会话交给框架的钩子拒。
 *
 * 判定同时登记到容器（`ownKeyPolicyToken`）：守卫靠它知道策略在不在，不在就拒绝——不拿
 * `mayCreateOwn` 在没有策略时的默认 `true` 当放行。
 */
export default class ApiKeysPolicyProvider extends ServiceProvider<AppPluginApplication> {
  readonly name = 'app.api-keys-policy';

  private release?: () => void;

  override boot(): Promise<void> {
    // 授权插件或密钥插件不在时没有可收紧的东西；这时也不登记判定，守卫一律拒绝。
    if (
      !this.app.container.has(scopedApiKeysToken) ||
      !this.app.container.has(authorizationToken)
    ) {
      return Promise.resolve();
    }
    const keys = this.app.container.resolve(scopedApiKeysToken);
    const authz = this.app.container.resolve(authorizationToken);
    const check: OwnKeyPolicyCheck = (userId) => isRoot(authz, userId);
    // 先放旧的、再装新的：`setOwnKeyPolicy` 接受后一次、替换前一次。登记到容器的这一步不能
    // 重复：`ServiceContainer.instance` 在同一个 token 已登记时抛
    // `Service "app/own-key-policy" is already registered.`。所以真被调第二次时会先释放旧策略、
    // 装上新策略，然后在这一行抛错，容器里留下的是上一次的判定；两个判定等价（都按当前授权
    // 状态现算），当前框架也只调用一次 boot，不为这条不可达的路径加覆盖逻辑。
    this.release?.();
    this.release = keys.setOwnKeyPolicy(check);
    this.app.container.instance(ownKeyPolicyToken, check);
    return Promise.resolve();
  }

  override shutdown(): Promise<void> {
    this.release?.();
    this.release = undefined;
    return Promise.resolve();
  }
}

async function isRoot(
  authz: AppAuthorization,
  userId: string,
): Promise<boolean> {
  const effective = await authz.permissionSets.getEffective({
    principal: { type: 'user', id: userId },
  });
  return effective.some(
    (set) => authz.permissionSets.protection(set.key)?.unrestricted === true,
  );
}
