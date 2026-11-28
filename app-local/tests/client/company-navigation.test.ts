import {
  resolveAppClientContributions,
  type AppClientRegisteredRoute,
} from '@nocobase/app-client/plugins';
import { describe, expect, it } from 'vitest';

import applicationRoutes from '../../client/routes.js';
import {
  buildRouteNavigation,
  buildSettingsCatalog,
  routeKey,
  selectedNavigationId,
} from '../../client/routing/route-navigation.js';

const app = '@nocobase/app-template-default';
const routes = resolveAppClientContributions([
  { packageName: app, source: 'application', routes: applicationRoutes },
]).routes;

function denyPagesExcept(
  allowed: readonly string[],
): ReadonlySet<string> {
  const allow = new Set(allowed);
  const denied = new Set<string>();
  const visit = (nodes: readonly AppClientRegisteredRoute[]): void => {
    for (const route of nodes) {
      if (
        route.componentLoader &&
        route.authz !== 'skip' &&
        route.authz !== 'unrestricted' &&
        !allow.has(route.authz.resource.id)
      )
        denied.add(routeKey(route));
      visit(route.children ?? []);
    }
  };
  visit(routes);
  return denied;
}

const none = new Set<string>();
const pages = (items: readonly { route: AppClientRegisteredRoute }[]) =>
  items.filter(({ route }) => route.componentLoader).length;

describe('R-085 加片：侧栏只放公司事务', () => {
  it('leaves only home and groups at the top level, and no AI group', () => {
    const menu = buildRouteNavigation(routes, none);
    expect(menu.map(({ route }) => route.name)).toEqual([
      'home',
      'hr',
      'businessMasterData',
      'businessPurchase',
      'businessSales',
      'businessFinance',
      'businessQuality',
      'inventory',
      'approvals',
      'settingsHome',
    ]);
    expect(menu.some(({ route }) => route.name === 'ai')).toBe(false);
  });

  it('puts the five AI pages in the settings AI category and keeps settings selected there', () => {
    const catalog = buildSettingsCatalog(routes, none);
    const ai = catalog.find((category) => category.route.name === 'settingsAi');
    expect(ai?.modules.map(({ route }) => route.name)).toEqual([
      'models',
      'agents',
      'runtimes',
      'skills',
      'usage',
    ]);
    const settings = buildRouteNavigation(routes, none).find(
      ({ route }) => route.name === 'settingsHome',
    );
    const findRoute = (
      list: readonly AppClientRegisteredRoute[],
    ): AppClientRegisteredRoute | undefined => {
      for (const route of list) {
        if (route.name === 'skills') return route;
        const nested = findRoute(route.children ?? []);
        if (nested) return nested;
      }
      return undefined;
    };
    const skills = findRoute(routes)!;
    // 设置入口的代表键里要含 AI 页面，否则打开 /skills 时侧栏没有选中项。
    expect(settings?.activeRouteKeys).toEqual(
      expect.arrayContaining([`${skills.packageName}:${skills.path}:${skills.id}`]),
    );
    for (const path of ['/models', '/agents', '/runtimes', '/skills', '/usage'])
      expect(selectedNavigationId(routes, path)).toBe(routeKey(settings!.route));
  });

  it('hides AI modules with their page grants while keeping the settings entry', () => {
    const denied = denyPagesExcept(['partners']);
    const catalog = buildSettingsCatalog(routes, denied);
    expect(catalog.some((category) => category.route.name === 'settingsAi')).toBe(
      false,
    );
    const menu = buildRouteNavigation(routes, denied);
    expect(menu.some(({ route }) => route.name === 'ai')).toBe(false);
    expect(menu.some(({ route }) => route.name === 'ai')).toBe(false);
  });

  it.each([
    {
      role: 'purchase',
      allowed: [
        'partners', 'warehouses', 'items', 'purchaseOrders',
        'purchaseRequests', 'financeRequests', 'feedback',
      ],
      links: 10,
    },
    {
      role: 'sales',
      allowed: [
        'partners', 'warehouses', 'items', 'purchaseRequests', 'salesOrders',
        'quotations', 'orderLedger', 'financeRequests', 'feedback',
      ],
      links: 12,
    },
    {
      role: 'warehouse',
      allowed: [
        'stock', 'inboundOrders', 'outboundOrders', 'warehouses',
        'stocktakings', 'transfers', 'purchaseRequests', 'financeRequests',
        'feedback',
      ],
      links: 12,
    },
    {
      role: 'finance',
      allowed: [
        'stocktakings', 'financeRequests', 'expenses', 'invoiceReceipts',
      ],
      links: 7,
    },
  ])('keeps the $role sidebar fully expanded with $links links', ({ allowed, links }) => {
    const menu = buildRouteNavigation(routes, denyPagesExcept(allowed));
    const all = menu.flatMap(function flatten(item): readonly { route: AppClientRegisteredRoute }[] {
      return [item, ...item.children.flatMap(flatten)];
    });
    expect(pages(all)).toBe(links);
    // 业务角色没有可折叠组：所有一级组作为节直接展开，页面一下可达。
    expect(menu.filter(({ route }) => route.componentLoader).length).toBe(1);
  });
});
