import type { Application } from '@nocobase/app-server/application';
import {
  authenticationToken,
  type AuthEnv,
} from '@nocobase/app-plugin-authentication';
import {
  repositoryIdempotencyToken,
  pruneMutationReceipts,
} from '@nocobase/app-server/router';
import { jobExecutorServiceToken } from '@nocobase/app-server/jobs';
import { databaseManagerToken } from '@nocobase/db';
import { ServiceProvider } from '@nocobase/service-provider';
import type { Context } from 'hono';
import type { ScheduleExecutor } from '@nocobase/jobs';

/** Standard data writes require an operation key; custom HTTP actions opt in explicitly. */
export default class SubmissionProvider extends ServiceProvider<Application> {
  readonly name = 'app/submission';
  private cleanup?: ScheduleExecutor;
  /**
   * Jobs the schedule executor accepted before shutdown. `ScheduleExecutor.shutdown()`
   * closes the schedule but does not wait for a handler that is already running, so
   * shutdown waits here: a cleanup that still holds a connection must finish before the
   * database provider destroys the pool.
   */
  private runningJobs = 0;
  private readonly idleWaiters: Array<() => void> = [];
  override register(): void {
    this.app.container.singleton(repositoryIdempotencyToken, () => ({
      required: true,
      principal: async (context) => {
        const auth =
          (context as Context<AuthEnv>).get('auth') ??
          (await this.app.container
            .resolve(authenticationToken)
            .getSession(context.req.raw.headers, {
              disableRefresh: true,
              disableCookieCache: true,
            }));
        return auth && !auth.credential
          ? `${this.app.appName}:${auth.user.id}`
          : undefined;
      },
    }));
  }
  override async boot(): Promise<void> {
    if (
      !this.app.container.has(databaseManagerToken) ||
      !this.app.container.has(jobExecutorServiceToken)
    )
      return;
    const database = this.app.container.resolve(databaseManagerToken);
    this.cleanup = this.app.container
      .resolve(jobExecutorServiceToken)
      .getScheduleExecutor('app.mutation-receipts');
    await this.cleanup.addJob({
      name: 'prune',
      options: { every: 60 * 60 * 1000 },
      payload: {},
      execute: async () => {
        this.runningJobs += 1;
        try {
          await pruneMutationReceipts(database.connection());
        } finally {
          this.runningJobs -= 1;
          if (this.runningJobs === 0) {
            for (const resolve of this.idleWaiters.splice(0)) resolve();
          }
        }
      },
    });
    await this.cleanup.setup();
  }
  private whenJobsIdle(): Promise<void> {
    if (this.runningJobs === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }
  override async shutdown(): Promise<void> {
    await this.cleanup?.shutdown();
    await this.whenJobsIdle();
  }
}
