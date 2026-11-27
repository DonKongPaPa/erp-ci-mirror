import type { Application } from '@nocobase/app-server/application';
import { ServiceProvider } from '@nocobase/service-provider';

import { isDevelopmentNodeEnv } from '../node-env.js';

/**
 * 生产常驻的启动守卫：开发工具的开关在非开发环境必须关着（R-037 的约束，R-073 之后由这里守）。
 *
 * 开发工具（演示账户、两个调试接口、`devTools` 配置节）只在开发环境由登记入口挂上
 * （`server/embedded.ts`），部署产物里没有那些模块。这条约束不跟着模块走：配置里写了
 * `devTools.accountSwitcher.enabled: true` 而环境不是开发时，应用照样启动失败 —— 悄悄忽略会让人
 * 以为它在生效。它是第二道防线，第一道是构建脚本对产物断言「没有」。
 *
 * 直接读配置的原始值，不经过开发工具的配置节：那一节在非开发环境不登记，这个文件也不能引用它
 * （产物里没有那个模块，引用了启动就崩）。
 */
export default class DevToolsGuardProvider extends ServiceProvider<Application> {
  public readonly name: string = 'app.dev-tools-guard';

  public override async boot(): Promise<void> {
    if (isDevelopmentNodeEnv(this.app.nodeEnv)) return;
    const switcher = this.app.config.get<{
      accountSwitcher?: { enabled?: unknown };
    }>('devTools')?.accountSwitcher;
    if (switcher?.enabled === true) {
      throw new Error(
        '开发工具不能在生产环境开启：devTools.accountSwitcher.enabled 只在开发环境（NODE_ENV=development）可用。',
      );
    }
  }
}
