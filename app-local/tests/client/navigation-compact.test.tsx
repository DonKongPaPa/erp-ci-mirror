import type { AppClientRegisteredRoute } from '@nocobase/app-client/plugins';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  TestI18nProvider,
  createTestI18nRuntime,
} from '@nocobase/i18n/testing';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AppSidebar,
  AppSidebarProvider,
} from '../../client/layouts/components/app-sidebar.js';
import {
  NavigationMenu,
  type NavigationMeasurement,
} from '../../client/layouts/components/navigation-menu.js';
import {
  createAppSidebarPreferenceStore,
  SidebarPreferenceProvider,
} from '../../client/layouts/use-sidebar-preference.js';
import {
  routeKey,
  type RouteNavigationItem,
} from '../../client/routing/route-navigation.js';

const runtime = await createTestI18nRuntime({ strict: false });
const sidebarPreference = createAppSidebarPreferenceStore('/main');
const STORAGE_KEY = 'nocobase:navigation:compact';

function I18n({ children }: { readonly children: ReactNode }) {
  return <TestI18nProvider runtime={runtime}>{children}</TestI18nProvider>;
}

function page(name: string): AppClientRegisteredRoute {
  return {
    name,
    id: name,
    path: `/${name}`,
    auth: 'required',
    packageName: 'test',
    source: 'application',
    navigation: { title: name },
    componentLoader: async () => ({ default: () => null }),
  };
}

const home: RouteNavigationItem = { route: page('Home'), children: [] };
const groups = ['Alpha', 'Beta', 'Gamma'].map((name) => ({
  route: { ...page(name), componentLoader: undefined },
  children: [
    { route: page(`${name}One`), children: [] },
    { route: page(`${name}Two`), children: [] },
  ],
}));
const items: readonly RouteNavigationItem[] = [home, ...groups];
const groupKey = (name: string) => routeKey(page(name));
const pageKey = (name: string) => routeKey(page(name));

const roomy: NavigationMeasurement = {
  availableHeight: 900,
  expandedHeight: 400,
};
const tight: NavigationMeasurement = {
  availableHeight: 420,
  expandedHeight: 900,
};

function shell(selectedKey: string | undefined, measurement: NavigationMeasurement) {
  return (
    <MemoryRouter>
      <SidebarPreferenceProvider value={sidebarPreference}>
        <AppSidebarProvider>
          <AppSidebar label='Navigation'>
            <NavigationMenu
              items={items}
              label='Menu'
              selectedKey={selectedKey}
              measurement={measurement}
            />
          </AppSidebar>
        </AppSidebarProvider>
      </SidebarPreferenceProvider>
    </MemoryRouter>
  );
}

const groupButton = (name: string) =>
  screen.getByRole('button', { name });
const expanded = (name: string) =>
  expect(groupButton(name)).toHaveAttribute('aria-expanded', 'true');
const collapsed = (name: string) =>
  expect(groupButton(name)).toHaveAttribute('aria-expanded', 'false');

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
});
afterEach(() => vi.unstubAllGlobals());

describe('compact navigation (R-085)', () => {
  it('enters compact mode when the fully expanded menu is taller than the viewport: only the current group opens', () => {
    render(shell(pageKey('BetaOne'), tight), { wrapper: I18n });

    collapsed('Alpha');
    expanded('Beta');
    collapsed('Gamma');
    expect(screen.getByRole('button', { name: 'Reset navigation' })).toBeVisible();
    // Other groups' pages are not rendered until their group is opened.
    expect(screen.queryByRole('link', { name: 'AlphaOne' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'BetaOne' })).toBeVisible();
  });

  it('leaves compact mode when the menu fits: groups are headings with every page shown', () => {
    render(shell(pageKey('BetaOne'), roomy), { wrapper: I18n });

    expect(screen.queryByRole('button', { name: 'Reset navigation' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Alpha' })).not.toBeInTheDocument();
    expect(screen.getByText('Alpha')).toHaveAttribute('data-sidebar', 'group-label');
    expect(screen.getByRole('link', { name: 'AlphaOne' })).toBeVisible();
    expect(screen.getByRole('link', { name: 'GammaTwo' })).toBeVisible();
  });

  it('follows the current page after navigation and keeps only one group open', () => {
    const { rerender } = render(shell(pageKey('BetaOne'), tight), {
      wrapper: I18n,
    });
    rerender(shell(pageKey('GammaTwo'), tight));
    collapsed('Beta');
    expanded('Gamma');
  });

  it('manually opening another group persists and is restored on the next mount', async () => {
    const user = userEvent.setup();
    const first = render(shell(pageKey('BetaOne'), tight), { wrapper: I18n });
    await user.click(groupButton('Alpha'));
    expanded('Alpha');
    collapsed('Beta');
    expect(localStorage.getItem(STORAGE_KEY)).toBe(
      JSON.stringify({ expandedKey: groupKey('Alpha') }),
    );

    // A manual choice wins over the current page until it is reset.
    first.rerender(shell(pageKey('GammaOne'), tight));
    expanded('Alpha');
    collapsed('Gamma');

    // Restore default: clear the stored choice and follow the current page again.
    await user.click(screen.getByRole('button', { name: 'Reset navigation' }));
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    collapsed('Alpha');
    expanded('Gamma');
  });

  it('reads a stored manual choice before the first render', () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ expandedKey: groupKey('Gamma') }),
    );
    render(shell(pageKey('AlphaOne'), tight), { wrapper: I18n });
    expanded('Gamma');
    collapsed('Alpha');
  });

  it('does not apply a stored choice when the menu fits', () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ expandedKey: groupKey('Gamma') }),
    );
    render(shell(pageKey('AlphaOne'), roomy), { wrapper: I18n });
    expect(screen.queryByRole('button', { name: 'Gamma' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'GammaOne' })).toBeVisible();
  });

  it('lets the viewer collapse the current group until reset', async () => {
    const user = userEvent.setup();
    render(shell(pageKey('BetaOne'), tight), { wrapper: I18n });
    await user.click(groupButton('Beta'));
    collapsed('Beta');
    expect(localStorage.getItem(STORAGE_KEY)).toBe(
      JSON.stringify({ expandedKey: null }),
    );
    await user.click(screen.getByRole('button', { name: 'Reset navigation' }));
    expanded('Beta');
  });
});

describe('compact navigation height (R-085 加片)', () => {
  it('collapses even the current group when the compact menu still overflows', () => {
    render(
      shell(pageKey('BetaOne'), {
        availableHeight: 400,
        expandedHeight: 900,
        contentHeight: 620,
      }),
      { wrapper: I18n },
    );
    collapsed('Beta');
    collapsed('Alpha');
    collapsed('Gamma');
    expect(screen.queryByRole('link', { name: 'BetaOne' })).not.toBeInTheDocument();
  });

  it('uses the real sidebar content box rather than a fixed viewport estimate', async () => {
    const original = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      'clientHeight',
    );
    const originalScroll = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      'scrollHeight',
    );
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      get() {
        return (this as HTMLElement).classList.contains('app-navigation') ? 200 : 0;
      },
    });
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
      configurable: true,
      get() {
        return (this as HTMLElement).classList.contains('app-navigation') ? 180 : 0;
      },
    });
    try {
      render(
        <MemoryRouter>
          <SidebarPreferenceProvider value={sidebarPreference}>
            <AppSidebarProvider>
              <AppSidebar label='Navigation'>
                <NavigationMenu items={items} label='Menu' selectedKey={pageKey('BetaOne')} />
              </AppSidebar>
            </AppSidebarProvider>
          </SidebarPreferenceProvider>
        </MemoryRouter>,
        { wrapper: I18n },
      );
      await waitFor(() =>
        expect(groupButton('Beta')).toHaveAttribute('aria-expanded', 'true'),
      );
      expect(screen.getByRole('button', { name: 'Reset navigation' })).toBeVisible();
    } finally {
      if (original) Object.defineProperty(HTMLElement.prototype, 'clientHeight', original);
      if (originalScroll) Object.defineProperty(HTMLElement.prototype, 'scrollHeight', originalScroll);
    }
  });
});
