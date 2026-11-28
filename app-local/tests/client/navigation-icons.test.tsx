import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import * as Lucide from 'lucide-react';
import { resolveAppClientContributions } from '@nocobase/app-client/plugins';
import { fireEvent, render, screen, within } from '@testing-library/react';
import {
  createTestI18nRuntime,
  TestI18nProvider,
} from '@nocobase/i18n/testing';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import applicationRoutes from '../../client/routes.js';
import { ActionGlyph } from '../../client/components/action-glyph.js';
import { ACTION_ICONS } from '../../client/lib/action-icons.js';
import { BUSINESS_GROUPS } from '../../client/lib/business-navigation.js';
import { PAGE_ICONS } from '../../client/lib/page-icons.js';
import { iconForRowAction } from '../../client/lib/row-action-icons.js';
import {
  AppSidebar,
  AppSidebarProvider,
} from '../../client/layouts/components/app-sidebar.js';
import { NavigationMenu } from '../../client/layouts/components/navigation-menu.js';
import {
  createAppSidebarPreferenceStore,
  SidebarPreferenceProvider,
} from '../../client/layouts/use-sidebar-preference.js';
import {
  buildRouteNavigation,
  type RouteNavigationItem,
} from '../../client/routing/route-navigation.js';

const runtime = await createTestI18nRuntime({ strict: false });

function I18n({ children }: { readonly children: ReactNode }) {
  return <TestI18nProvider runtime={runtime}>{children}</TestI18nProvider>;
}

const app = '@nocobase/app-template-default';
const routes = resolveAppClientContributions([
  { packageName: app, source: 'application', routes: applicationRoutes },
]).routes;
const menu = buildRouteNavigation(routes, new Set<string>());

function flatten(
  items: readonly RouteNavigationItem[],
): readonly RouteNavigationItem[] {
  return items.flatMap((item) => [item, ...flatten(item.children)]);
}

const entries = flatten(menu);
const groups = entries.filter(
  (item) => item.children.length > 0 && !item.route.componentLoader,
);
const pages = entries.filter((item) => Boolean(item.route.componentLoader));

const exportedIcons = new Set(Object.values(Lucide));

function iconOf(item: RouteNavigationItem) {
  return item.route.navigation?.icon;
}

describe('侧栏导航图标齐全', () => {
  it('has an icon on every group and every page entry', () => {
    expect(groups.length).toBeGreaterThan(0);
    expect(pages.length).toBeGreaterThan(0);
    for (const group of groups)
      expect(iconOf(group), `group ${group.route.name} has no icon`).toBeTruthy();
    for (const page of pages)
      expect(iconOf(page), `page ${page.route.name} has no icon`).toBeTruthy();
  });

  it('gives every child of a group an icon or none of them', () => {
    for (const group of groups) {
      const icons = group.children.map((child) => iconOf(child));
      expect(
        icons.every(Boolean) || icons.every((icon) => !icon),
        `group ${group.route.name} has a mixed set of child icons`,
      ).toBe(true);
    }
  });

  it('never repeats a group icon as its first child icon', () => {
    for (const group of groups) {
      const first = group.children[0];
      if (!first) continue;
      expect(
        iconOf(group) === iconOf(first),
        `group ${group.route.name} repeats its first child's icon`,
      ).toBe(false);
    }
  });

  it('covers every sidebar page in page-icons with the same icon as the route', () => {
    for (const page of pages) {
      const mapped = PAGE_ICONS[page.route.name];
      expect(mapped, `page ${page.route.name} is missing from page-icons`).toBe(
        iconOf(page),
      );
    }
  });

  it('keeps the disambiguated page icons unique across the sidebar', () => {
    for (const name of [
      'partners',
      'purchaseRequests',
      'quotations',
      'financeRequests',
      'receivableRecons',
      'payableRecons',
    ]) {
      const icon = PAGE_ICONS[name];
      expect(
        pages.filter((page) => iconOf(page) === icon).map((page) => page.route.name),
        `${name} still shares its icon with another sidebar page`,
      ).toEqual([name]);
    }
  });
});

describe('映射表只装 lucide-react 图标', () => {
  it('keeps every page-icons value exported by lucide-react', () => {
    const values = Object.entries(PAGE_ICONS);
    expect(values.length).toBeGreaterThan(0);
    for (const [name, icon] of values)
      expect(
        exportedIcons.has(icon),
        `page-icons.${name} is not a lucide-react export`,
      ).toBe(true);
  });

  it('maps the main actions to their chosen lucide-react icons', () => {
    const expected = {
      create: 'Plus',
      submit: 'Send',
      post: 'BadgeCheck',
      void: 'Ban',
      print: 'Printer',
      export: 'Download',
      review: 'ClipboardCheck',
      save: 'Save',
      cancel: 'X',
    } as const;
    expect(Object.keys(ACTION_ICONS).sort()).toEqual(
      Object.keys(expected).sort(),
    );
    for (const [key, name] of Object.entries(expected)) {
      const icon = ACTION_ICONS[key as keyof typeof ACTION_ICONS];
      expect(icon, `action-icons.${key} mismatch`).toBe(
        (Lucide as unknown as Record<string, Lucide.LucideIcon>)[name],
      );
      expect(exportedIcons.has(icon)).toBe(true);
    }
  });
});

describe('业务分组图标画在三种形态里', () => {
  const labels = () => document.querySelectorAll('[data-sidebar="group-label"]');

  function show(options: { collapsed?: boolean; compact?: boolean } = {}) {
    if (options.collapsed)
      localStorage.setItem(
        'nocobase:sidebar:collapsed:app:/main',
        'true',
      );
    // JSDOM 的默认高度会把菜单判成紧凑态；给足高度才能让分组走节标题那条渲染路径。
    const measurement = options.compact
      ? { availableHeight: 300, expandedHeight: 900 }
      : { availableHeight: 2000, expandedHeight: 900 };
    return render(
      <MemoryRouter>
        <SidebarPreferenceProvider
          value={createAppSidebarPreferenceStore('/main')}
        >
          <AppSidebarProvider>
            <AppSidebar label='Navigation'>
              <NavigationMenu
                items={menu}
                label='Menu'
                selectedKey={undefined}
                measurement={measurement}
              />
            </AppSidebar>
          </AppSidebarProvider>
        </SidebarPreferenceProvider>
      </MemoryRouter>,
      { wrapper: I18n },
    );
  }

  beforeEach(() => {
    localStorage.clear();
    vi.stubGlobal('matchMedia', () => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
  });

  function expectGroupIconsDrawn() {
    expect(labels().length).toBeGreaterThanOrEqual(BUSINESS_GROUPS.length);
    for (const label of labels())
      expect(
        label.querySelector('svg'),
        'a sidebar group label has no icon',
      ).not.toBeNull();
  }

  it('draws them in the expanded sidebar', () => {
    show();
    expectGroupIconsDrawn();
  });

  it('keeps each business group as one icon entry in the collapsed sidebar', async () => {
    show({ collapsed: true });
    const triggers = await Promise.all(
      BUSINESS_GROUPS.map((group) =>
        screen.findByRole('button', { name: group.titleKey }),
      ),
    );
    expect(triggers).toHaveLength(BUSINESS_GROUPS.length);
    for (const trigger of triggers)
      expect(trigger.querySelector('svg'), 'group entry has no icon').not.toBeNull();
    // 组内的页面不再摊平到侧栏；入口已由上面的 findByRole 等到，结构稳定。
    expect(
      // eslint-disable-next-line app-local/no-sync-query-after-action -- 查的是上面已等到的静态导航结构，不依赖异步请求
      screen.queryByRole('link', { name: 'navigation.purchaseOrders' }),
    ).toBeNull();
    fireEvent.mouseEnter(triggers[1]);
    const popup = await screen.findByRole('dialog', {
      name: 'navigation.businessPurchase',
    });
    expect(
      within(popup).getByRole('link', { name: 'navigation.purchaseOrders' }),
    ).toBeVisible();
  });

  it('draws them in the compact sidebar', async () => {
    show({ compact: true });
    for (const group of BUSINESS_GROUPS) {
      const trigger = await screen.findByRole('button', {
        name: group.titleKey,
      });
      expect(trigger.querySelector('svg')).not.toBeNull();
    }
  });
});

describe('行内 ⋮ 菜单项图标', () => {
  const clientRoot = path.resolve(import.meta.dirname, '../../client');

  function sourceFiles(directory: string): readonly string[] {
    return readdirSync(directory).flatMap((name) => {
      const file = path.join(directory, name);
      if (statSync(file).isDirectory()) return sourceFiles(file);
      return /\.tsx?$/u.test(name) ? [file] : [];
    });
  }

  const declarations = sourceFiles(clientRoot).flatMap((file) => {
    const source = readFileSync(file, 'utf8');
    if (!source.includes('RowActions')) return [];
    return [...source.matchAll(
      /\{\s*key:\s*'([^']+)'[\s\S]{0,260}?label:\s*t\(\s*[`'"]([^`'"]+)/gu,
    )].map((match) => ({
      file: path.relative(clientRoot, file),
      key: match[1],
      label: match[2],
    }));
  });

  it('gives every RowActions menu item an icon by key and by label', () => {
    expect(declarations.length).toBeGreaterThan(20);
    for (const { file, key, label } of declarations) {
      expect(iconForRowAction(key), `${file}: key ${key}`).toBeTruthy();
      expect(
        iconForRowAction('__label__', label),
        `${file}: label ${label}`,
      ).toBeTruthy();
    }
  });
});

describe('取消按钮图标', () => {
  it('renders the cancel glyph before its label', () => {
    const { container } = render(
      <button type='button'>
        <ActionGlyph action='cancel' />
        取消
      </button>,
    );
    expect(
      container.querySelector('[data-icon="inline-start"]'),
    ).not.toBeNull();
  });

  it('is used by the shared form dialog footer', () => {
    const source = readFileSync(
      path.resolve(import.meta.dirname, '../../client/components/erp/form-dialog.tsx'),
      'utf8',
    );
    expect(source).toContain("<ActionGlyph action='cancel' />");
  });
});
