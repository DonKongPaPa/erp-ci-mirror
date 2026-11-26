import type {
  AppClientRouteComponentLoader,
  AppClientRouteComponentModule,
} from '@nocobase/app-client/plugins';

/**
 * R-026：对话框是框架在页面模块就绪前打开的。模块若只在 `useEffect` 里取，第一次绘制
 * 只能是宿主占位（量到 220.8px），随后换成表单时顶边跳变。这里按 loader 函数身份记住
 * 已经在内存里的模块，让 `ClientRoute` 的 state 初值就能拿到它，首次 render 直接出页面。
 *
 * 单独的轻量模块：入口路由表（以及 project 档的纯 Node 测试）可以同步填缓存，而不必把
 * 带 React 组件的 `client-route.tsx` 拖进依赖图。
 */
const readyModules = new WeakMap<
  AppClientRouteComponentLoader,
  AppClientRouteComponentModule
>();

/** 同步填缓存；要在任何路由渲染之前调用。 */
export function primeClientRouteModule(
  loader: AppClientRouteComponentLoader,
  module: AppClientRouteComponentModule,
): void {
  readyModules.set(loader, module);
}

/** `ClientRoute` 首次渲染与测试共用的读缓存入口。 */
export function cachedClientRouteModule(
  loader: AppClientRouteComponentLoader,
): AppClientRouteComponentModule | undefined {
  return readyModules.get(loader);
}
