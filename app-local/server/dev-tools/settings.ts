import type { Application } from '@nocobase/app-server/application';

import type { DevToolsConfig } from '../config/dev-tools.js';

/**
 * R-037 开发工具的开关判定。启动时的检查与路由的挂载条件都从这里读，两处不会给出不同的答案。
 */

/** 框架把 `develop` 与 `development` 当作开发环境（`@nocobase/app-server` 的 jobs provider）。 */
const DEVELOPMENT_ENVIRONMENTS: readonly string[] = ['develop', 'development'];

/** 缺失的环境标记按生产对待：手工组装的应用可能不带它，拿不准就当它是最严的那一档。 */
export function isDevelopmentNodeEnv(nodeEnv: string | undefined): boolean {
  return nodeEnv !== undefined && DEVELOPMENT_ENVIRONMENTS.includes(nodeEnv);
}

/** 配置写了开启、且是开发环境。两个接口只在这个条件下存在。 */
export function isDevAccountSwitcherEnabled(
  app: Pick<Application, 'config' | 'nodeEnv'>,
): boolean {
  const config = app.config.get<DevToolsConfig>('devTools');
  return (
    config?.accountSwitcher?.enabled === true &&
    isDevelopmentNodeEnv(app.nodeEnv)
  );
}

/** 配置是否写了开启，不看环境。启动失败那条判断用它。 */
export function isDevAccountSwitcherConfigured(
  app: Pick<Application, 'config'>,
): boolean {
  return (
    app.config.get<DevToolsConfig>('devTools')?.accountSwitcher?.enabled ===
    true
  );
}
