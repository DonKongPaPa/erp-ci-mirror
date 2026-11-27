import {
  AuthorizationClient,
  useCan,
  authorizationClientToken,
  type AuthorizationSnapshot,
} from '@nocobase/app-plugin-authorization/client';
import { apiClientToken } from '@nocobase/app-client';
import { resolveAppClientContributions } from '@nocobase/app-client/plugins';
import { answerApi, renderWithApp } from '@nocobase/app-testing/client';
import { screen, within } from '@testing-library/react';
import { type ReactElement } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { AppSidebarProvider } from '../../client/layouts/components/app-sidebar.tsx';
import { NavigationMenu } from '../../client/layouts/components/navigation-menu.tsx';
import {
  createAppSidebarPreferenceStore,
  SidebarPreferenceProvider,
} from '../../client/layouts/use-sidebar-preference.ts';
import { useRouteNavigation } from '../../client/routing/route-navigation.ts';
import applicationRoutes from '../../client/routes.js';
import enUS from '../../client/locales/en-US.js';
import packageMetadata from '../../package.json' with { type: 'json' };

/**
 * 页面授权（R-020 页面片）：只有业务动作、没有页面授权的人，侧栏里看不到「物料与库存」的入口，
 * 直接敲地址也被拒。用的是真实的应用路由树与应用外壳，只把 HTTP 换成夹具。
 */
const routes = resolveAppClientContributions([
  {
    packageName: packageMetadata.name,
    routes: applicationRoutes,
    source: 'application',
  },
]).routes;

/** 页面授权 id → 路径，照《基座ERP前端设计》1.3。 */
const PAGES = [
  ['stock', '/stock'],
  ['inboundOrders', '/inbound-orders'],
  ['outboundOrders', '/outbound-orders'],
  ['warehouses', '/warehouses'],
] as const;

let permissions: AuthorizationSnapshot;
const api = vi.fn((call: { path: string }) =>
  call.path === 'authorization/permissions'
    ? { data: permissions }
    : new Response(null, { status: 404 }),
);

beforeEach(() =>
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })),
);
afterEach(() => vi.unstubAllGlobals());

function services(app: {
  container: {
    singleton(
      token: unknown,
      factory: (resolver: { resolve(token: unknown): unknown }) => unknown,
    ): void;
    resolve(token: unknown): unknown;
  };
}): void {
  app.container.singleton(
    authorizationClientToken,
    (resolver) =>
      new AuthorizationClient(resolver.resolve(apiClientToken) as never),
  );
}

/** 资源动作给了，页面授权没给：这正是「有业务权限却打不开页面」的那个人。 */
const noPageGrant: AuthorizationSnapshot = {
  unrestricted: false,
  permissions: [
    {
      resource: { type: 'composite', id: 'inventory' },
      actions: ['warehouseView', 'warehouseManage'],
    },
    { resource: { type: 'composite', id: 'items' }, actions: ['view'] },
  ],
};
const withPageGrant: AuthorizationSnapshot = {
  unrestricted: false,
  permissions: [
    ...noPageGrant.permissions,
    ...PAGES.map(([id]) => ({
      resource: { type: 'page', id },
      actions: ['access'],
    })),
  ],
};

function Menu(): ReactElement {
  const { items, loading } = useRouteNavigation(routes);
  return (
    <section aria-label='Permission status' aria-busy={loading}>
      <NavigationMenu items={items} label='Navigation' selectedKey='' />
    </section>
  );
}

async function renderMenu() {
  api.mockClear();
  return renderWithApp(
    <SidebarPreferenceProvider value={createAppSidebarPreferenceStore('/main')}>
      <AppSidebarProvider>
        <Menu />
      </AppSidebarProvider>
    </SidebarPreferenceProvider>,
    {
      namespace: packageMetadata.name,
      namespaces: { [packageMetadata.name]: enUS },
      fetch: answerApi(api),
      services,
    },
  );
}

const sidebar = (): HTMLElement =>
  document.querySelector<HTMLElement>('[data-slot=sidebar]') ?? document.body;

it('hides every inventory entry and the group from someone with no page grant, and shows them with one', async () => {
  permissions = noPageGrant;
  await renderMenu();
  await vi.waitFor(
    () =>
      expect(
        within(sidebar()).getByRole('link', { name: 'Home' }),
      ).toBeInTheDocument(),
    { timeout: 15_000 },
  );
  expect(
    within(sidebar()).queryByText('Materials & inventory'),
  ).not.toBeInTheDocument();
  for (const name of ['Stock', 'Inbound orders', 'Outbound orders', 'Warehouses']) {
    expect(
      within(sidebar()).queryByRole('link', { name }),
    ).not.toBeInTheDocument();
  }

  permissions = withPageGrant;
  await renderMenu();
  for (const name of [
    'Stock',
    'Inbound orders',
    'Outbound orders',
    'Warehouses',
  ]) {
    expect(
      await within(sidebar()).findByRole('link', { name }, { timeout: 15_000 }),
    ).toBeInTheDocument();
  }
  expect(
    within(sidebar()).getByRole('link', { name: 'Stock' }),
  ).toHaveAttribute('href', '/stock');
});

/**
 * 直接敲地址：四页的路由要求页面授权 `access`，而路由守卫问的就是 `useCan` 这一句。
 * 这个人只有业务动作，所以守卫的答案是「不许」—— 不发任何业务请求。
 */
it.each(PAGES)('%s asks for its page grant before anything loads', async (id, path) => {
  permissions = noPageGrant;
  api.mockClear();
  const flat = <R extends { children?: readonly R[] }>(
    items: readonly R[],
  ): R[] => items.flatMap((item) => [item, ...flat(item.children ?? [])]);
  expect(flat(routes).find((entry) => entry.path === path)?.authz).toEqual({
    resource: { type: 'page', id },
    action: 'access',
  });

  function Probe(): ReactElement {
    const access = useCan({ resource: { type: 'page', id }, action: 'access' });
    return <p>page access: {String(access.can)}</p>;
  }
  await renderWithApp(<Probe />, {
    namespace: packageMetadata.name,
    namespaces: { [packageMetadata.name]: enUS },
    fetch: answerApi(api),
    services,
  });

  expect(
    await screen.findByText('page access: false', {}, { timeout: 15_000 }),
  ).toBeVisible();
  expect(api.mock.calls.map(([call]) => call.path)).toEqual([
    'authorization/permissions',
  ]);
});
