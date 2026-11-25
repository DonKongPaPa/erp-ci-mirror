import { Bell } from 'lucide-react';
import { defineAppRoutes } from '@nocobase/app-client/plugins';

/**
 * R-034「通知记录」：系统设置里的「通知管理」模块，第一个视图是记录页。
 *
 * 只读，守在页面授权 `notification.logs` 后面；这个授权不授给任何业务角色，
 * 默认只有 root 能进。登记了这个模块之后，`includeNotificationTemplateRoutes`
 * 会把「通知模板」作为第二个视图挂进来 —— 模板目录因此也会出现，这是预期内的。
 */
export const notificationLogsRoute = {
  name: 'notificationLogs',
  // 注册后的地址是 /settings/notifications/logs：设置外壳提供 /settings，
  // 这个模块再提供 /notifications。
  path: '/notifications/logs',
  auth: 'required' as const,
  authz: {
    resource: { type: 'page', id: 'notification.logs' },
    action: 'access',
  },
  navigation: { title: 'settings.notificationLogs', icon: Bell },
  breadcrumb: { title: 'settings.notificationLogs' },
  componentLoader: () => import('./notification-logs.js'),
};

export default defineAppRoutes([
  {
    parent: 'settingsSystem',
    name: 'notificationManagement',
    navigation: {
      title: 'settings.notificationManagement',
      description: 'settings.notificationManagementDescription',
      icon: Bell,
    },
    breadcrumb: { title: 'settings.notificationManagement' },
    children: [notificationLogsRoute],
  },
]);
