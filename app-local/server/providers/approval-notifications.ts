import type { AppPluginApplication } from '@nocobase/app-server/plugins';
import { i18nToken } from '@nocobase/app-server/i18n';
import {
  notificationServiceToken,
  notificationTemplateRegistryToken,
} from '@nocobase/app-plugin-notification/server';
import { databaseManagerToken } from '@nocobase/db';
import { ServiceProvider } from '@nocobase/service-provider';

import {
  approvalNotifierToken,
  createApprovalNotifier,
  registerApprovalNotificationTemplates,
} from '../approval-notifications.js';
import { peopleQueryServiceToken } from './departments.js';

/**
 * R-017 M4：五张通知模板与站内发送器。
 *
 * 模板注册不依赖通道配置；发送器延迟解析通知服务，因此效果在提交之后才拿到它，
 * 测试可以把通知服务换成假实现而不发真实通知。
 */
export default class ApprovalNotificationsProvider extends ServiceProvider<AppPluginApplication> {
  public readonly name = 'app.approval-notifications';
  private unregister?: () => void;

  public override register(): void {
    this.app.container.singleton(approvalNotifierToken, (container) => {
      const notifications = container.resolve(notificationServiceToken);
      const i18n = container.resolve(i18nToken);
      const database = container.resolve(databaseManagerToken);
      const people = container.resolve(peopleQueryServiceToken);
      return createApprovalNotifier({
        notifications,
        i18n,
        connection: database.connection(),
        people,
      });
    });
  }

  public override async boot(): Promise<void> {
    const container = this.app.container;
    if (
      !container.has(notificationTemplateRegistryToken) ||
      !container.has(i18nToken)
    ) {
      return;
    }
    const registry = container.resolve(notificationTemplateRegistryToken);
    const i18n = container.resolve(i18nToken);
    this.unregister = registerApprovalNotificationTemplates(
      registry,
      i18n,
      this.app.config.get('notification'),
    );
  }

  public override async shutdown(): Promise<void> {
    this.unregister?.();
  }
}
