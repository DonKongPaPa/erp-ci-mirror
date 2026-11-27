import {
  defineAppRoutes,
  resolveAppClientContributions,
  type AppClientRegisteredRoute,
} from '@nocobase/app-client/plugins';
import { describe, expect, it } from 'vitest';
import foundation from '@nocobase/app-plugin-foundation/client/routes';
import settings from '../../client/pages/settings/routes.js';
import shell from '../../client/pages/settings/shell-routes.js';
import { createApplicationRoutes } from '../../client/routes.js';
import {
  buildRouteNavigation,
  buildSettingsCatalog,
  filterRouteTree,
  selectedNavigationId,
  routeKey,
} from '../../client/routing/route-navigation.js';

const componentLoader = async () => ({ default: () => null });
const app = '@nocobase/app-template-default';

function resolve(...extra: ReturnType<typeof defineAppRoutes>[]) {
  return resolveAppClientContributions([
    {
      packageName: app,
      source: 'application',
      routes: [shell, settings, ...extra],
    },
  ]).routes;
}

function find(
  routes: readonly AppClientRegisteredRoute[],
  name: string,
): AppClientRegisteredRoute {
  for (const route of routes) {
    if (route.name === name) return route;
    const nested = route.children && find(route.children, name);
    if (nested) return nested;
  }
  return undefined as unknown as AppClientRegisteredRoute;
}

const catalog = (
  routes: readonly AppClientRegisteredRoute[],
  denied = new Set<string>(),
) =>
  buildSettingsCatalog(routes, denied).map((category) => [
    category.route.name,
    category.modules.map((module) => [module.route.name, module.target.path]),
  ]);

describe('System settings navigation', () => {
  it('keeps the existing URLs and authorization of the settings pages', () => {
    const routes = resolve();
    expect(
      [
        'settingsHome',
        'settingsUsers',
        'settingsRoles',
        'settingsDefaultAccess',
      ].map((name) => {
        const route = find(routes, name);
        return [name, route.path, route.authz];
      }),
    ).toEqual([
      ['settingsHome', '/settings', 'skip'],
      [
        'settingsUsers',
        '/settings/users',
        { resource: { type: 'user', id: '*' }, action: 'read' },
      ],
      [
        'settingsRoles',
        '/settings/roles',
        {
          resource: { type: 'settings', id: 'authorization.permission-sets' },
          action: 'read',
        },
      ],
      [
        'settingsDefaultAccess',
        '/settings/default-access',
        {
          resource: { type: 'settings', id: 'authorization.default-access' },
          action: 'read',
        },
      ],
    ]);
    expect(find(routes, 'settingsUsers').id).toBe(`${app}:settingsUsers`);
  });

  it('shows one sidebar entry that opens the home and stays selected on every settings page', () => {
    const routes = resolve();
    const menu = buildRouteNavigation(routes, new Set());
    expect(menu.map(({ route }) => [route.name, route.path])).toEqual([
      ['settingsHome', '/settings'],
    ]);
    expect(menu[0].children).toEqual([]);
    expect(menu[0].route.navigation?.title).toBe('settings.title');
    const entry = routeKey(menu[0].route);
    for (const path of [
      '/settings',
      '/settings/users',
      '/settings/users/create',
      '/settings/roles/member/edit',
      '/settings/default-access',
    ])
      expect(selectedNavigationId(routes, path)).toBe(entry);
  });

  it('groups modules into categories, opens a tabbed module on its first readable tab and hides empty categories', () => {
    const routes = resolve();
    expect(catalog(routes)).toEqual([
      [
        'settingsAccount',
        [
          ['settingsUsers', '/settings/users'],
          ['settingsDepartments', '/settings/departments'],
          ['settingsEmployees', '/settings/employees'],
          ['permissionManagement', '/settings/roles'],
          ['applicationApiKeysManagement', '/settings/api-keys'],
        ],
      ],
    ]);
    const roles = find(routes, 'settingsRoles');
    expect(catalog(routes, new Set([routeKey(roles)]))).toEqual([
      [
        'settingsAccount',
        [
          ['settingsUsers', '/settings/users'],
          ['settingsDepartments', '/settings/departments'],
          ['settingsEmployees', '/settings/employees'],
          ['permissionManagement', '/settings/default-access'],
          ['applicationApiKeysManagement', '/settings/api-keys'],
        ],
      ],
    ]);
    const denied = new Set(
      [
        'settingsUsers',
        'settingsDepartments',
        'settingsRoles',
        'settingsDefaultAccess',
      ].map((name) => routeKey(find(routes, name))),
    );
    expect(catalog(routes, denied)).toEqual([
      [
        'settingsAccount',
        [
          ['settingsEmployees', '/settings/employees'],
          ['applicationApiKeysManagement', '/settings/api-keys'],
        ],
      ],
    ]);
    // The settings entry stays while the viewer may open one module in it.
    expect(buildRouteNavigation(routes, denied)).toHaveLength(1);
  });

  it('adds a later module with several views to its category without another sidebar entry', () => {
    const routes = resolve(
      defineAppRoutes([
        {
          parent: 'settingsSystem',
          name: 'notificationManagement',
          navigation: {
            title: 'Notifications',
            description: 'Channels and delivery records.',
          },
          breadcrumb: { title: 'Notifications' },
          children: [
            {
              name: 'notificationLogs',
              path: '/notifications/logs',
              authz: {
                resource: { type: 'page', id: 'notification.logs' },
                action: 'access',
              },
              navigation: { title: 'Delivery logs' },
              componentLoader,
            },
          ],
        },
      ]),
    );
    expect(find(routes, 'notificationLogs').path).toBe(
      '/settings/notifications/logs',
    );
    expect(catalog(routes).at(-1)).toEqual([
      'settingsSystem',
      [['notificationManagement', '/settings/notifications/logs']],
    ]);
    expect(buildRouteNavigation(routes, new Set())).toHaveLength(1);
    expect(selectedNavigationId(routes, '/settings/notifications/logs')).toBe(
      routeKey(buildRouteNavigation(routes, new Set())[0].route),
    );
  });

  it('places a plugin module registered outside the categories under System', () => {
    const routes = resolveAppClientContributions([
      { packageName: app, source: 'application', routes: [shell] },
      {
        packageName: '@nocobase/app-plugin-foundation',
        source: 'plugin',
        routes: foundation,
      },
    ]).routes;
    // The bare shell: only App Foundation, which only an unrestricted administrator may open.
    const menu = buildRouteNavigation(routes, new Set());
    expect(menu.map(({ route }) => route.name)).toEqual(['settingsHome']);
    expect(catalog(routes)).toEqual([
      ['settingsSystem', [['foundation', '/foundation']]],
    ]);
    // The signed-in shell receives the tree filtered to its pages; empty categories keep their titles there.
    const signedIn = filterRouteTree(
      routes,
      (route) => route.auth === 'required',
    );
    expect(catalog(signedIn)).toEqual([
      ['settingsSystem', [['foundation', '/foundation']]],
    ]);
    const page = find(routes, 'foundation');
    expect(page.navigation?.description).toBe('nav.foundationDescription');
    expect(buildRouteNavigation(routes, new Set([routeKey(page)]))).toEqual([]);
  });

  it('shows the notification template view as a System card once an invitation mailer is configured', () => {
    const routes = resolveAppClientContributions([
      {
        packageName: app,
        source: 'application',
        routes: createApplicationRoutes({
          notificationTemplates: { invitationConfigured: true },
        }),
      },
    ]).routes;
    expect(catalog(routes)).toEqual([
      [
        'settingsAccount',
        [
          ['settingsUsers', '/settings/users'],
          ['settingsDepartments', '/settings/departments'],
          ['settingsEmployees', '/settings/employees'],
          ['permissionManagement', '/settings/roles'],
          ['applicationApiKeysManagement', '/settings/api-keys'],
        ],
      ],
      [
        'settingsSystem',
        [
          ['notificationManagement', '/settings/notifications/logs'],
          ['databaseExplorer', '/settings/database-explorer'],
        ],
      ],
    ]);
    expect(
      buildRouteNavigation(routes, new Set()).map(({ route }) => route.name),
      // 人事、客户与供应商、物料与库存、采购订单、销售订单排在质量工单前面（《基座ERP前端设计》1.1）。
    ).toEqual([
      'home',
      'hr',
      'partners',
      // 物料与库存排在客户与供应商后面、质量工单前面（《基座ERP前端设计》1.1）。
      'inventory',
      'purchaseOrders',
      'salesOrders',
      'quality',
      'feedbacks',
      'ai',
      'settingsHome',
    ]);
  });
});

it('hides the notification module and the application API keys card when their page is denied', () => {
  // R-032 / R-034 验收第 3、4 条：没有页面授权的人看不到这两个入口。
  const routes = resolveAppClientContributions([
    {
      packageName: app,
      source: 'application',
      routes: createApplicationRoutes({}),
    },
  ]).routes;
  const logs = find(routes, 'notificationLogs');
  expect(logs.authz).toEqual({
    resource: { type: 'page', id: 'notification.logs' },
    action: 'access',
  });
  // 记录页被拒时，模块仍由可读的模板视图撑着，但入口指向模板页 —— 记录页自己的标签不出现。
  expect(catalog(routes, new Set([routeKey(logs)]))).toEqual([
    [
      'settingsAccount',
      [
        ['settingsUsers', '/settings/users'],
        ['settingsDepartments', '/settings/departments'],
        ['settingsEmployees', '/settings/employees'],
        ['permissionManagement', '/settings/roles'],
        ['applicationApiKeysManagement', '/settings/api-keys'],
      ],
    ],
    [
      'settingsSystem',
      [
        ['notificationManagement', '/settings/notifications/templates'],
        ['databaseExplorer', '/settings/database-explorer'],
      ],
    ],
  ]);

  // 记录页与模板页都没有授权时，整个「通知管理」模块都不出现（只剩数据库浏览器）。
  const templates = find(routes, 'notificationTemplates');
  expect(
    catalog(routes, new Set([routeKey(logs), routeKey(templates)])),
  ).toEqual([
    [
      'settingsAccount',
      [
        ['settingsUsers', '/settings/users'],
        ['settingsDepartments', '/settings/departments'],
        ['settingsEmployees', '/settings/employees'],
        ['permissionManagement', '/settings/roles'],
        ['applicationApiKeysManagement', '/settings/api-keys'],
      ],
    ],
    ['settingsSystem', [['databaseExplorer', '/settings/database-explorer']]],
  ]);

  const applicationKeys = find(routes, 'applicationApiKeysManagement');
  expect(applicationKeys.authz).toEqual({
    resource: { type: 'page', id: 'application.api-keys' },
    action: 'access',
  });
  expect(
    catalog(routes, new Set([routeKey(applicationKeys)]))
      .flatMap(([, modules]) => modules)
      .map(([name]) => name),
  ).not.toContain('applicationApiKeysManagement');
});

it('places database browsing in System and hides its card when access is denied', () => {
  const routes = resolveAppClientContributions([
    {
      packageName: app,
      source: 'application',
      routes: createApplicationRoutes({}),
    },
  ]).routes;
  const page = find(routes, 'databaseExplorer');
  expect(page.path).toBe('/settings/database-explorer');
  expect(page.auth).toBe('required');
  expect(page.authz).toEqual({
    resource: { type: 'page', id: 'database-explorer' },
    action: 'access',
  });
  expect(catalog(routes)).toEqual([
    [
      'settingsAccount',
      [
        ['settingsUsers', '/settings/users'],
        ['settingsDepartments', '/settings/departments'],
        ['settingsEmployees', '/settings/employees'],
        ['permissionManagement', '/settings/roles'],
        ['applicationApiKeysManagement', '/settings/api-keys'],
      ],
    ],
    [
      'settingsSystem',
      [
        ['notificationManagement', '/settings/notifications/logs'],
        ['databaseExplorer', '/settings/database-explorer'],
      ],
    ],
  ]);
  expect(catalog(routes, new Set([routeKey(page)]))).toEqual([
    [
      'settingsAccount',
      [
        ['settingsUsers', '/settings/users'],
        ['settingsDepartments', '/settings/departments'],
        ['settingsEmployees', '/settings/employees'],
        ['permissionManagement', '/settings/roles'],
        ['applicationApiKeysManagement', '/settings/api-keys'],
      ],
    ],
    [
      'settingsSystem',
      [['notificationManagement', '/settings/notifications/logs']],
    ],
  ]);
});
