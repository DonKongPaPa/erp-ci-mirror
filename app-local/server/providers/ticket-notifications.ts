import type { Application } from '@nocobase/app-server/application';
import { i18nToken } from '@nocobase/app-server/i18n';
import {
  notificationServiceToken,
  notificationTemplateRegistryToken,
} from '@nocobase/app-plugin-notification/server';
import { ServiceProvider } from '@nocobase/service-provider';
import { databaseManagerToken } from '@nocobase/db';

import { departmentServiceToken } from './departments.js';
import { activeIdsOf } from '../active-users.js';
import {
  createTicketNotifier,
  registerTicketNotificationTemplates,
  ticketNotifierToken,
} from '../ticket-notifications.js';

/**
 * R-003 S8：五张工单通知模板的注册与站内发送器。
 *
 * 模板注册在 boot 阶段：notification 插件的 register 已经把注册表放进容器，
 * 而注册模板本身不依赖通道是否配置好。发送器延迟解析通知服务，效果在提交之后
 * 才拿到它，所以测试可以把这个服务换成假的，不发真实通知。
 */
export default class TicketNotificationsProvider extends ServiceProvider<Application> {
  public readonly name = 'app.ticket-notifications';
  private unregister?: () => void;

  public override register(): void {
    this.app.container.singleton(ticketNotifierToken, (container) => {
      const notifications = container.resolve(notificationServiceToken);
      const i18n = container.resolve(i18nToken);
      const departments = container.resolve(departmentServiceToken);
      const database = container.resolve(databaseManagerToken);
      return createTicketNotifier({
        notifications,
        i18n,
        managerOf: async (departmentId) =>
          departmentId === null ? null : departments.managerOf(departmentId),
        activeIds: (ids) => activeIdsOf(database.connection(), ids),
      });
    });
  }

  public override async boot(): Promise<void> {
    const container = this.app.container;
    if (!container.has(notificationTemplateRegistryToken) || !container.has(i18nToken)) {
      return;
    }
    const registry = container.resolve(notificationTemplateRegistryToken);
    const i18n = container.resolve(i18nToken);
    this.unregister = registerTicketNotificationTemplates(
      registry,
      i18n,
      this.app.config.get('notification'),
    );
  }

  public override async shutdown(): Promise<void> {
    this.unregister?.();
  }
}
