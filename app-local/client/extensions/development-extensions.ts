import type { ClientApplication } from '@nocobase/app-client';
import {
  defineAppRoutes,
  defineClientPlugin,
} from '@nocobase/app-client/plugins';
import { ServiceProvider } from '@nocobase/service-provider';

/**
 * 开发环境专用的扩展（R-037 的账号切换器）进客户端组合的唯一入口。生产常驻，本身不含任何扩展的代码。
 *
 * 组合数组里只放这一项工厂调用（应用的 Vite 插件要求每一项都是显式的工厂调用，条件展开会让构建失败）。
 * 它的提供者在启动时才去引入开发扩展：`import.meta.env.DEV` 在生产构建里是常量假，下面那个分支连同
 * 被引入的模块一起不进模块图 —— 不是「进了包只是没登记」，是包里没有（R-073）。
 *
 * 放在 `start()` 里而不是 `register()` 里：动态引入只能异步，而应用要等所有提供者的 start 跑完才开始
 * 渲染，所以头像菜单第一次出现时，那一段已经登记好了。
 */
class DevelopmentExtensionsProvider extends ServiceProvider<ClientApplication> {
  public readonly name: string = 'app-local/development-extensions';

  public override async start(): Promise<void> {
    if (!import.meta.env.DEV) return;
    const extension = await import('./dev-account-switcher/index.js');
    extension.registerDevAccountSwitcher(this.app);
  }
}

const developmentExtensions = /* @__PURE__ */ defineClientPlugin({
  // 这个入口归应用自己所有，不是安装的包，所以用应用的包名。
  packageName: 'app-local',
  serviceProviders: () => [DevelopmentExtensionsProvider],
  // R-082：看板的路由也只在开发构建里存在。框架没有运行时加路由的入口，所以在这个生产常驻的
  // 插件上声明；`import.meta.env.DEV` 在生产构建里是常量假，整段分支（含 componentLoader 的
  // 动态引入）一起被摇掉 —— 不是「进了包只是没登记」，是模块图里没有（R-073）。
  routes: () => {
    if (!import.meta.env.DEV) return defineAppRoutes([]);
    return defineAppRoutes([
      {
        name: 'devRequirementsBoard',
        path: '/dev/requirements-board',
        auth: 'required',
        authz: 'unrestricted',
        componentLoader: () => import('./dev-requirements-board/index.js'),
      },
    ]);
  },
});

export default developmentExtensions;
