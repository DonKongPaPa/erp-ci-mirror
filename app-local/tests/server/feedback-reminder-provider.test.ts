// @vitest-environment node
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Application } from '@nocobase/app-server/application';
import { jobExecutorServiceToken } from '@nocobase/app-server/jobs';
import { loggingToken } from '@nocobase/app-server/logging';
import {
  notificationServiceToken,
  type NotificationService,
} from '@nocobase/app-plugin-notification';
import { databaseManagerToken, type DatabaseManager } from '@nocobase/db';
import {
  createJobExecutorService,
  ScheduleReceiptCode,
  type JobExecutorService,
  type ScheduleExecutionContext,
  type ScheduleExecutor,
  type ScheduleJobOption,
} from '@nocobase/jobs';
import { ServiceContainer } from '@nocobase/service-provider';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  FEEDBACK_REMINDER_INTERVAL_MS,
  FEEDBACK_REMINDER_JOB_NAME,
  scanFeedbackReminders,
  type ScanFeedbackRemindersOptions,
} from '../../server/feedback-reminder.js';
import {
  FEEDBACK_REMINDER_ANCHOR,
  FEEDBACK_REMINDER_CHANNEL,
  default as FeedbackReminderProvider,
} from '../../server/providers/feedback-reminder.js';

/**
 * R-026 七天提醒的排程与收尾：注册、作用域、首火时间、handler 接线，以及
 * `ScheduleExecutor.shutdown()` 不等在途 handler 时 provider 自己补的等待。
 * 假执行器让 handler 由测试手动驱动，门让「在途」和「装配被扣住」是真的前置条件。
 * 通知通道名不手抄：从三份样例配置里读出 `type: in-app` 的配置名再比。
 */
const APP_ROOT = fileURLToPath(new URL('../..', import.meta.url));

function inAppChannelNames(configFile: string): string[] {
  const text = readFileSync(resolve(APP_ROOT, configFile), 'utf8');
  const names: string[] = [];
  const pattern =
    /(?:^|\n)[ \t]*([A-Za-z0-9_-]+):[ \t]*\n[ \t]*type:[ \t]*in-app[ \t]*(?:\n|$)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) names.push(match[1]);
  return names;
}
vi.mock('../../server/feedback-reminder.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../server/feedback-reminder.js')>();
  return { ...actual, scanFeedbackReminders: vi.fn() };
});

const scan = vi.mocked(scanFeedbackReminders);

interface CapturedJob {
  readonly name: string;
  readonly options: ScheduleJobOption;
  execute(context: ScheduleExecutionContext): Promise<void>;
}

function fakeExecutor() {
  const jobs = new Map<string, CapturedJob>();
  const events: string[] = [];
  const setup = vi.fn(async () => {
    events.push('setup');
  });
  const shutdown = vi.fn(async () => {
    events.push('shutdown');
  });
  const api: ScheduleExecutor = {
    async addJob(job) {
      events.push('addJob');
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
      return job ? { jobName: name, options: job.options, payload: undefined } : undefined;
    },
    subscribe: () => () => {},
    setup,
    shutdown,
  };
  return { api, jobs, events, setup, shutdown };
}

function buildProvider(
  options: { notifications?: boolean; logger?: boolean } = {},
) {
  const container = new ServiceContainer();
  const warn = vi.fn();
  const connection = { label: 'feedback-reminder-connection' };
  const connectionOf = vi.fn(() => connection);
  container.instance(
    databaseManagerToken,
    { connection: connectionOf } as unknown as DatabaseManager,
  );
  const executor = fakeExecutor();
  const getScheduleExecutor = vi.fn(() => executor.api);
  container.instance(
    jobExecutorServiceToken,
    { getScheduleExecutor } as unknown as JobExecutorService,
  );
  const send = vi.fn(async () => ({
    notificationId: 'n1',
    idempotencyKey: 'k1',
    deduplicated: false,
    status: 'completed' as const,
    deliveries: [],
  }));
  const getByIdempotencyKey = vi.fn(async () => undefined);
  if (options.notifications !== false) {
    container.instance(notificationServiceToken, {
      send,
      getByIdempotencyKey,
    } as unknown as NotificationService);
  }
  if (options.logger) {
    container.instance(loggingToken, {
      getLogger: () => ({ warn }),
    } as never);
  }
  const provider = new FeedbackReminderProvider({
    container,
    appName: 'test-app',
  } as unknown as Application);
  return {
    provider,
    executor,
    connection,
    connectionOf,
    getScheduleExecutor,
    send,
    getByIdempotencyKey,
    warn,
  };
}

const executionContext = (): ScheduleExecutionContext => ({
  jobId: 'test-firing',
  scheduledAt: new Date(0),
  runAt: new Date(0),
  signal: new AbortController().signal,
});

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

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

function gate() {
  let release!: () => void;
  const opened = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { opened, open: () => release() };
}

/** 从 provider 真实的 boot 里取出它交给调度器的规则，不手抄。 */
async function bootOptions(): Promise<ScheduleJobOption> {
  const { provider, executor } = buildProvider();
  await provider.boot();
  return executor.jobs.get(FEEDBACK_REMINDER_JOB_NAME)!.options;
}

/**
 * 用同一份持久化状态先后开、关两次真实内存调度器，模拟一次优雅重启；
 * 每次都从 provider 拿当前规则再 addJob，读回下一次运行时间。
 */
async function runsAcrossRestart(
  options: ScheduleJobOption,
): Promise<readonly [number | undefined, number | undefined]> {
  const dir = await mkdtemp(resolve(tmpdir(), 'r026-s5-jobs-'));
  const bootAndRead = async () => {
    const service = createJobExecutorService(undefined, {
      appName: 'r026-s5-test',
      storagePath: dir,
    });
    const executor = service.getScheduleExecutor('app.feedback-reminder');
    await executor.addJob({
      name: FEEDBACK_REMINDER_JOB_NAME,
      options,
      payload: {},
      execute: async () => {},
    });
    await executor.setup({ consume: false });
    const job = await executor.getJob(FEEDBACK_REMINDER_JOB_NAME);
    await executor.shutdown();
    await service.shutdown();
    return job?.nextRunAt?.getTime();
  };
  try {
    return [await bootAndRead(), await bootAndRead()];
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

beforeEach(() => {
  scan.mockReset();
});

describe('通知通道名：对真实样例配置校验', () => {
  it('三份样例配置里 type: in-app 的通道名就是代码用的那个，不是 channel type', () => {
    for (const file of [
      'config.example.yml',
      'config.prod.example.yml',
      'config.test.example.yml',
    ]) {
      expect(inAppChannelNames(file)).toEqual([FEEDBACK_REMINDER_CHANNEL]);
    }
    expect(FEEDBACK_REMINDER_CHANNEL).not.toBe('in-app');
    // 变异用：把常量改回 channel type，这条与上面的配置比对都会红。
  });
});

describe('boot()：七天提醒任务的排程', () => {
  it('在 app.feedback-reminder 作用域排每天一次的 scan 并 setup', async () => {
    const { provider, executor, getScheduleExecutor } = buildProvider();
    await provider.boot();

    expect(getScheduleExecutor).toHaveBeenCalledWith('app.feedback-reminder');
    expect(executor.jobs.get(FEEDBACK_REMINDER_JOB_NAME)).toBeDefined();
    expect(executor.jobs.get(FEEDBACK_REMINDER_JOB_NAME)?.options).toMatchObject({
      every: FEEDBACK_REMINDER_INTERVAL_MS,
    });
    expect(executor.setup).toHaveBeenCalledTimes(1);
    expect(executor.events).toEqual(['addJob', 'setup']);
  });

  it('模拟重启：两次 boot 的规则完全相同，下一次运行时间不被重置', async () => {
    // 可控时钟在两次启动之间前进一整天：用 Date.now() 算 startDate 的实现
    // 必然给出不同规则；固定锚点则两次一致。不靠两次调用碰巧落在同一毫秒。
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-11-26T00:00:00.000Z'));
      const first = await bootOptions();
      vi.setSystemTime(new Date('2026-11-27T00:00:00.000Z'));
      const second = await bootOptions();
      expect(second).toEqual(first);

      const [before, after] = await runsAcrossRestart(second);
      expect(before).toBeDefined();
      expect(after).toBe(before);
    } finally {
      vi.useRealTimers();
    }
  });

  it('起始时间是固定锚点，不是启动时刻，也没有立即触发', async () => {
    const options = await bootOptions();
    expect(options.startDate).toBeInstanceOf(Date);
    expect(options.startDate!.getTime()).toBe(FEEDBACK_REMINDER_ANCHOR.getTime());
    // 锚点是过去的固定钟点，不是从启动时刻算出来的量。
    expect(options.startDate!.getTime()).toBeLessThan(Date.now());
    expect(options.immediately).not.toBe(true);
  });

  it('下一次运行时刻落在北京时间凌晨两点（18:00Z）这个钟点', async () => {
    // 可控时钟放在锚点之前，此时 interval 规则的首火就是锚点本身。
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
      const [next] = await runsAcrossRestart(await bootOptions());
      const date = new Date(next!);
      expect(date.toISOString()).toBe('2026-01-01T18:00:00.000Z');
      expect(date.getUTCHours()).toBe(18);
      expect(date.getUTCMinutes()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('容器没有通知服务时不排任务，收尾也不炸', async () => {
    const { provider, executor, getScheduleExecutor } = buildProvider({
      notifications: false,
    });
    await expect(provider.boot()).resolves.toBeUndefined();
    expect(getScheduleExecutor).not.toHaveBeenCalled();
    expect(executor.events).toEqual([]);
    await expect(provider.shutdown()).resolves.toBeUndefined();
  });

  it('handler 用应用连接与通知服务调扫描函数，时钟是可读的 Date', async () => {
    const { provider, executor, connection, connectionOf, send, getByIdempotencyKey } =
      buildProvider();
    scan.mockResolvedValue(undefined);
    await provider.boot();

    await executor.jobs.get(FEEDBACK_REMINDER_JOB_NAME)!.execute(executionContext());

    expect(connectionOf).toHaveBeenCalledTimes(1);
    const options = scan.mock.calls[0][0] as ScanFeedbackRemindersOptions;
    expect(options.connection).toBe(connection);
    expect(options.now).toBeInstanceOf(Date);

    const notification = {
      idempotencyKey: 'feedback-reminder:f1:1',
      to: 'user-1',
      title: '反馈单待处理提醒',
      body: '你于 2026-11-18 提交的反馈单超过七天仍未处理',
      target: { type: 'route' as const, path: '/feedbacks' },
    };
    await options.notifier.send(notification);
    expect(send).toHaveBeenCalledWith({
      idempotencyKey: notification.idempotencyKey,
      source: { type: 'feedback-reminder' },
      messages: {
        [FEEDBACK_REMINDER_CHANNEL]: {
          to: 'user-1',
          title: notification.title,
          body: notification.body,
          target: notification.target,
        },
      },
    });

    getByIdempotencyKey.mockResolvedValueOnce({
      status: 'completed',
      updatedAt: '2026-11-25T00:00:00.000Z',
    } as never);
    await expect(
      options.notifier.getByIdempotencyKey(notification.idempotencyKey),
    ).resolves.toEqual({
      status: 'completed',
      updatedAt: '2026-11-25T00:00:00.000Z',
    });
  });

  it('日志走 loggingToken.getLogger，没有 logger 时才回退 console.warn', async () => {
    const withLogger = buildProvider({ logger: true });
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      scan.mockImplementation(async (options) => {
        options.log?.('feedback-reminder: 试满五回');
      });
      await withLogger.provider.boot();
      await withLogger.executor
        .jobs.get(FEEDBACK_REMINDER_JOB_NAME)!
        .execute(executionContext());
      expect(withLogger.warn).toHaveBeenCalledWith(
        { event: 'feedback-reminder' },
        'feedback-reminder: 试满五回',
      );
      expect(consoleWarn).not.toHaveBeenCalled();

      scan.mockClear();
      const withoutLogger = buildProvider();
      await withoutLogger.provider.boot();
      await withoutLogger.executor
        .jobs.get(FEEDBACK_REMINDER_JOB_NAME)!
        .execute(executionContext());
      expect(consoleWarn).toHaveBeenCalledWith('feedback-reminder: 试满五回');
    } finally {
      consoleWarn.mockRestore();
    }
  });
});

describe('shutdown()：等在途扫描结束', () => {
  it('扫描还在跑时 shutdown 不提前返回，先关调度再等', async () => {
    const { provider, executor } = buildProvider();
    const held = gate();
    scan.mockImplementation(() => held.opened);
    await provider.boot();
    expect(executor.events).toEqual(['addJob', 'setup']);
    const running = executor.jobs
      .get(FEEDBACK_REMINDER_JOB_NAME)!
      .execute(executionContext());
    await vi.waitFor(() => expect(scan).toHaveBeenCalledTimes(1));

    const shuttingDown = provider.shutdown();
    expect(await outcomeOf(shuttingDown, 50)).toBe('pending');
    expect(executor.events).toEqual(['addJob', 'setup', 'shutdown']);

    held.open();
    await expect(running).resolves.toBeUndefined();
    expect(await outcomeOf(shuttingDown, 2000)).toBe('fulfilled');
  });

  it('扫描抛错也放行 shutdown（减法在 finally 里）', async () => {
    const { provider, executor } = buildProvider();
    const held = gate();
    scan.mockImplementation(async () => {
      await held.opened;
      throw new Error('scan failed');
    });
    await provider.boot();
    const running = executor.jobs
      .get(FEEDBACK_REMINDER_JOB_NAME)!
      .execute(executionContext());
    await vi.waitFor(() => expect(scan).toHaveBeenCalledTimes(1));

    const shuttingDown = provider.shutdown();
    expect(await outcomeOf(shuttingDown, 50)).toBe('pending');

    held.open();
    await expect(running).rejects.toThrow('scan failed');
    expect(await outcomeOf(shuttingDown, 2000)).toBe('fulfilled');
  });

  it('两轮扫描同时在途，要等最后一个结束', async () => {
    const { provider, executor } = buildProvider();
    const first = gate();
    const second = gate();
    scan
      .mockImplementationOnce(() => first.opened)
      .mockImplementationOnce(() => second.opened);
    await provider.boot();
    const job = executor.jobs.get(FEEDBACK_REMINDER_JOB_NAME)!;
    const runningFirst = job.execute(executionContext());
    const runningSecond = job.execute(executionContext());
    await vi.waitFor(() => expect(scan).toHaveBeenCalledTimes(2));

    const shuttingDown = provider.shutdown();
    expect(await outcomeOf(shuttingDown, 50)).toBe('pending');
    first.open();
    await expect(runningFirst).resolves.toBeUndefined();
    expect(await outcomeOf(shuttingDown, 50)).toBe('pending');
    second.open();
    await expect(runningSecond).resolves.toBeUndefined();
    expect(await outcomeOf(shuttingDown, 2000)).toBe('fulfilled');
  });

  it('在途扫描超过等待上限就记日志放行，不无限拖住关闭', async () => {
    const { provider, executor, warn } = buildProvider({ logger: true });
    const held = gate();
    scan.mockImplementation(() => held.opened);
    await provider.boot();
    const running = executor.jobs
      .get(FEEDBACK_REMINDER_JOB_NAME)!
      .execute(executionContext());
    await vi.waitFor(() => expect(scan).toHaveBeenCalledTimes(1));
    // 用短上限验同一条超时分支，不真的等 60 秒。
    (provider as unknown as { idleTimeoutMs: number }).idleTimeoutMs = 300;

    try {
      const shuttingDown = provider.shutdown();
      expect(await outcomeOf(shuttingDown, 50)).toBe('pending');
      expect(await outcomeOf(shuttingDown, 2000)).toBe('fulfilled');
      expect(warn).toHaveBeenCalledWith(
        { event: 'feedback-reminder' },
        expect.stringContaining('300ms'),
      );
    } finally {
      held.open();
      await expect(running).resolves.toBeUndefined();
    }
  });
});
