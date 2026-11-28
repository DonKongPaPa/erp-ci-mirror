import { useClientApplication } from '@nocobase/app-client';
import { useSyncServerLocale } from '@nocobase/app-plugin-i18n/client';
import { createElement, useMemo, type ReactElement } from 'react';
import type { AppClientRegisteredRoute } from '@nocobase/app-client/plugins';
import { Outlet, useLocation } from 'react-router';

import { BrandWatermark } from '#components/brand-watermark';
import { Breadcrumbs } from '#components/breadcrumbs';

import { RouteTreeProvider } from '../routing/route-context.js';
import { RouteLeaveBoundary } from '../routing/route-leave-boundary.js';

import { PageBreadcrumbProvider } from '@nocobase/app-client';
import { useTranslation } from '@nocobase/i18n/client';
import { LayoutHeader } from './components/layout-header.js';
import {
  AppSidebar,
  AppSidebarProvider,
  AppSidebarToggle,
} from './components/app-sidebar.js';
import { NavigationMenu } from './components/navigation-menu.js';
import { HeaderActions } from './components/header-actions.js';
import { AppSidebarFooter } from './components/sidebar-footer.js';
import {
  useRouteNavigation,
  selectedNavigationId,
} from '../routing/route-navigation.js';
import { extensionOverlayToken } from './extension-overlay.js';

export interface AppLayoutProps {
  readonly routes: readonly AppClientRegisteredRoute[];
}

export function AppLayout({ routes }: AppLayoutProps): ReactElement {
  // The browser decides what it renders; this tells the server the same language so its messages match.
  useSyncServerLocale();

  const app = useClientApplication();
  // 扩展追加的浮层只在开发构建里登记（见 `client/extensions/development-extensions.ts`）。
  // 用 createElement 而不是在渲染里造组件标签：布局自己不认识这段 UI，也不静态引入它的代码。
  const overlay = app.container.has(extensionOverlayToken)
    ? createElement(app.container.resolve(extensionOverlayToken))
    : null;
  const { t } = useTranslation();
  const { items: menuItems, denied, loading } = useRouteNavigation(routes);
  const access = useMemo(() => ({ denied, loading }), [denied, loading]);
  const selectedKey = selectedNavigationId(
    routes,
    useLocation().pathname,
    denied,
  );
  const navigationLabel = t('navigation.label', {
    defaultValue: 'Application navigation',
  });

  return (
    // The shell owns the business route tree used by its pages and navigation.
    <RouteTreeProvider routes={routes} access={access}>
      <PageBreadcrumbProvider>
        <AppSidebarProvider>
          <AppSidebar label={navigationLabel} footer={<AppSidebarFooter />}>
            <NavigationMenu
              items={menuItems}
              label={navigationLabel}
              selectedKey={selectedKey}
            />
          </AppSidebar>
          <div className='flex min-w-0 flex-1 flex-col'>
            <LayoutHeader className='sticky top-0 z-40 justify-between'>
              <div className='flex min-w-0 items-center gap-3'>
                <AppSidebarToggle />
                <div className='h-5 w-px shrink-0 bg-border' />
                {/* The current page's trail: the route tree's, or the one the page declares (`usePageBreadcrumb`). */}
                <Breadcrumbs denied={denied} />
              </div>
              <HeaderActions />
            </LayoutHeader>
            <main className='app-brand-surface relative isolate min-w-0 flex-1 overflow-hidden'>
              <BrandWatermark className='-z-10' />
              {/* main only positions; the page scrolls in here, so a child page layer laid over main is neither
            moved by the page's scrolling nor stretched by its height. */}
              <div className='h-full overflow-y-auto'>
                <RouteLeaveBoundary hidden={loading}>
                  <Outlet />
                </RouteLeaveBoundary>
              </div>
            </main>
          </div>
        </AppSidebarProvider>
        {overlay ? (
          <div className='fixed bottom-4 right-4 z-50 print:hidden'>{overlay}</div>
        ) : null}
      </PageBreadcrumbProvider>
    </RouteTreeProvider>
  );
}
