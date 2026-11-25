import { resolveAppClientContributions } from '@nocobase/app-client/plugins';
import agents from '@nocobase/app-plugin-agents/client';
import notificationInApp from '@nocobase/app-plugin-notification-in-app/client';
import { screen } from '@testing-library/react';
import { Route, Routes } from 'react-router';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { AppLayout } from '../../client/layouts/app-layout.tsx';
import {
  createAppSidebarPreferenceStore,
  SidebarPreferenceProvider,
} from '../../client/layouts/use-sidebar-preference.ts';
import applicationRoutes from '../../client/routes.js';
import { renderRouteTree } from '../../client/routing/route-tree.tsx';
import { createAuthenticatedClientRenderer } from '../helpers/authenticated-client.js';

/**
 * R-042 第 8 条：AI 五页在真实的应用外壳里渲染。
 *
 * 页面组件由插件提供，运行时通过 `withAgents` 取应用的服务（`useService`）、翻译（`useTranslation`）
 * 与授权（`useCan`）。只断言路由清单不够：这五页必须在应用的外壳（`AppClientProviders` 提供的应用
 * 上下文 + `AppLayout` + 应用自己的 `renderRouteTree`）里渲染出来，并显示自己的空态。
 * `createAuthenticatedClientRenderer` 起的是真实的应用（进程内服务端、真实会话、真实授权与真实 API）。
 *
 * 外壳里的登录闸门（`RequiredAuthentication` / `SessionPreparation`）不在这里：它挡在页面之前，
 * 与页面组件拿不拿得到应用上下文无关；同一个渲染树的其余部分与 `AppRouter` 的已登录分支一致。
 */
const routes = resolveAppClientContributions([
  {
    packageName: 'app-local',
    routes: applicationRoutes,
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
    name: 'models',
    path: '/models',
    emptyState: /No model service yet/,
    action: 'Add service',
  },
  {
    name: 'agents',
    path: '/agents',
    emptyState: /To add an agent/,
    action: 'Add agent',
  },
  {
    name: 'runtimes',
    path: '/runtimes',
    emptyState: /No runtimes connected yet/,
  },
  {
    name: 'skills',
    path: '/skills',
    emptyState: /No skills yet/,
  },
  {
    name: 'usage',
    path: '/usage',
    emptyState: /No runs in this period/,
  },
] as const;

it.each(pages)(
  'renders the $name page at $path inside the application shell',
  async ({ path, emptyState, action }) => {
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
        plugins: [agents(), notificationInApp()],
      },
    );

    // 每个用例起的是真实的进程内服务端；全量并跑时首个响应会超过 findBy 默认的 1 秒
    // （实测「用量」页单跑通过、在全量里等不到）。断言不变，只是等得久一点。
    expect(await screen.findByText(emptyState, {}, { timeout: 15_000 })).toBeVisible();
    // The shell's failure state replaces the page when its module cannot render; this is the defect R-042
    // shipped with, so each page asserts its own empty state rather than only that the route exists.
    expect(screen.queryByText(/Unable to load page/)).toBeNull();
    if (action)
      expect(
        await screen.findByRole('button', { name: action }, { timeout: 15_000 }),
      ).toBeVisible();
  },
  20_000,
);
