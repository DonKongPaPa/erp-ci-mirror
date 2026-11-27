import type { Application } from '@nocobase/app-server/application';

import type { DevToolsConfig } from '../config/dev-tools.js';
import { isDevelopmentNodeEnv } from '../node-env.js';

/**
 * R-037 开发工具的开关判定：路由的挂载条件从这里读。
 *
 * 这个模块只进开发环境，部署产物里没有它（R-073）。「配置开着但环境不是开发就起不来」那条约束
 * 不在这里，在生产常驻的启动守卫里（`server/providers/dev-tools-guard.ts`）：守卫不能引用这个模块。
 */

export { isDevelopmentNodeEnv };

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
