import type { ClientApplication } from '@nocobase/app-client';
import { defineClientPlugin } from '@nocobase/app-client/plugins';
import { ServiceProvider } from '@nocobase/service-provider';

import { devAccountSwitcherSectionToken } from '../../layouts/user-menu-section.js';
import { DevAccountSwitcher } from './section.js';

/**
 * R-037 的客户端扩展：把「切换账户」那一段登记给头像菜单。
 *
 * 登记的开关由组合方传入（`client/plugins.ts` 传 `import.meta.env.DEV`）。关着时不贡献
 * 任何东西：头像菜单按 service token 找这一段，token 不存在，整段不渲染。
 *
 * 为什么不是组合里用条件展开把这一项摘掉：应用的 Vite 插件解析
 * `defineClientPlugins([...])` 时要求每一项都是显式的工厂调用，条件展开会让构建直接失败。
 */
export interface DevAccountSwitcherOptions {
  /** 是否登记这一段。开发构建传 `import.meta.env.DEV`。 */
  readonly enabled: boolean;
}

class DevAccountSwitcherProvider extends ServiceProvider<ClientApplication> {
  public readonly name: string = 'app-local/dev-tools/dev-account-switcher';

  public override register(): void {
    this.app.container.instance(
      devAccountSwitcherSectionToken,
      DevAccountSwitcher,
    );
  }
}

const devAccountSwitcher =
  /* @__PURE__ */ defineClientPlugin<DevAccountSwitcherOptions>({
    // 这个扩展归应用自己所有，不是安装的包，所以用应用的包名。
    packageName: 'app-local',
    serviceProviders: ({ enabled }) =>
      enabled ? [DevAccountSwitcherProvider] : [],
  });

export default devAccountSwitcher;
