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
 * 页面授权（R-014 / R-025 页面片）：只有业务动作、没有页面授权的人，侧栏里看不到入口，
 * 直接敲地址也被拒。用的是真实的应用路由树与应用外壳，只把 HTTP 换成夹具。
 */
const routes = resolveAppClientContributions([
  {
    packageName: packageMetadata.name,
    routes: applicationRoutes,
    source: 'application',
  },
]).routes;

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
      resource: { type: 'composite', id: 'customers' },
      actions: ['view', 'create', 'update'],
    },
    {
      resource: { type: 'composite', id: 'shifts' },
      actions: ['view', 'manage'],
    },
    // R-019：采购、销售持有的只读物料授权。
    { resource: { type: 'composite', id: 'items' }, actions: ['view'] },
  ],
};
const withPageGrant: AuthorizationSnapshot = {
  unrestricted: false,
  permissions: [
    ...noPageGrant.permissions,
    { resource: { type: 'page', id: 'partners' }, actions: ['access'] },
    { resource: { type: 'page', id: 'shifts' }, actions: ['access'] },
    { resource: { type: 'page', id: 'items' }, actions: ['access'] },
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

function flatten<R extends { children?: readonly R[] }>(
  items: readonly R[],
): R[] {
  return items.flatMap((item) => [item, ...flatten(item.children ?? [])]);
}

const sidebar = (): HTMLElement =>
  document.querySelector<HTMLElement>('[data-slot=sidebar]') ?? document.body;

it('hides the shifts, partners and items entries from someone with no page grant, and shows them with one', async () => {
  permissions = noPageGrant;
  await renderMenu();
  await screen.findByRole(
    'navigation',
    { name: 'Navigation' },
    { timeout: 15_000 },
  );
  await vi.waitFor(
    () =>
      expect(
        within(sidebar()).getByRole('link', { name: 'Home' }),
      ).toBeInTheDocument(),
    { timeout: 15_000 },
  );
  expect(
    within(sidebar()).queryByRole('link', { name: 'Shifts' }),
  ).not.toBeInTheDocument();
  expect(
    within(sidebar()).queryByRole('link', { name: 'Customers & suppliers' }),
  ).not.toBeInTheDocument();
  expect(
    within(sidebar()).queryByText('Human resources'),
  ).not.toBeInTheDocument();
  // 物料页同理：有 items.view、没有页面授权的人看不到入口，连「物料与库存」这个分组都不出现。
  expect(
    within(sidebar()).queryByRole('link', { name: 'Items' }),
  ).not.toBeInTheDocument();
  expect(
    within(sidebar()).queryByText('Items & inventory'),
  ).not.toBeInTheDocument();
});

it('shows the entries once the page grants are given', async () => {
  permissions = withPageGrant;
  await renderMenu();
  expect(
    await within(sidebar()).findByRole(
      'link',
      { name: 'Shifts' },
      { timeout: 15_000 },
    ),
  ).toHaveAttribute('href', '/shifts');
  expect(
    await within(sidebar()).findByRole(
      'link',
      { name: 'Customers & suppliers' },
      { timeout: 15_000 },
    ),
  ).toHaveAttribute('href', '/partners');
  expect(
    await within(sidebar()).findByRole(
      'link',
      { name: 'Items' },
      { timeout: 15_000 },
    ),
  ).toHaveAttribute('href', '/items');
});

/**
 * 直接敲地址：这两页的路由要求页面授权 `access`，而路由守卫问的就是 `useCan` 这一句。
 * 这个人只有业务动作，所以守卫的答案是「不许」——外壳据此画「无权访问」，不发业务请求。
 * （把整个外壳起起来需要真实的应用服务，那条路在 `tests/client/client-shell.test.tsx` 里。）
 */
it.each([
  ['/partners', 'partners'],
  ['/shifts', 'shifts'],
  ['/items', 'items'],
])('%s asks for its page grant before anything loads', async (path, id) => {
  permissions = noPageGrant;
  api.mockClear();
  const route = flatten(routes).find((entry) => entry.path === path);
  expect(route?.authz).toEqual({
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
  expect(api.mock.calls.map(([call]) => call.path)).not.toContain('partners');
  expect(api.mock.calls.map(([call]) => call.path)).not.toContain('shifts');
  // 物料页的三个标签、两本字典都不该发出去。
  for (const path of ['items', 'units', 'item-categories'])
    expect(api.mock.calls.map(([call]) => call.path)).not.toContain(path);
});
