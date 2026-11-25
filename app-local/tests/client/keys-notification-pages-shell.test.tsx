import { resolveAppClientContributions } from '@nocobase/app-client/plugins';
import notificationInApp from '@nocobase/app-plugin-notification-in-app/client';
import { screen } from '@testing-library/react';
import { Route, Routes } from 'react-router';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import enUS from '../../client/locales/en-US.js';
import { AppLayout } from '../../client/layouts/app-layout.tsx';
import {
  createAppSidebarPreferenceStore,
  SidebarPreferenceProvider,
} from '../../client/layouts/use-sidebar-preference.ts';
import { renderRouteTree } from '../../client/routing/route-tree.tsx';
import { createApplicationRoutes } from '../../client/routes.ts';
import packageMetadata from '../../package.json' with { type: 'json' };
import { createAuthenticatedClientRenderer } from '../helpers/authenticated-client.js';

/**
 * R-032 / R-034：三个新页面在真实的应用外壳里、经由真实的注册路由把页面组件渲染出来。
 *
 * 只断言路由清单，发现不了「页面在自己的外壳里根本渲染不了」：清单照样是绿的，页面却打不开（R-042 的五页就是这样）。
 * 这里的外壳是 `AppClientProviders` 提供的应用上下文 + `AppLayout` + 应用自己的 `renderRouteTree`；
 * `createAuthenticatedClientRenderer` 起的是真实的应用（进程内服务端、真实会话、真实授权与真实 API）。
 *
 * 不含登录闸门（`RequiredAuthentication` / `SessionPreparation`）：它挡在页面之前，与页面组件拿不拿得到应用上下文无关；
 * 同一个渲染树的其余部分与 `AppRouter` 的已登录分支一致。
 */
const routes = resolveAppClientContributions([
  {
    packageName: packageMetadata.name,
    routes: createApplicationRoutes({}),
    source: 'application',
  },
]).routes;

const render = createAuthenticatedClientRenderer();

beforeEach(() =>
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })),
);
afterEach(() => vi.unstubAllGlobals());

const pages = [
  {
    name: 'my API keys',
    path: '/account/api-keys',
    title: enUS.apiKeys.personal.title,
    content: enUS.apiKeys.personal.empty,
  },
  {
    name: 'application API keys',
    path: '/settings/api-keys',
    title: enUS.apiKeys.application.title,
    content: enUS.apiKeys.application.noAccounts,
  },
  {
    name: 'notification logs',
    path: '/settings/notifications/logs',
    title: enUS.settings.notificationLogs,
    content: enUS.notificationLogs.empty,
  },
] as const;

it.each(pages)(
  'renders the $name page at $path inside the application shell',
  async ({ name, path, title, content }) => {
    await render(
      <SidebarPreferenceProvider
        value={createAppSidebarPreferenceStore('/main')}
      >
        <Routes>
          <Route element={<AppLayout routes={routes} />}>
            {renderRouteTree(routes)}
          </Route>
        </Routes>
      </SidebarPreferenceProvider>,
      {
        route: path,
        locale: 'en-US',
        plugins: [notificationInApp()],
      },
    );

    // 页面自己的标题或空态出现在外壳里 —— 不是「路由存在」，而是这一页真的渲染出来了。
    expect(
      await screen.findByText(content, {}, { timeout: 10_000 }),
      `「${name}」没有在它的地址 ${path} 渲染出来`,
    ).toBeVisible();
    // 壳的失败页会顶掉页面；页面渲染不出来时这里就是那条兜底，所以每种断言都带上它。
    expect(
      screen.queryByText(/Unable to load page/),
      `「${name}」被外壳的失败页顶掉了`,
    ).toBeNull();
    // 外壳真的在：顶栏/侧栏与页面标题都在同一张屏幕上。
    expect(
      await screen.findByRole('heading', { name: title }, { timeout: 10_000 }),
      `「${name}」的标题不在页面上`,
    ).toBeVisible();
  },
);
