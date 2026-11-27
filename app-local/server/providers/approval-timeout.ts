import type { Application } from '@nocobase/app-server/application';
import { jobExecutorServiceToken } from '@nocobase/app-server/jobs';
import { loggingToken } from '@nocobase/app-server/logging';
import { notificationServiceToken } from '@nocobase/app-plugin-notification/server';
import { databaseManagerToken } from '@nocobase/db';
import type { ScheduleExecutor } from '@nocobase/jobs';
import { ServiceProvider } from '@nocobase/service-provider';

import { approvalNotifierToken } from '../approval-notifications.js';
import {
  APPROVAL_REMINDER_ANCHOR,
  APPROVAL_REMINDER_INTERVAL_MS,
  APPROVAL_REMINDER_JOB,
  APPROVAL_REMINDER_JOB_NAME,
  scanApprovalTimeouts,
} from '../approval-timeout.js';
import { lifecycleRuntimeToken } from './lifecycles.js';

/**
 * R-017 M4：进程内每小时一次的扫单。
 *
 * 一趟做三件事：任务级超时扫描、lifecycle 的流程级触发器 sweep（自转移催办）、
 * 三十天前已结束的效果运行记录清理。业务转移与操作记录是审计，不清理。
 */
export default class ApprovalTimeoutProvider extends ServiceProvider<Application> {
  public readonly name = 'app.approval-timeout';
  private scan?: ScheduleExecutor;

  public override async boot(): Promise<void> {
    const container = this.app.container;
    if (
      !container.has(databaseManagerToken) ||
      !container.has(jobExecutorServiceToken) ||
      !container.has(approvalNotifierToken) ||
      // 没有通知插件的应用（例如最小运行时）发不出提醒，安静跳过。
      !container.has(notificationServiceToken) ||
      !container.has(lifecycleRuntimeToken)
    ) {
      return;
    }
    const logger = container.has(loggingToken)
      ? container.resolve(loggingToken).getLogger('approval-reminder')
      : undefined;
    const log = (message: string) => {
      if (logger) logger.warn(message);
      else console.warn(message);
    };
    const database = container.resolve(databaseManagerToken);
    const notifier = container.resolve(approvalNotifierToken);
    const runtime = container.resolve(lifecycleRuntimeToken);
    this.scan = container
      .resolve(jobExecutorServiceToken)
      .getScheduleExecutor(APPROVAL_REMINDER_JOB);
    await this.scan.addJob({
      name: APPROVAL_REMINDER_JOB_NAME,
      options: {
        every: APPROVAL_REMINDER_INTERVAL_MS,
        startDate: APPROVAL_REMINDER_ANCHOR,
      },
      payload: {},
      execute: async () => {
        try {
          const connection = database.connection();
          // 没有审批表的应用按小时扫只会反复报 RepositoryError；开扫前查一次，
          // 不在注册表里就整趟跳过，也不告警。
          if (!(await connection.collections.get('approvals'))) return;
          await runtime.runTriggers();
          await scanApprovalTimeouts({
            connection,
            notifier,
            now: new Date(),
            log,
          });
          await runtime.prune({
            olderThan: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
          });
        } catch (error) {
          log(`approval-reminder: 扫单失败: ${String(error)}`);
        }
      },
    });
    await this.scan.setup();
  }

  public override async shutdown(): Promise<void> {
    await this.scan?.shutdown();
  }
}
