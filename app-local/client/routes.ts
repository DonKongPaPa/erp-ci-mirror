import databaseExplorerRoutes from './pages/settings/database-explorer/routes.js';
import { createAppClientConfig } from '@nocobase/app-client';
import { readAppClientRuntimeConfig } from '@nocobase/app-client/runtime';
import { includeNotificationTemplateRoutes } from './pages/settings/notification-routes.js';
import notificationLogRoutes from './pages/settings/notification-log-routes.js';
import { ITEMS_PAGE_ID } from './pages/items/page-id.js';
import { PARTNERS_PAGE_ID } from './pages/partners/page-id.js';
import { SHIFTS_PAGE_ID } from './pages/shifts/page-id.js';
import {
  Bot,
  Boxes,
  ChartColumn,
  Clock,
  Cpu,
  Handshake,
  Home,
  IdCard,
  MessageSquareWarning,
  MonitorSmartphone,
  Package,
  ShieldAlert,
  Users,
  Wrench,
} from 'lucide-react';
import {
  agentsRoute,
  modelsRoute,
  runtimesRoute,
  skillsRoute,
  usageRoute,
} from '@nocobase/app-plugin-agents/client/routes';
import {
  loadFeedbackDetailModule,
  loadFeedbackNewModule,
} from './pages/feedbacks/preload.js';
import { FEEDBACK_PAGE_ID } from './pages/feedbacks/page-id.js';
import settingsShellRoutes from './pages/settings/shell-routes.js';
import systemSettingsRoutes from './pages/settings/routes.js';
import {
  defineAppRoutes,
  type AppClientRouteContribution,
} from '@nocobase/app-client/plugins';

const appRoutes: AppClientRouteContribution = defineAppRoutes([
  {
    // Every signed-in user reaches the landing page. `authz: 'skip'` takes it out of page authorization entirely, so
    // no permission change can leave a user signed in with nowhere to land.
    authz: 'skip',
    auth: 'required',
    componentLoader: () => import('./pages/home/index.js'),
    name: 'home',
    navigation: { title: 'navigation.home', icon: Home },
    path: '/',
  },
  {
    // Declares no navigation, so the application decides where its entry goes (for example a sidebar item with an
    // unread badge). The plugin's API answers each person's own messages only, so the page needs no authorization of
    // its own.
    authz: 'skip',
    auth: 'required',
    componentLoader: () => import('./pages/inbox.js'),
    name: 'inbox',
    path: '/inbox',
  },
  {
    // 人事（《基座ERP前端设计》第一节）：可折叠的分组。现在只有班次定义一页；员工、部门从系统设置
    // 挪进来是另一片（设计 1.4），到时直接加进这个分组，路径与页面授权 id 都不变。
    auth: 'required',
    name: 'hr',
    navigation: { title: 'navigation.hr', icon: IdCard },
    children: [
      {
        // R-025 班次定义：页面授权 `shifts` 默认只给 root；打开之后读、写再分 shifts 的 view / manage。
        auth: 'required',
        authz: {
          resource: { type: 'page', id: SHIFTS_PAGE_ID },
          action: 'access',
        },
        breadcrumb: { title: 'navigation.shifts' },
        componentLoader: () => import('./pages/shifts/index.js'),
        name: 'shifts',
        navigation: { title: 'navigation.shifts', icon: Clock },
        path: '/shifts',
        // 新建、编辑、复制新建都是路由上的对话框，从这一页继承授权。
        children: [
          {
            componentLoader: () => import('./pages/shifts/new.js'),
            name: 'shiftNew',
            path: 'new',
            presentation: { kind: 'dialog', title: 'shifts.form.newTitle' },
          },
          {
            componentLoader: () => import('./pages/shifts/edit.js'),
            name: 'shiftEdit',
            path: ':shiftId/edit',
            presentation: { kind: 'dialog', title: 'shifts.form.editTitle' },
          },
          {
            componentLoader: () => import('./pages/shifts/copy.js'),
            name: 'shiftCopy',
            path: ':shiftId/copy',
            presentation: { kind: 'dialog', title: 'shifts.form.copyTitle' },
          },
        ],
      },
    ],
  },
  {
    // R-014 客户与供应商：一条路由、一个页面授权 id，「客户」「供应商」两个标签靠
    // customers.view、suppliers.view 各自显隐（销售只看得到客户，采购只看得到供应商）。
    auth: 'required',
    authz: {
      resource: { type: 'page', id: PARTNERS_PAGE_ID },
      action: 'access',
    },
    breadcrumb: { title: 'navigation.partners' },
    componentLoader: () => import('./pages/partners/index.js'),
    name: 'partners',
    navigation: { title: 'navigation.partners', icon: Handshake },
    path: '/partners',
    children: [
      {
        componentLoader: () => import('./pages/partners/new.js'),
        name: 'partnerNew',
        path: 'new',
        presentation: { kind: 'dialog', title: 'partners.newTitle' },
      },
      {
        // 详情是抽屉；编辑与联系人的对话框叠在抽屉上，都从它继承授权。
        componentLoader: () => import('./pages/partners/detail.js'),
        name: 'partnerDetail',
        path: ':partnerId',
        presentation: { kind: 'drawer', title: 'partners.title' },
        children: [
          {
            componentLoader: () => import('./pages/partners/edit.js'),
            name: 'partnerEdit',
            path: 'edit',
            presentation: { kind: 'dialog', title: 'partners.form.editTitle' },
          },
          {
            componentLoader: () => import('./pages/partners/contact-new.js'),
            name: 'partnerContactNew',
            path: 'contacts/new',
            presentation: {
              kind: 'dialog',
              title: 'partners.contact.addTitle',
            },
          },
          {
            componentLoader: () => import('./pages/partners/contact-edit.js'),
            name: 'partnerContactEdit',
            path: 'contacts/:contactId/edit',
            presentation: {
              kind: 'dialog',
              title: 'partners.contact.editTitle',
            },
          },
        ],
      },
    ],
  },
  {
    // 物料与库存（《基座ERP前端设计》第一节）：可折叠的分组。现在只有物料一页；库存查询、入库单、
    // 出库单、仓库是另外的片，到时直接加进这个分组。
    auth: 'required',
    name: 'inventory',
    navigation: { title: 'navigation.inventory', icon: Boxes },
    children: [
      {
        // R-019 物料：物料清单、计量单位、物料分类三个标签共用这一条路由（标签记在地址栏的 view 上）。
        // 页面授权 `items` 给销售、采购与 root；打开之后读、写再分 items 的 view / manage。
        auth: 'required',
        authz: {
          resource: { type: 'page', id: ITEMS_PAGE_ID },
          action: 'access',
        },
        breadcrumb: { title: 'navigation.items' },
        componentLoader: () => import('./pages/items/index.js'),
        name: 'items',
        navigation: { title: 'navigation.items', icon: Package },
        path: '/items',
        // 新建、编辑的路由对话框与详情抽屉都从这一页继承授权。
        children: [
          {
            componentLoader: () => import('./pages/items/new.js'),
            name: 'itemNew',
            path: 'new',
            presentation: { kind: 'dialog', title: 'items.form.newTitle' },
          },
          {
            // 详情是抽屉；编辑的对话框叠在抽屉上。
            componentLoader: () => import('./pages/items/detail.js'),
            name: 'itemDetail',
            path: ':itemId',
            presentation: { kind: 'drawer', title: 'items.detailTitle' },
            children: [
              {
                componentLoader: () => import('./pages/items/edit.js'),
                name: 'itemEdit',
                path: 'edit',
                presentation: {
                  kind: 'dialog',
                  title: 'items.form.editTitle',
                },
              },
            ],
          },
          {
            componentLoader: () => import('./pages/items/unit-new.js'),
            name: 'unitNew',
            path: 'units/new',
            presentation: { kind: 'dialog', title: 'items.units.newTitle' },
          },
          {
            componentLoader: () => import('./pages/items/unit-edit.js'),
            name: 'unitEdit',
            path: 'units/:unitCode/edit',
            presentation: { kind: 'dialog', title: 'items.units.editTitle' },
          },
          {
            componentLoader: () => import('./pages/items/category-new.js'),
            name: 'categoryNew',
            path: 'categories/new',
            presentation: {
              kind: 'dialog',
              title: 'items.categories.newTitle',
            },
          },
          {
            componentLoader: () => import('./pages/items/category-edit.js'),
            name: 'categoryEdit',
            path: 'categories/:categoryId/edit',
            presentation: {
              kind: 'dialog',
              title: 'items.categories.editTitle',
            },
          },
        ],
      },
    ],
  },
  {
    // 质量工单看板：客户反馈初筛与分流。
    // authz 声明在路径首个页面上，page id 用于存储页面授权，改名需要迁移引用它的授权。
    auth: 'required',
    authz: { resource: { type: 'page', id: 'quality' }, action: 'access' },
    componentLoader: () => import('./pages/quality/index.js'),
    name: 'quality',
    navigation: { title: 'navigation.quality', icon: ShieldAlert },
    path: '/quality',
  },
  {
    // R-026：反馈单。另设页面授权（两个动作任一都能进来），能做什么在页面里按动作分；
    // 不挂在质量页下面，否则普通员工会连质量页一起打得开。
    auth: 'required',
    authz: {
      resource: { type: 'page', id: FEEDBACK_PAGE_ID },
      action: 'access',
    },
    componentLoader: () => import('./pages/feedbacks/index.js'),
    name: 'feedbacks',
    navigation: { title: 'navigation.feedbacks', icon: MessageSquareWarning },
    path: '/feedbacks',
    children: [
      {
        name: 'feedbackNew',
        path: 'new',
        presentation: { kind: 'dialog', title: 'feedbacks.form.titleNew' },
        componentLoader: loadFeedbackNewModule,
      },
      {
        name: 'feedbackDetail',
        path: ':feedbackId',
        presentation: { kind: 'dialog', title: 'feedbacks.form.titleEdit' },
        componentLoader: loadFeedbackDetailModule,
      },
    ],
  },
  {
    // R-032「我的 API 密钥」：每个登录用户只管自己的密钥，接口只作用于本人。
    // 所以页面像 inbox 一样不需要页面授权；入口在右上角账号菜单，不声明 navigation。
    auth: 'required',
    authz: 'skip',
    componentLoader: () => import('./pages/account/api-keys.js'),
    name: 'apiKeysManagement',
    path: '/account/api-keys',
  },
  {
    auth: 'guest',
    authz: 'skip',
    componentLoader: () => import('./pages/auth/login.js'),
    name: 'login',
    path: '/login',
  },
  {
    auth: 'guest',
    authz: 'skip',
    componentLoader: () => import('./pages/auth/register.js'),
    name: 'register',
    path: '/register',
  },
  {
    auth: 'guest',
    authz: 'skip',
    componentLoader: () => import('./pages/auth/forgot-password.js'),
    name: 'forgot-password',
    path: '/forgot-password',
  },
  {
    auth: 'guest',
    authz: 'skip',
    componentLoader: () => import('./pages/auth/reset-password.js'),
    name: 'reset-password',
    path: '/reset-password',
  },
  {
    // Where a command line's sign-in sends the person to approve it (`pages/auth/device.tsx`). Optional rather than
    // required so it renders outside the shell, like the sign-in pages; the page sends a guest to sign in and back.
    auth: 'optional',
    authz: 'skip',
    componentLoader: () => import('./pages/auth/device.js'),
    name: 'device',
    path: '/device',
  },
  {
    // The AI Agent plugin's five pages are routed by this application (`@nocobase/app-plugin-agents/client/routes`
    // exports them without navigation). They keep the plugin's own top-level paths: its skills pages link to `/skills`
    // directly, so moving them under `/settings` would break those links.
    auth: 'required',
    navigation: { title: 'navigation.ai', icon: Bot },
    name: 'ai',
    children: [
      // `agents.services` read rather than a page grant: the model services are a settings item.
      {
        ...modelsRoute,
        navigation: { title: 'navigation.aiModels', icon: Cpu },
      },
      {
        ...agentsRoute,
        navigation: { title: 'navigation.aiAgents', icon: Users },
      },
      {
        ...runtimesRoute,
        navigation: { title: 'navigation.aiRuntimes', icon: MonitorSmartphone },
      },
      {
        ...skillsRoute,
        navigation: { title: 'navigation.aiSkills', icon: Wrench },
      },
      {
        ...usageRoute,
        navigation: { title: 'navigation.aiUsage', icon: ChartColumn },
      },
    ],
  },
]);

// The System settings shell stays registered: it shows only the modules a viewer may open, and none until the
// application or its plugins contribute one. Business administration such as `./pages/settings/routes.js` joins it.
export function createApplicationRoutes(
  rawConfig: unknown = readAppClientRuntimeConfig(),
): readonly AppClientRouteContribution[] {
  const config = createAppClientConfig({ rawConfig });
  return includeNotificationTemplateRoutes(
    [
      appRoutes,
      settingsShellRoutes,
      systemSettingsRoutes,
      databaseExplorerRoutes,
      notificationLogRoutes,
    ],
    config.get<boolean>('notificationTemplates.invitationConfigured') === true,
  );
}

const routes: readonly AppClientRouteContribution[] = createApplicationRoutes();

export default routes;
