// @vitest-environment node
import type { Application } from '@nocobase/app-server/application';
import {
  authenticationToken,
  type Auth,
} from '@nocobase/app-plugin-authentication';
import {
  pruneMutationReceipts,
  repositoryIdempotencyToken,
  type RepositoryIdempotencyConfig,
} from '@nocobase/app-server/router';
import { jobExecutorServiceToken } from '@nocobase/app-server/jobs';
import { databaseManagerToken, type DatabaseManager } from '@nocobase/db';
import {
  ScheduleReceiptCode,
  type JobExecutorService,
  type ScheduleExecutionContext,
  type ScheduleExecutor,
  type ScheduleJobOption,
} from '@nocobase/jobs';
import { ServiceContainer } from '@nocobase/service-provider';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import SubmissionProvider from '../../server/providers/submission.js';

/**
 * `server/providers/submission.ts` 的单元测试；每条测试上方写明它守的是哪一条行为。
 *
 * 收尾契约（见 `whenJobsIdle` 上的注释）：`ScheduleExecutor.shutdown()` 只关调度、
 * 不等已经开跑的 handler，所以 provider 必须自己等在途的 prune 结束，数据库连接池
 * 才能被销毁。`whenJobsIdle` 是私有方法，只能从 `shutdown()` 这条公开路径观察。
 *
 * `pruneMutationReceipts` 换成可控假件；执行器是实现了完整接口的假件，handler 由测试
 * 手动驱动，于是「有任务在途」和「装配被扣住」都是真前置条件，不是靠猜的时序。
 * 令牌本身保持共享引用（展开实际导出不换身份），产品代码与本测试解析到同一个 token。
 */

vi.mock('@nocobase/app-server/router', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@nocobase/app-server/router')>();
  return { ...actual, pruneMutationReceipts: vi.fn() };
});

const prune = vi.mocked(pruneMutationReceipts);

type PrincipalContext = Parameters<
  RepositoryIdempotencyConfig['principal']
>[0];

interface CapturedJob {
  readonly name: string;
  readonly options: ScheduleJobOption;
  execute(context: ScheduleExecutionContext): Promise<void>;
}

/** 排程执行器的假件：记录 provider 实际用到的动作，handler 由测试手动触发。 */
function fakeScheduleExecutor() {
  const jobs = new Map<string, CapturedJob>();
  const events: string[] = [];
  const calls = { addJob: 0, setup: 0, shutdown: 0 };
  const setup = vi.fn(async () => {
    events.push('setup');
    calls.setup += 1;
  });
  const shutdown = vi.fn(async () => {
    events.push('shutdown');
    calls.shutdown += 1;
  });
  const api: ScheduleExecutor = {
    async addJob(job) {
      events.push('addJob');
      calls.addJob += 1;
      jobs.set(job.name, {
        name: job.name,
        options: job.options,
        execute: job.execute,
      });
      return {
        jobName: job.name,
        code: ScheduleReceiptCode.Upserted,
        message: 'Job upserted',
      };
    },
    async removeJob(name) {
      jobs.delete(name);
      return {
        jobName: name,
        code: ScheduleReceiptCode.Removed,
        message: 'Job removed',
      };
    },
    async countJob() {
      return jobs.size;
    },
    async listJob() {
      return [];
    },
    async getJob(name) {
      const job = jobs.get(name);
      return job
        ? {
            jobName: job.name,
            options: job.options,
            payload: undefined,
          }
        : undefined;
    },
    subscribe: () => () => {},
    setup,
    shutdown,
  };
  return { api, jobs, events, calls, setup, shutdown };
}

function buildProvider(
  options: { database?: boolean; jobs?: boolean; auth?: Auth } = {},
): {
  container: ServiceContainer;
  provider: SubmissionProvider;
  executor: ReturnType<typeof fakeScheduleExecutor>;
  connection: { readonly label: string };
  connectionOf: ReturnType<typeof vi.fn<() => unknown>>;
  getScheduleExecutor: ReturnType<
    typeof vi.fn<(scope: string) => ScheduleExecutor>
  >;
} {
  const container = new ServiceContainer();
  const connection = { label: 'app-connection' };
  const connectionOf = vi.fn(() => connection);
  if (options.database !== false) {
    container.instance(
      databaseManagerToken,
      { connection: connectionOf } as unknown as DatabaseManager,
    );
  }
  const executor = fakeScheduleExecutor();
  const getScheduleExecutor = vi.fn(() => executor.api);
  if (options.jobs !== false) {
    container.instance(
      jobExecutorServiceToken,
      { getScheduleExecutor } as unknown as JobExecutorService,
    );
  }
  if (options.auth !== undefined)
    container.instance(authenticationToken, options.auth);
  const provider = new SubmissionProvider({
    container,
    appName: 'test-app',
  } as unknown as Application);
  return {
    container,
    provider,
    executor,
    connection,
    connectionOf,
    getScheduleExecutor,
  };
}

/** 幂等主体的调用环境：只造 principal 实际读的东西（auth 变量与原始头）。 */
const contextOf = (auth: unknown, headers: Headers = new Headers()) =>
  ({
    get: (key: string) => (key === 'auth' ? auth : undefined),
    req: { raw: { headers } },
  }) as unknown as PrincipalContext;

/** prune handler 的触发参数：closure 里不读它，给齐字段即可。 */
const executionContext = (): ScheduleExecutionContext => ({
  jobId: 'test-firing',
  scheduledAt: new Date(0),
  runAt: new Date(0),
  signal: new AbortController().signal,
});

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * 门的用法：把 prune（或 setup）停在一个测试攥着的 promise 后。「不许提前返回」的
 * 断言给 50ms 窗口 —— 门关着时正确的实现不可能结束；「必须返回」在开门之后给
 * 2s 窗口 —— 正确实现是微任务级结束。两个方向都不靠机器快慢。
 */
async function outcomeOf<T>(
  promise: Promise<T>,
  windowMs: number,
): Promise<'fulfilled' | 'rejected' | 'pending'> {
  return Promise.race([
    promise.then(
      () => 'fulfilled' as const,
      () => 'rejected' as const,
    ),
    sleep(windowMs).then(() => 'pending' as const),
  ]);
}

/** 可控的门：unblock 之前一直扣着，用来建立真实的前置条件。 */
function gate() {
  let release!: () => void;
  const opened = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { opened, open: () => release() };
}

beforeEach(() => {
  prune.mockReset();
});

describe('shutdown()：等在途清理结束（whenJobsIdle）', () => {
  it('没有在途任务时 shutdown 立即结束，并且恰好关一次执行器', async () => {
    // 守的行为：空闲时 whenJobsIdle 直接 resolve；执行器的 shutdown 恰好调一次，不挂住关机。
    const { provider, executor } = buildProvider();
    await provider.boot();

    await expect(provider.shutdown()).resolves.toBeUndefined();
    expect(executor.calls.shutdown).toBe(1);
    expect(prune).not.toHaveBeenCalled();
  });

  it('boot 没跑过（cleanup 缺席）时 shutdown 直接结束', async () => {
    // 守的行为：boot 早退后收尾不能炸 —— this.cleanup?.shutdown() 的可选链是契约。
    const { provider } = buildProvider();

    await expect(provider.shutdown()).resolves.toBeUndefined();
  });

  it('boot 真的等到 setup 完成才返回', async () => {
    // 守的行为：setup 必须被 await —— 装配没完成 boot 不能返回。
    // 前置条件：setup 停在我们攥着的门后，boot 确实卡在里面。把 await 改成不等待，本条必红。
    const { provider, executor } = buildProvider();
    const held = gate();
    executor.setup.mockImplementation(() => held.opened);

    const booting = provider.boot();
    await vi.waitFor(() => expect(executor.setup).toHaveBeenCalledTimes(1));
    expect(
      await outcomeOf(booting, 50),
      'setup 还开着，boot 不许返回',
    ).toBe('pending');

    held.open();
    await expect(booting).resolves.toBeUndefined();
  });

  it('在途 prune 没跑完，shutdown 必须等它', async () => {
    // 守的行为：whenJobsIdle 的核心契约 —— 执行器的 shutdown 不等已在跑的 handler，
    // provider 必须补上这个等待；否则连接池会在清理仍握着连接时被销毁。
    const { provider, executor } = buildProvider();
    const held = gate();
    prune.mockImplementation(() => held.opened.then(() => 0));
    await provider.boot();
    const running = executor.jobs.get('prune')!.execute(executionContext());
    await vi.waitFor(() => expect(prune).toHaveBeenCalledTimes(1));

    const shuttingDown = provider.shutdown();
    expect(
      await outcomeOf(shuttingDown, 50),
      '门还关着，shutdown 不许提前结束',
    ).toBe('pending');

    held.open();
    await expect(running).resolves.toBeUndefined();
    expect(await outcomeOf(shuttingDown, 2000)).toBe('fulfilled');
  });

  it('两个在途 prune：先结束一个不够，要等最后一个', async () => {
    // 守的行为：runningJobs 是计数不是布尔 —— 全部在途清理结束才放行；先结束的那个
    // 不许提前把等待者放出来。
    const { provider, executor } = buildProvider();
    const first = gate();
    const second = gate();
    prune
      .mockImplementationOnce(() => first.opened.then(() => 0))
      .mockImplementationOnce(() => second.opened.then(() => 0));
    await provider.boot();
    const job = executor.jobs.get('prune')!;
    const runningFirst = job.execute(executionContext());
    const runningSecond = job.execute(executionContext());
    await vi.waitFor(() => expect(prune).toHaveBeenCalledTimes(2));

    const shuttingDown = provider.shutdown();
    expect(await outcomeOf(shuttingDown, 50)).toBe('pending');
    first.open();
    await expect(runningFirst).resolves.toBeUndefined();
    expect(
      await outcomeOf(shuttingDown, 50),
      '还有一个在途，不许提前放行',
    ).toBe('pending');

    second.open();
    await expect(runningSecond).resolves.toBeUndefined();
    expect(await outcomeOf(shuttingDown, 2000)).toBe('fulfilled');
  });

  it('空闲唤醒所有等待者，而不只是队列里的第一个', async () => {
    // 守的行为：runningJobs 归零时把所有 idleWaiters 都唤醒 —— 多个调用方同时收尾都能返回。
    const { provider, executor } = buildProvider();
    const held = gate();
    prune.mockImplementation(() => held.opened.then(() => 0));
    await provider.boot();
    const running = executor.jobs.get('prune')!.execute(executionContext());
    await vi.waitFor(() => expect(prune).toHaveBeenCalledTimes(1));

    const first = provider.shutdown();
    const second = provider.shutdown();
    expect(await outcomeOf(first, 50)).toBe('pending');
    expect(await outcomeOf(second, 50)).toBe('pending');

    held.open();
    await expect(running).resolves.toBeUndefined();
    expect(await outcomeOf(first, 2000)).toBe('fulfilled');
    expect(await outcomeOf(second, 2000)).toBe('fulfilled');
  });

  it('prune 抛错也要放行 shutdown（减法与唤醒在 finally 里）', async () => {
    // 守的行为：清理失败不吊死关机 —— 计数减法与放行必须在 finally 里，失败路径同样放行。
    const { provider, executor } = buildProvider();
    const held = gate();
    prune.mockImplementation(async () => {
      await held.opened;
      throw new Error('prune failed');
    });
    await provider.boot();
    const running = executor.jobs.get('prune')!.execute(executionContext());
    await vi.waitFor(() => expect(prune).toHaveBeenCalledTimes(1));

    const shuttingDown = provider.shutdown();
    expect(await outcomeOf(shuttingDown, 50)).toBe('pending');

    held.open();
    await expect(running).rejects.toThrow('prune failed');
    expect(await outcomeOf(shuttingDown, 2000)).toBe('fulfilled');
  });

  it('先关 schedule，再等待它已经接受的任务', async () => {
    // 守的行为：shutdown 先关调度再等在途任务 —— 开关在等待之前，关掉后不会再有新的 firing。
    const { provider, executor } = buildProvider();
    const held = gate();
    prune.mockImplementation(() => held.opened.then(() => 0));
    await provider.boot();
    expect(executor.events).toEqual(['addJob', 'setup']);
    const running = executor.jobs.get('prune')!.execute(executionContext());
    await vi.waitFor(() => expect(prune).toHaveBeenCalledTimes(1));

    const shuttingDown = provider.shutdown();
    expect(
      await outcomeOf(shuttingDown, 50),
      '任务还在跑，shutdown 不能返回',
    ).toBe('pending');
    expect(executor.events, '先关调度，再等待').toEqual([
      'addJob',
      'setup',
      'shutdown',
    ]);

    held.open();
    await running;
    await expect(shuttingDown).resolves.toBeUndefined();
  });
});

describe('boot()：收据清理任务的排程', () => {
  it('容器缺数据库时 boot 静默跳过', async () => {
    // 守的行为：早退守卫的一半 —— 没有数据库的环境（部分测试装置）不排任务、不取执行器。
    const { provider, executor, getScheduleExecutor, connectionOf } =
      buildProvider({ database: false });

    await expect(provider.boot()).resolves.toBeUndefined();
    expect(getScheduleExecutor).not.toHaveBeenCalled();
    expect(executor.calls.addJob).toBe(0);
    expect(executor.calls.setup).toBe(0);
    expect(connectionOf).not.toHaveBeenCalled();
    await expect(provider.shutdown()).resolves.toBeUndefined();
  });

  it('容器缺任务服务时 boot 静默跳过', async () => {
    // 守的行为：早退守卫的另一半 —— 没有任务服务时不碰数据库、不排任务。
    const { provider, executor, connectionOf } = buildProvider({ jobs: false });

    await expect(provider.boot()).resolves.toBeUndefined();
    expect(connectionOf).not.toHaveBeenCalled();
    expect(executor.calls.addJob).toBe(0);
    expect(executor.calls.setup).toBe(0);
    await expect(provider.shutdown()).resolves.toBeUndefined();
  });

  it('在 app.mutation-receipts 作用域排每小时一次的 prune 任务并 setup', async () => {
    // 守的行为：收据清理每小时跑一次；作用域与任务名固定；setup 被调一次
    // （setup 是否被 await，由上面那条「boot 真的等到 setup」守）。
    const { provider, executor, getScheduleExecutor } = buildProvider();

    await provider.boot();
    expect(getScheduleExecutor).toHaveBeenCalledWith('app.mutation-receipts');
    const job = executor.jobs.get('prune');
    expect(job, 'prune 任务要被排进执行器').toBeDefined();
    expect(job?.options).toEqual({ every: 60 * 60 * 1000 });
    expect(executor.calls.setup).toBe(1);
    expect(executor.events).toEqual(['addJob', 'setup']);
  });

  it('prune 的 handler 调 pruneMutationReceipts，连接来自 database.connection()', async () => {
    // 守的行为：清理跑在应用数据库的那条连接上 —— 接线正确，不是别的库。
    const { provider, executor, connectionOf, connection } = buildProvider();
    prune.mockResolvedValue(0);
    await provider.boot();

    await expect(
      executor.jobs.get('prune')!.execute(executionContext()),
    ).resolves.toBeUndefined();
    expect(prune).toHaveBeenCalledWith(connection);
    expect(connectionOf).toHaveBeenCalledTimes(1);
  });
});

describe('register()：标准写法的幂等主体', () => {
  it('把 repositoryIdempotencyToken 注册成 required: true', () => {
    // 守的行为：所有标准数据写都要求操作键（幂等收据），没有 opt-out。
    const { container, provider } = buildProvider();

    provider.register();
    const config = container.resolve(repositoryIdempotencyToken);
    expect(config.required).toBe(true);
    expect(typeof config.principal).toBe('function');
  });

  it('principal 取请求上已校验的 auth，主体是 "<appName>:<userId>"', async () => {
    // 守的行为：主体取服务端校验过的身份，带应用名前缀 —— 收据不跨应用串身份。
    const { container, provider } = buildProvider();

    provider.register();
    const config = container.resolve(repositoryIdempotencyToken);
    await expect(
      config.principal(contextOf({ user: { id: 'u1' } })),
    ).resolves.toBe('test-app:u1');
  });

  it('principal 拒绝带 credential 的会话：凭证不当幂等主体', async () => {
    // 守的行为：scoped credential 不得冒用人的身份做幂等主体；已有 auth 时不再回退查会话。
    const getSession = vi.fn();
    const { container, provider } = buildProvider({
      auth: { getSession } as unknown as Auth,
    });

    provider.register();
    const config = container.resolve(repositoryIdempotencyToken);
    await expect(
      config.principal(
        contextOf({
          user: { id: 'u1' },
          credential: { type: 'run', id: 'r1' },
        }),
      ),
    ).resolves.toBeUndefined();
    expect(getSession).not.toHaveBeenCalled();
  });

  it('请求没有 auth 时回退到 getSession，且不刷新会话、不吃 cookie 缓存', async () => {
    // 守的行为：这条身份读路径不延长会话有效期（disableRefresh），也不被 cookie 缓存
    // 糊弄（disableCookieCache）；头用请求原始的。
    const getSession = vi.fn(async () => ({ user: { id: 'u9' } }));
    const { container, provider } = buildProvider({
      auth: { getSession } as unknown as Auth,
    });

    provider.register();
    const config = container.resolve(repositoryIdempotencyToken);
    const headers = new Headers({ cookie: 'session=abc' });
    await expect(
      config.principal(contextOf(undefined, headers)),
    ).resolves.toBe('test-app:u9');
    expect(getSession).toHaveBeenCalledTimes(1);
    expect(getSession).toHaveBeenCalledWith(headers, {
      disableRefresh: true,
      disableCookieCache: true,
    });
  });

  it('回退查不到会话时 principal 为 undefined', async () => {
    // 守的行为：匿名请求没有幂等主体（收据按主体隔离，没有主体就没有收据身份）。
    const getSession = vi.fn(async () => null);
    const { container, provider } = buildProvider({
      auth: { getSession } as unknown as Auth,
    });

    provider.register();
    const config = container.resolve(repositoryIdempotencyToken);
    await expect(
      config.principal(contextOf(undefined)),
    ).resolves.toBeUndefined();
    expect(getSession).toHaveBeenCalledTimes(1);
  });
});
