import type { Application } from '@nocobase/app-server/application';
import type { AppRuntimeContext } from '@nocobase/app-server/runtime';

import devToolsConfig from '../config/dev-tools.js';
import DevAccountSwitcherProvider from '../providers/dev-account-switcher.js';
import { apiRoutes as devAccountSwitcherRoutes } from '../routes/dev-account-switcher.js';

/**
 * 开发工具的登记入口（R-073）。
 *
 * 开发工具不在主组合里：`routes/index.ts`、`providers/index.ts`、`config/index.ts` 都不引用它们。
 * 只有 `server/embedded.ts` 在开发环境里动态引入这一个文件，再把三样东西挂到应用上。部署产物里
 * 没有这个文件，非开发环境走不到，所以缺文件不会让生产启动崩。
 *
 * 必须在应用启动之前调用：框架不在启动之后接受新的路由贡献，服务提供者也要在启动前登记完。
 * 它跟在主组合的提供者之后：演示账户也是「人」，建人要用的基线角色提供者已经在前面了。
 */
export function registerDevTools(
  runtime: AppRuntimeContext,
  app: Application,
): void {
  app.config.mergeDefaults({ devTools: devToolsConfig(runtime) });
  // 不声明这一节，`accountSwitcher.enabled` 就不会发布到公开配置，客户端的开关读不到。
  const rules = devToolsConfig.rules;
  if (rules) runtime.config.defineSections(new Map([['devTools', rules]]));
  app.addServiceProvider(DevAccountSwitcherProvider);
  app.addRoutes(devAccountSwitcherRoutes);
}
