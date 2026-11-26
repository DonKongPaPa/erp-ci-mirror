import {
  authorizationToken,
  type Authorization,
} from '@nocobase/app-plugin-authorization';
import type { Application } from '@nocobase/app-server/application';
import { databaseManagerToken } from '@nocobase/db';
import {
  createRepositoryLifecycleStore,
  LifecycleRuntime,
} from '@nocobase/lifecycle';
import {
  createServiceToken,
  ServiceProvider,
  type ServiceToken,
} from '@nocobase/service-provider';

import { fqcTicketsLifecycle } from '../lifecycles/fqc-tickets.js';
import { departmentServiceToken } from './departments.js';
import { ticketScopeFor } from '../ticket-scope.js';

/**
 * R-003 S5：应用唯一的 lifecycle 运行时（R-017 尚未落地，由本片带上）。
 *
 * 一个应用只跑一个 LifecycleRuntime；定义注册在它上面，业务端点从
 * `lifecycleRuntimeToken` 取，绝不每个路由各建一个。日志表的仓储 store 默认读写
 * `lifecycleTransitions` / `lifecycleEffectRuns`，由迁移 202611260005 建。
 *
 * 本片没有 effect、没有 trigger、没有定时扫单，所以不接 jobs dispatcher：
 * 没有需要投递到进程外的工作，也不需要 sweep / recover。这一层留给 S8 的通知
 * effect 时再接。`services` 是工厂：guard 拿到的部门服务与授权都从容器解析，
 * 转派的目标部门校验与 `ticket-candidates` 共用 `ticket-scope.ts` 的判断。
 */
export const lifecycleRuntimeToken: ServiceToken<LifecycleRuntime> =
  createServiceToken<LifecycleRuntime>('app/lifecycle-runtime');

export default class LifecycleProvider extends ServiceProvider<Application> {
  public readonly name = 'app/lifecycle-provider';
  private runtime: LifecycleRuntime | undefined;

  public override register(): void {
    this.app.container.singleton(lifecycleRuntimeToken, () =>
      this.lifecycleRuntime(),
    );
  }

  private lifecycleRuntime(): LifecycleRuntime {
    if (this.runtime) return this.runtime;
    const database = this.app.container.resolve(databaseManagerToken);
    const authorization = this.app.container.resolve(
      authorizationToken,
    ) as Authorization;
    const departments = this.app.container.resolve(departmentServiceToken);
    const runtime = new LifecycleRuntime({
      store: createRepositoryLifecycleStore(database),
    });
    runtime.register(fqcTicketsLifecycle, {
      services: () => ({
        scopeOf: (actorId: string) => ticketScopeFor(authorization, actorId),
        departmentActive: async (departmentId: string) =>
          (await departments.subtreeIds(departmentId)).length > 0,
        memberOf: async (departmentId: string, userId: string) =>
          (await departments.memberIdsOf(departmentId)).includes(userId),
      }),
    });
    this.runtime = runtime;
    return runtime;
  }
}
