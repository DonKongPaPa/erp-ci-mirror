import type { Application } from '@nocobase/app-server/application';
import {
  resolveAppRuntime,
  startApplicationInScope,
  type AppDisposer,
  type AppScope,
} from '@nocobase/app-server/runtime';

import { createApp } from './app.js';
import { isDevelopmentNodeEnv } from './node-env.js';
import appRuntime from './runtime.js';

export type { AppDisposer, AppScope };

export type EmbeddedServer = Application;

export async function createServer(scope: AppScope): Promise<EmbeddedServer> {
  const runtime = await resolveAppRuntime(appRuntime, scope);
  const app = createApp(runtime);
  // R-073：开发工具（演示账户、两个调试接口、devTools 配置节）不在主组合里，只在开发环境由独立的
  // 登记入口挂上。部署产物里没有那个模块：非开发环境走不到这一行，所以缺文件不会让生产启动崩。
  if (isDevelopmentNodeEnv(runtime.env.NODE_ENV)) {
    const { registerDevTools } = await import('./dev-tools/register.js');
    registerDevTools(runtime, app);
  }

  return startApplicationInScope(scope, app);
}

export default createServer;
