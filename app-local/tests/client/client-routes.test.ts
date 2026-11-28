import {
  resolveAppClientContributions,
  type AppClientRegisteredRoute,
  type AppClientRouteComponentLoader,
} from '@nocobase/app-client/plugins';
import { describe, expect, it } from 'vitest';

import applicationRoutes, {
  createApplicationRoutes,
} from '../../client/routes.ts';
import { includeNotificationTemplateRoutes } from '../../client/pages/settings/notification-routes.js';
import { defineAppRoutes } from '@nocobase/app-client/plugins';

describe('app client routes', () => {
  it('joins the settings system category across contributions without moving the log URL', () => {
    const shell = defineAppRoutes([
      {
        name: 'settings',
        path: '/settings',
        navigation: { title: 'Settings' },
        children: [
          {
            name: 'settingsSystem',
            navigation: { title: 'System' },
            children: [],
          },
        ],
      },
    ]);
    const logs = defineAppRoutes([
      {
        name: 'notificationManagement',
        parent: 'settingsSystem',
        navigation: { title: 'Notifications' },
        children: [
          {
            name: 'notificationLogs',
            path: '/notifications/logs',
            auth: 'required',
            authz: {
              resource: { type: 'page', id: 'notification.logs' },
              action: 'access',
            },
            componentLoader: () =>
              import('../../client/pages/settings/notification-templates.js'),
          },
        ],
      },
    ]);
    const routes = includeNotificationTemplateRoutes([shell, logs], true);
    const built = resolveAppClientContributions([
      {
        packageName: '@nocobase/app-template-default',
        source: 'application',
        routes,
      },
    ]);
    expect(pagePaths(built.routes)).toEqual([
      '/settings/notifications/logs',
      '/settings/notifications/templates',
      '/settings/notifications/templates/:templateId',
    ]);
    expect(built.routes[0].children[0].children).toHaveLength(1);
    const created = includeNotificationTemplateRoutes([shell], true);
    expect(
      created
        .flatMap((part) => part.routes)
        .find((route) => route.name === 'notificationManagement')?.parent,
    ).toBe('settingsSystem');
  });

  it('exposes configured invitation templates through the real application route factory', async () => {
    const built = resolveAppClientContributions([
      {
        packageName: '@nocobase/app-template-default',
        source: 'application',
        routes: createApplicationRoutes({
          notificationTemplates: { invitationConfigured: true },
        }),
      },
    ]);
    expect(pagePaths(built.routes)).toContain(
      '/settings/notifications/templates',
    );
    expect(pageAuthorizations(built.routes)).toContainEqual({
      name: 'notificationTemplates',
      authorizedAs: 'notification.templates',
    });
    for (const loader of componentLoadersIn(built.routes))
      await expect(loader()).resolves.toMatchObject({
        default: expect.any(Function),
      });
  });

  it('reuses the notification module and preserves its logs and existing grants', () => {
    const existing = defineAppRoutes([
      {
        name: 'settings',
        path: '/settings',
        navigation: { title: 'Settings' },
        children: [
          {
            name: 'notificationManagement',
            navigation: { title: 'Notifications' },
            children: [
              {
                name: 'notificationLogs',
                path: '/notification-logs',
                auth: 'required',
                authz: {
                  resource: { type: 'page', id: 'existing.notification.logs' },
                  action: 'access',
                },
                componentLoader: () =>
                  import('../../client/pages/settings/notification-templates.js'),
              },
            ],
          },
        ],
      },
    ]);
    const once = includeNotificationTemplateRoutes([existing], false);
    expect(includeNotificationTemplateRoutes(once, true)).toBe(once);
    const built = resolveAppClientContributions([
      {
        packageName: '@nocobase/app-template-default',
        source: 'application',
        routes: once,
      },
    ]);
    expect(pagePaths(built.routes)).toEqual([
      '/settings/notification-logs',
      '/settings/notifications/templates',
      '/settings/notifications/templates/:templateId',
    ]);
    expect(pageAuthorizations(built.routes)).toEqual([
      { name: 'notificationLogs', authorizedAs: 'existing.notification.logs' },
      { name: 'notificationTemplates', authorizedAs: 'notification.templates' },
      // A template's own address keeps the list page's grant.
      { name: 'notificationTemplate', authorizedAs: 'notification.templates' },
    ]);
    expect(built.routes[0].children).toHaveLength(1);
  });

  it('keeps the landing page and the authentication pages', () => {
    // The authentication plugin and this application have to agree on these paths: it sends an unknown visitor to
    // /login, sends a signed-in user who opens a guest page back to /, and mails a reset link to /reset-password,
    // while the sign-in form links to /register and /forgot-password. Only their presence is asserted, so a page the
    // application adds is not a defect. Whether these four are guest pages is not checked here either: app-client
    // refuses any route that claims one of those paths without `auth: 'guest'`.
    expect(pagePaths(resolveRoutes().routes)).toEqual(
      expect.arrayContaining([
        '/',
        '/login',
        '/register',
        '/forgot-password',
        '/reset-password',
        // The page `deviceAuthorization()`'s verificationUri names, where a CLI's sign-in is approved.
        '/device',
      ]),
    );
  });

  it('loads every page component', async () => {
    const resolved = resolveRoutes();
    const loaders = componentLoadersIn(resolved.routes);
    // The tree above is filtered by loader, so an empty list would make the loop below pass without loading
    // anything at all.
    expect(loaders).not.toHaveLength(0);

    for (const componentLoader of loaders) {
      // The registered loader is already the wrapped one, so awaiting it holds every page to the contract that its
      // module default-exports a component. A page that moved or lost its default export fails here.
      await expect(componentLoader()).resolves.toMatchObject({
        default: expect.any(Function),
      });
    }
  });

  it('pins the page authorization of every signed-in page', () => {
    // A stored page grant records the page's `authz` resource id (`authorizedAs`), not its route `name`: changing an
    // id is a data change that has to migrate the grants that reference it, not a refactor — so changing this list
    // deliberately is the point. A new page that requires sign-in adds an entry here, because a page that checks
    // access is a new grant somebody has to be given.
    const resolved = resolveRoutes();

    // The landing page and the inbox opted out of page authorization, so they are reachable by every signed-in user.
    expect(pageAuthorizations(resolved.routes)).toEqual([
      { name: 'home', authorizedAs: null },
      { name: 'inbox', authorizedAs: null },
      // 人事的班次定义（R-025）与客户与供应商（R-014）：页面授权 id 见《基座ERP前端设计》1.3，
      // 各自的路由对话框与抽屉继承列表页的授权。
      { name: 'shifts', authorizedAs: 'shifts' },
      { name: 'shiftNew', authorizedAs: 'shifts' },
      { name: 'shiftEdit', authorizedAs: 'shifts' },
      { name: 'shiftCopy', authorizedAs: 'shifts' },
      { name: 'partners', authorizedAs: 'partners' },
      { name: 'partnerNew', authorizedAs: 'partners' },
      { name: 'partnerDetail', authorizedAs: 'partners' },
      { name: 'partnerEdit', authorizedAs: 'partners' },
      { name: 'partnerContactNew', authorizedAs: 'partners' },
      { name: 'partnerContactEdit', authorizedAs: 'partners' },
      // R-014 加片：交货地址的两个对话框继承往来单位页的页面授权。
      { name: 'partnerAddressNew', authorizedAs: 'partners' },
      { name: 'partnerAddressEdit', authorizedAs: 'partners' },
      // 物料与库存（《基座ERP前端设计》1.3，R-020 页面片）：库存查询、入库单、出库单、仓库各一个页面授权 id；
      // 入库单、出库单的新建、详情、编辑是盖在列表上的子页，仓库的新建、编辑是对话框，都继承列表页的授权。
      { name: 'stock', authorizedAs: 'stock' },
      { name: 'inboundOrders', authorizedAs: 'inboundOrders' },
      { name: 'inboundOrderNew', authorizedAs: 'inboundOrders' },
      { name: 'inboundOrderDetail', authorizedAs: 'inboundOrders' },
      { name: 'inboundOrderEdit', authorizedAs: 'inboundOrders' },
      { name: 'outboundOrders', authorizedAs: 'outboundOrders' },
      { name: 'outboundOrderNew', authorizedAs: 'outboundOrders' },
      { name: 'outboundOrderDetail', authorizedAs: 'outboundOrders' },
      { name: 'outboundOrderEdit', authorizedAs: 'outboundOrders' },
      { name: 'warehouses', authorizedAs: 'warehouses' },
      { name: 'warehouseNew', authorizedAs: 'warehouses' },
      { name: 'warehouseEdit', authorizedAs: 'warehouses' },
      // R-020 波 2：盘点单与调拨单的子页继承各自列表页的页面授权。
      { name: 'stocktakings', authorizedAs: 'stocktakings' },
      { name: 'stocktakingNew', authorizedAs: 'stocktakings' },
      { name: 'stocktaking', authorizedAs: 'stocktakings' },
      { name: 'stocktakingEdit', authorizedAs: 'stocktakings' },
      { name: 'transfers', authorizedAs: 'transfers' },
      { name: 'transferNew', authorizedAs: 'transfers' },
      { name: 'transfer', authorizedAs: 'transfers' },
      { name: 'transferEdit', authorizedAs: 'transfers' },
      // 物料与库存的物料（R-019）：三个标签共用一条路由，页面授权 `items`，对话框与抽屉继承列表页的授权。
      { name: 'items', authorizedAs: 'items' },
      { name: 'itemNew', authorizedAs: 'items' },
      { name: 'itemDetail', authorizedAs: 'items' },
      { name: 'itemEdit', authorizedAs: 'items' },
      { name: 'unitNew', authorizedAs: 'items' },
      { name: 'unitEdit', authorizedAs: 'items' },
      { name: 'categoryNew', authorizedAs: 'items' },
      { name: 'categoryEdit', authorizedAs: 'items' },
      // 采购订单（R-021）与销售订单（R-022）：页面授权 id 见《基座ERP前端设计》1.3，
      // 新建、详情、编辑的子页与生成出入库单的对话框继承列表页的授权。
      { name: 'purchaseOrders', authorizedAs: 'purchaseOrders' },
      { name: 'purchaseOrderNew', authorizedAs: 'purchaseOrders' },
      { name: 'purchaseOrder', authorizedAs: 'purchaseOrders' },
      { name: 'purchaseOrderEdit', authorizedAs: 'purchaseOrders' },
      { name: 'purchaseOrderReceipt', authorizedAs: 'purchaseOrders' },
      { name: 'purchaseRequests', authorizedAs: 'purchaseRequests' },
      { name: 'purchaseRequestNew', authorizedAs: 'purchaseRequests' },
      { name: 'purchaseRequest', authorizedAs: 'purchaseRequests' },
      { name: 'purchaseRequestEdit', authorizedAs: 'purchaseRequests' },
      { name: 'salesOrders', authorizedAs: 'salesOrders' },
      { name: 'salesOrderNew', authorizedAs: 'salesOrders' },
      { name: 'salesOrder', authorizedAs: 'salesOrders' },
      { name: 'salesOrderEdit', authorizedAs: 'salesOrders' },
      { name: 'salesOrderIssue', authorizedAs: 'salesOrders' },
      // R-022 波 2：报价单一页，新建、详情、编辑的子页继承列表页的页面授权。
      { name: 'quotations', authorizedAs: 'quotations' },
      { name: 'quotationNew', authorizedAs: 'quotations' },
      { name: 'quotation', authorizedAs: 'quotations' },
      { name: 'quotationEdit', authorizedAs: 'quotations' },
      // R-064：订单总台账是一张独立的页面，页面授权 id 固定为 orderLedger。
      { name: 'orderLedger', authorizedAs: 'orderLedger' },
      // R-072：业务字典维护页，页面授权 `bizDict` 只给 root；两个对话框继承它。
      { name: 'bizDict', authorizedAs: 'bizDict' },
      { name: 'bizDictNew', authorizedAs: 'bizDict' },
      { name: 'bizDictEdit', authorizedAs: 'bizDict' },
      // R-066：请款单与报销单一页，新建、详情、编辑的子页继承列表页的页面授权。
      { name: 'financeRequests', authorizedAs: 'financeRequests' },
      { name: 'financeRequestNew', authorizedAs: 'financeRequests' },
      { name: 'financeRequest', authorizedAs: 'financeRequests' },
      { name: 'financeRequestEdit', authorizedAs: 'financeRequests' },
      // R-065：支出记录、到票记录两个财务页面，子路由继承各自的页面授权。
      { name: 'expenses', authorizedAs: 'expenses' },
      { name: 'expenseNew', authorizedAs: 'expenses' },
      { name: 'expense', authorizedAs: 'expenses' },
      { name: 'expenseEdit', authorizedAs: 'expenses' },
      { name: 'invoiceReceipts', authorizedAs: 'invoiceReceipts' },
      { name: 'invoiceReceiptNew', authorizedAs: 'invoiceReceipts' },
      { name: 'invoiceReceipt', authorizedAs: 'invoiceReceipts' },
      { name: 'invoiceReceiptEdit', authorizedAs: 'invoiceReceipts' },
      { name: 'quality', authorizedAs: 'quality' },
      { name: 'feedbacks', authorizedAs: 'feedback' },
      { name: 'feedbackNew', authorizedAs: 'feedback' },
      { name: 'feedbackDetail', authorizedAs: 'feedback' },
      // R-017 M5：三个审批页取 authz: 'skip'，和收件箱一样对所有登录用户开放。
      { name: 'approvalMine', authorizedAs: null },
      { name: 'approvalTasks', authorizedAs: null },
      { name: 'approvalDetail', authorizedAs: null },
      { name: 'apiKeysManagement', authorizedAs: null },
      // R-076：打印视图不登记页面授权，进入时按 docType 检查 print 动作。
      { name: 'docPrintView', authorizedAs: null },
      // The AI Agent plugin's pages, in the order the application registers them. Each child route inherits its
      // parent page's grant, so `runtimes-connect`, `skills-new` and `skills-detail` share it.
      { name: 'models', authorizedAs: 'settings:agents.services' },
      { name: 'agents', authorizedAs: 'agents' },
      { name: 'runtimes', authorizedAs: 'runtimes' },
      { name: 'runtimes-connect', authorizedAs: 'runtimes' },
      { name: 'skills', authorizedAs: 'skills' },
      { name: 'skills-new', authorizedAs: 'skills' },
      { name: 'skills-detail', authorizedAs: 'skills' },
      { name: 'usage', authorizedAs: 'usage' },
      { name: 'settingsHome', authorizedAs: null },
      { name: 'settingsUsers', authorizedAs: 'user:*' },
      { name: 'settingsUserCreate', authorizedAs: 'user:*' },
      { name: 'settingsUser', authorizedAs: 'user:*' },
      { name: 'settingsUserEdit', authorizedAs: 'user:*' },
      { name: 'settingsDepartments', authorizedAs: 'departments' },
      { name: 'settingsEmployees', authorizedAs: 'employees' },
      {
        name: 'settingsRoles',
        authorizedAs: 'settings:authorization.permission-sets',
      },
      {
        name: 'settingsRoleCreate',
        authorizedAs: 'settings:authorization.permission-sets',
      },
      {
        name: 'settingsRoleEdit',
        authorizedAs: 'settings:authorization.permission-sets',
      },
      ...[
        'settingsDefaultAccess',
        'settingsDefaultAccessCreate',
        'settingsDefaultAccessEdit',
      ].map((name) => ({
        name,
        authorizedAs: 'settings:authorization.default-access',
      })),
      {
        name: 'applicationApiKeysManagement',
        authorizedAs: 'application.api-keys',
      },
      { name: 'notificationLogs', authorizedAs: 'notification.logs' },
      { name: 'notificationTemplates', authorizedAs: 'notification.templates' },
      // A template's own address keeps the list page's grant.
      { name: 'notificationTemplate', authorizedAs: 'notification.templates' },
      // R-068：导入工具只在系统设置露出，页面授权 `imports` 默认只有 root。
      { name: 'imports', authorizedAs: 'imports' },
      { name: 'databaseExplorer', authorizedAs: 'database-explorer' },
    ]);
  });

  it('includes database browsing and supports business settings registration', async () => {
    // The built-in database browser and the prepared business administration join the settings home.
    expect(
      pagePaths(resolveRoutes().routes).filter((path) =>
        path.startsWith('/settings'),
      ),
    ).toEqual([
      '/settings',
      '/settings/users',
      '/settings/users/create',
      '/settings/users/:userId',
      '/settings/users/:userId/edit',
      '/settings/departments',
      '/settings/employees',
      '/settings/roles',
      '/settings/roles/create',
      '/settings/roles/:key/edit',
      '/settings/default-access',
      '/settings/default-access/create',
      '/settings/default-access/:key/edit',
      '/settings/api-keys',
      '/settings/notifications/logs',
      '/settings/notifications/templates',
      '/settings/notifications/templates/:templateId',
      '/settings/imports',
      '/settings/database-explorer',
    ]);
    const built = resolveAppClientContributions([
      {
        packageName: '@nocobase/app-template-default',
        routes: applicationRoutes,
        source: 'application',
      },
    ]);
    expect(pageAuthorizations(built.routes)).toEqual([
      { name: 'home', authorizedAs: null },
      { name: 'inbox', authorizedAs: null },
      // 人事的班次定义（R-025）与客户与供应商（R-014）：页面授权 id 见《基座ERP前端设计》1.3，
      // 各自的路由对话框与抽屉继承列表页的授权。
      { name: 'shifts', authorizedAs: 'shifts' },
      { name: 'shiftNew', authorizedAs: 'shifts' },
      { name: 'shiftEdit', authorizedAs: 'shifts' },
      { name: 'shiftCopy', authorizedAs: 'shifts' },
      { name: 'partners', authorizedAs: 'partners' },
      { name: 'partnerNew', authorizedAs: 'partners' },
      { name: 'partnerDetail', authorizedAs: 'partners' },
      { name: 'partnerEdit', authorizedAs: 'partners' },
      { name: 'partnerContactNew', authorizedAs: 'partners' },
      { name: 'partnerContactEdit', authorizedAs: 'partners' },
      // R-014 加片：交货地址的两个对话框继承往来单位页的页面授权。
      { name: 'partnerAddressNew', authorizedAs: 'partners' },
      { name: 'partnerAddressEdit', authorizedAs: 'partners' },
      // 物料与库存（《基座ERP前端设计》1.3，R-020 页面片）：库存查询、入库单、出库单、仓库各一个页面授权 id；
      // 入库单、出库单的新建、详情、编辑是盖在列表上的子页，仓库的新建、编辑是对话框，都继承列表页的授权。
      { name: 'stock', authorizedAs: 'stock' },
      { name: 'inboundOrders', authorizedAs: 'inboundOrders' },
      { name: 'inboundOrderNew', authorizedAs: 'inboundOrders' },
      { name: 'inboundOrderDetail', authorizedAs: 'inboundOrders' },
      { name: 'inboundOrderEdit', authorizedAs: 'inboundOrders' },
      { name: 'outboundOrders', authorizedAs: 'outboundOrders' },
      { name: 'outboundOrderNew', authorizedAs: 'outboundOrders' },
      { name: 'outboundOrderDetail', authorizedAs: 'outboundOrders' },
      { name: 'outboundOrderEdit', authorizedAs: 'outboundOrders' },
      { name: 'warehouses', authorizedAs: 'warehouses' },
      { name: 'warehouseNew', authorizedAs: 'warehouses' },
      { name: 'warehouseEdit', authorizedAs: 'warehouses' },
      // R-020 波 2：盘点单与调拨单的子页继承各自列表页的页面授权。
      { name: 'stocktakings', authorizedAs: 'stocktakings' },
      { name: 'stocktakingNew', authorizedAs: 'stocktakings' },
      { name: 'stocktaking', authorizedAs: 'stocktakings' },
      { name: 'stocktakingEdit', authorizedAs: 'stocktakings' },
      { name: 'transfers', authorizedAs: 'transfers' },
      { name: 'transferNew', authorizedAs: 'transfers' },
      { name: 'transfer', authorizedAs: 'transfers' },
      { name: 'transferEdit', authorizedAs: 'transfers' },
      // 物料与库存的物料（R-019）：三个标签共用一条路由，页面授权 `items`，对话框与抽屉继承列表页的授权。
      { name: 'items', authorizedAs: 'items' },
      { name: 'itemNew', authorizedAs: 'items' },
      { name: 'itemDetail', authorizedAs: 'items' },
      { name: 'itemEdit', authorizedAs: 'items' },
      { name: 'unitNew', authorizedAs: 'items' },
      { name: 'unitEdit', authorizedAs: 'items' },
      { name: 'categoryNew', authorizedAs: 'items' },
      { name: 'categoryEdit', authorizedAs: 'items' },
      // 采购订单（R-021）与销售订单（R-022）：页面授权 id 见《基座ERP前端设计》1.3，
      // 新建、详情、编辑的子页与生成出入库单的对话框继承列表页的授权。
      { name: 'purchaseOrders', authorizedAs: 'purchaseOrders' },
      { name: 'purchaseOrderNew', authorizedAs: 'purchaseOrders' },
      { name: 'purchaseOrder', authorizedAs: 'purchaseOrders' },
      { name: 'purchaseOrderEdit', authorizedAs: 'purchaseOrders' },
      { name: 'purchaseOrderReceipt', authorizedAs: 'purchaseOrders' },
      { name: 'purchaseRequests', authorizedAs: 'purchaseRequests' },
      { name: 'purchaseRequestNew', authorizedAs: 'purchaseRequests' },
      { name: 'purchaseRequest', authorizedAs: 'purchaseRequests' },
      { name: 'purchaseRequestEdit', authorizedAs: 'purchaseRequests' },
      { name: 'salesOrders', authorizedAs: 'salesOrders' },
      { name: 'salesOrderNew', authorizedAs: 'salesOrders' },
      { name: 'salesOrder', authorizedAs: 'salesOrders' },
      { name: 'salesOrderEdit', authorizedAs: 'salesOrders' },
      { name: 'salesOrderIssue', authorizedAs: 'salesOrders' },
      // R-022 波 2：报价单一页，新建、详情、编辑的子页继承列表页的页面授权。
      { name: 'quotations', authorizedAs: 'quotations' },
      { name: 'quotationNew', authorizedAs: 'quotations' },
      { name: 'quotation', authorizedAs: 'quotations' },
      { name: 'quotationEdit', authorizedAs: 'quotations' },
      // R-064：订单总台账是一张独立的页面，页面授权 id 固定为 orderLedger。
      { name: 'orderLedger', authorizedAs: 'orderLedger' },
      // R-072：业务字典维护页，页面授权 `bizDict` 只给 root；两个对话框继承它。
      { name: 'bizDict', authorizedAs: 'bizDict' },
      { name: 'bizDictNew', authorizedAs: 'bizDict' },
      { name: 'bizDictEdit', authorizedAs: 'bizDict' },
      // R-066：请款单与报销单一页，新建、详情、编辑的子页继承列表页的页面授权。
      { name: 'financeRequests', authorizedAs: 'financeRequests' },
      { name: 'financeRequestNew', authorizedAs: 'financeRequests' },
      { name: 'financeRequest', authorizedAs: 'financeRequests' },
      { name: 'financeRequestEdit', authorizedAs: 'financeRequests' },
      // R-065：支出记录、到票记录两个财务页面，子路由继承各自的页面授权。
      { name: 'expenses', authorizedAs: 'expenses' },
      { name: 'expenseNew', authorizedAs: 'expenses' },
      { name: 'expense', authorizedAs: 'expenses' },
      { name: 'expenseEdit', authorizedAs: 'expenses' },
      { name: 'invoiceReceipts', authorizedAs: 'invoiceReceipts' },
      { name: 'invoiceReceiptNew', authorizedAs: 'invoiceReceipts' },
      { name: 'invoiceReceipt', authorizedAs: 'invoiceReceipts' },
      { name: 'invoiceReceiptEdit', authorizedAs: 'invoiceReceipts' },
      { name: 'quality', authorizedAs: 'quality' },
      { name: 'feedbacks', authorizedAs: 'feedback' },
      { name: 'feedbackNew', authorizedAs: 'feedback' },
      { name: 'feedbackDetail', authorizedAs: 'feedback' },
      // R-017 M5：三个审批页取 authz: 'skip'，和收件箱一样对所有登录用户开放。
      { name: 'approvalMine', authorizedAs: null },
      { name: 'approvalTasks', authorizedAs: null },
      { name: 'approvalDetail', authorizedAs: null },
      { name: 'apiKeysManagement', authorizedAs: null },
      // R-076：打印视图不登记页面授权，进入时按 docType 检查 print 动作。
      { name: 'docPrintView', authorizedAs: null },
      { name: 'models', authorizedAs: 'settings:agents.services' },
      { name: 'agents', authorizedAs: 'agents' },
      { name: 'runtimes', authorizedAs: 'runtimes' },
      { name: 'runtimes-connect', authorizedAs: 'runtimes' },
      { name: 'skills', authorizedAs: 'skills' },
      { name: 'skills-new', authorizedAs: 'skills' },
      { name: 'skills-detail', authorizedAs: 'skills' },
      { name: 'usage', authorizedAs: 'usage' },
      { name: 'settingsHome', authorizedAs: null },
      { name: 'settingsUsers', authorizedAs: 'user:*' },
      { name: 'settingsUserCreate', authorizedAs: 'user:*' },
      { name: 'settingsUser', authorizedAs: 'user:*' },
      { name: 'settingsUserEdit', authorizedAs: 'user:*' },
      { name: 'settingsDepartments', authorizedAs: 'departments' },
      { name: 'settingsEmployees', authorizedAs: 'employees' },
      {
        name: 'settingsRoles',
        authorizedAs: 'settings:authorization.permission-sets',
      },
      {
        name: 'settingsRoleCreate',
        authorizedAs: 'settings:authorization.permission-sets',
      },
      {
        name: 'settingsRoleEdit',
        authorizedAs: 'settings:authorization.permission-sets',
      },
      ...[
        'settingsDefaultAccess',
        'settingsDefaultAccessCreate',
        'settingsDefaultAccessEdit',
      ].map((name) => ({
        name,
        authorizedAs: 'settings:authorization.default-access',
      })),
      {
        name: 'applicationApiKeysManagement',
        authorizedAs: 'application.api-keys',
      },
      { name: 'notificationLogs', authorizedAs: 'notification.logs' },
      { name: 'notificationTemplates', authorizedAs: 'notification.templates' },
      // A template's own address keeps the list page's grant.
      { name: 'notificationTemplate', authorizedAs: 'notification.templates' },
      // R-068：导入工具只在系统设置露出，页面授权 `imports` 默认只有 root。
      { name: 'imports', authorizedAs: 'imports' },
      { name: 'databaseExplorer', authorizedAs: 'database-explorer' },
    ]);
    for (const loader of componentLoadersIn(built.routes))
      await expect(loader()).resolves.toMatchObject({
        default: expect.any(Function),
      });
  });

  it('keeps the inbox out of the application navigation', () => {
    // The inbox is reached from the header's inbox button, so it deliberately declares no menu entry.
    expect(
      applicationRoutes[0].routes.find((route) => route.name === 'inbox'),
    ).not.toHaveProperty('navigation');
  });
});

/** This application's own contribution, registered the way the client runtime registers it. */
function resolveRoutes() {
  return resolveAppClientContributions([
    {
      packageName: '@nocobase/app-template-default',
      routes: applicationRoutes,
      source: 'application',
    },
  ]);
}

/**
 * The paths of the pages a route tree registers. A menu group names no component, so it carries no path of its own
 * and inherits its parent's — filtering on `componentLoader` is what keeps that inherited path out of the list.
 */
function pagePaths(routes: readonly AppClientRegisteredRoute[]): string[] {
  return routes.flatMap((route) => [
    ...(route.componentLoader ? [route.path] : []),
    ...pagePaths(route.children ?? []),
  ]);
}

/** Every page loader in a tree, at any depth. */
function componentLoadersIn(
  routes: readonly AppClientRegisteredRoute[],
): AppClientRouteComponentLoader[] {
  return routes.flatMap((route) => [
    ...(route.componentLoader ? [route.componentLoader] : []),
    ...componentLoadersIn(route.children ?? []),
  ]);
}

/** Page authorization comes directly from the registered tree. */
function pageAuthorizations(
  routes: readonly AppClientRegisteredRoute[],
): { name: string; authorizedAs: string | null }[] {
  return routes.flatMap((route) => [
    ...(route.componentLoader && route.auth === 'required'
      ? [
          {
            name: route.name,
            authorizedAs:
              route.authz === 'skip'
                ? null
                : route.authz === 'unrestricted'
                  ? 'unrestricted'
                  : route.authz.resource.type === 'page'
                    ? route.authz.resource.id
                    : `${route.authz.resource.type}:${route.authz.resource.id}`,
          },
        ]
      : []),
    ...pageAuthorizations(route.children ?? []),
  ]);
}
