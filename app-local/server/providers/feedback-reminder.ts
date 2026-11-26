import type { Application } from '@nocobase/app-server/application';
import { jobExecutorServiceToken } from '@nocobase/app-server/jobs';
import { loggingToken } from '@nocobase/app-server/logging';
import {
  notificationServiceToken,
  type NotificationService,
} from '@nocobase/app-plugin-notification';
import { databaseManagerToken } from '@nocobase/db';
import type { ScheduleExecutor } from '@nocobase/jobs';
import { ServiceProvider } from '@nocobase/service-provider';

import {
  FEEDBACK_REMINDER_INTERVAL_MS,
  FEEDBACK_REMINDER_JOB,
  FEEDBACK_REMINDER_JOB_NAME,
  scanFeedbackReminders,
  type ReminderNotifier,
} from '../feedback-reminder.js';

/**
 * 站内通知的通道名是配置里的名字，不是 channel type。三份样例配置
 * （config(.prod|.test).example.yml）都把 `inbox` 配成 `type: in-app`；
 * 通知服务按配置名查通道，写成 type 会被拒发。
 */
export const FEEDBACK_REMINDER_CHANNEL = 'inbox';
/**
 * 每天固定时刻（北京时间 02:00 = 18:00Z）的起始锚点，取 2026-01-01 那一趟。
 * 固定值有三个理由：错开工作时段；重启前后规则逐字段相同，调度器不会把
 * 下一次运行时间重置到新起点；它不是启动时刻，所以配了它就不会一启动就扫。
 * 绝不能用 `Date.now() + 间隔` —— 每次启动值都不同，频繁重启会把扫描一直往后推。
 */
export const FEEDBACK_REMINDER_ANCHOR = new Date('2026-01-01T18:00:00.000Z');
/** 关进程时等在途扫描的上限；通知服务挂住会无限拖住关闭。 */
export const SHUTDOWN_IDLE_TIMEOUT_MS = 60 * 1000;

/** 把通知服务的接口收窄成扫描函数需要的两件事；收件人解析留在服务端。 */
function toNotifier(notifications: NotificationService): ReminderNotifier {
  return {
    async send(message) {
      const result = await notifications.send({
        idempotencyKey: message.idempotencyKey,
        source: { type: 'feedback-reminder' },
        messages: {
          [FEEDBACK_REMINDER_CHANNEL]: {
            to: message.to,
            title: message.title,
            body: message.body,
            target: message.target,
          },
        },
      });
      return { status: result.status, updatedAt: new Date().toISOString() };
    },
    async getByIdempotencyKey(key) {
      const snapshot = await notifications.getByIdempotencyKey(key);
      return snapshot
        ? { status: snapshot.status, updatedAt: snapshot.updatedAt }
        : undefined;
    },
  };
}

/**
 * R-026 七天提醒的定时任务：进程内、单实例，每天一次，机制照
 * `server/providers/submission.ts` 的收据清理。`ScheduleExecutor.shutdown()`
 * 不等已经在跑的 handler，所以这里也自己等在途扫描结束再让连接池销毁，
 * 但等待有上限，超时记日志放行。
 */
export default class FeedbackReminderProvider extends ServiceProvider<Application> {
  readonly name = 'app.feedback-reminder';
  private scan?: ScheduleExecutor;
  private runningJobs = 0;
  private readonly idleWaiters: Array<() => void> = [];
  protected idleTimeoutMs = SHUTDOWN_IDLE_TIMEOUT_MS;
  private log: (message: string) => void = (message) => console.warn(message);

  override async boot(): Promise<void> {
    const container = this.app.container;
    if (
      !container.has(databaseManagerToken) ||
      !container.has(jobExecutorServiceToken) ||
      !container.has(notificationServiceToken)
    )
      return;
    const logger = container.has(loggingToken)
      ? container.resolve(loggingToken).getLogger('feedback-reminder')
      : undefined;
    if (logger) {
      this.log = (message) =>
        logger.warn({ event: 'feedback-reminder' }, message);
    }
    const database = container.resolve(databaseManagerToken);
    const notifications = container.resolve(notificationServiceToken);
    this.scan = container
      .resolve(jobExecutorServiceToken)
      .getScheduleExecutor(FEEDBACK_REMINDER_JOB);
    await this.scan.addJob({
      name: FEEDBACK_REMINDER_JOB_NAME,
      options: {
        every: FEEDBACK_REMINDER_INTERVAL_MS,
        startDate: FEEDBACK_REMINDER_ANCHOR,
      },
      payload: {},
      execute: async () => {
        this.runningJobs += 1;
        try {
          await scanFeedbackReminders({
            connection: database.connection(),
            notifier: toNotifier(notifications),
            now: new Date(),
            log: this.log,
          });
        } finally {
          this.runningJobs -= 1;
          if (this.runningJobs === 0) {
            for (const resolve of this.idleWaiters.splice(0)) resolve();
          }
        }
      },
    });
    await this.scan.setup();
  }

  private whenJobsIdle(): Promise<void> {
    if (this.runningJobs === 0) return Promise.resolve();
    return new Promise((resolve) => {
      const state: {
        timer?: ReturnType<typeof setTimeout>;
        finish?: () => void;
      } = {};
      state.finish = () => {
        if (state.timer !== undefined) clearTimeout(state.timer);
        resolve();
      };
      state.timer = setTimeout(() => {
        const index = this.idleWaiters.indexOf(state.finish!);
        if (index >= 0) this.idleWaiters.splice(index, 1);
        this.log(
          `feedback-reminder: 关闭时等在途扫描超过 ${this.idleTimeoutMs}ms，放行`,
        );
        resolve();
      }, this.idleTimeoutMs);
      this.idleWaiters.push(state.finish);
    });
  }

  override async shutdown(): Promise<void> {
    await this.scan?.shutdown();
    await this.whenJobsIdle();
  }
}
