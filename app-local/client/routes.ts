import databaseExplorerRoutes from './pages/settings/database-explorer/routes.js';
import { createAppClientConfig } from '@nocobase/app-client';
import { readAppClientRuntimeConfig } from '@nocobase/app-client/runtime';
import { includeNotificationTemplateRoutes } from './pages/settings/notification-routes.js';
import notificationLogRoutes from './pages/settings/notification-log-routes.js';
import {
  Bot,
  ChartColumn,
  Cpu,
  Home,
  MessageSquareWarning,
  MonitorSmartphone,
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
