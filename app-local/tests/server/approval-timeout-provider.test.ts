// @vitest-environment node
import type { Application } from '@nocobase/app-server/application';
import { jobExecutorServiceToken } from '@nocobase/app-server/jobs';
import { loggingToken } from '@nocobase/app-server/logging';
import { notificationServiceToken } from '@nocobase/app-plugin-notification/server';
import { databaseManagerToken, type DatabaseManager } from '@nocobase/db';
import {
  ScheduleReceiptCode,
  type JobExecutorService,
  type ScheduleExecutionContext,
  type ScheduleExecutor,
  type ScheduleJobOption,
} from '@nocobase/jobs';
import { ServiceContainer } from '@nocobase/service-provider';
import { describe, expect, it, vi } from 'vitest';

import { approvalNotifierToken } from '../../server/approval-notifications.js';
import {
  APPROVAL_REMINDER_JOB_NAME,
  scanApprovalTimeouts,
} from '../../server/approval-timeout.js';
import ApprovalTimeoutProvider from '../../server/providers/approval-timeout.js';
import { lifecycleRuntimeToken } from '../../server/providers/lifecycles.js';

/**
 * R-017 M4：定时扫单对「没有 approvals 集合」的应用安静跳过。
 * 假执行器把 provider 注册的处理函数交给测试手动触发，跑的是真实的 boot 与 handler 接线。
 */
vi.mock('../../server/approval-timeout.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../server/approval-timeout.js')>();
  return { ...actual, default: actual.default, scanApprovalTimeouts: vi.fn(async () => 0) };
});

const scan = vi.mocked(scanApprovalTimeouts);

interface CapturedJob {
  readonly name: string;
  readonly options: ScheduleJobOption;
  execute(context: ScheduleExecutionContext): Promise<void>;
}

function fakeExecutor() {
  const jobs = new Map<string, CapturedJob>();
  const api: ScheduleExecutor = {
    async addJob(job) {
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
        ? { jobName: name, options: job.options, payload: undefined }
        : undefined;
    },
    subscribe: () => () => {},
    setup: async () => {},
    shutdown: async () => {},
  };
  return { api, jobs };
}

function buildProvider(withApprovals: boolean) {
  const container = new ServiceContainer();
  const warn = vi.fn();
  const collectionsGet = vi.fn(async (_name: string) =>
    withApprovals ? { name: 'approvals' } : undefined,
  );
  const connection = { collections: { get: collectionsGet } };
  container.instance(
    databaseManagerToken,
    { connection: () => connection } as unknown as DatabaseManager,
  );
  container.instance(notificationServiceToken, {} as never);
  container.instance(approvalNotifierToken, { notify: vi.fn() } as never);
  const runtime = {
    runTriggers: vi.fn(async () => {}),
    prune: vi.fn(async () => {}),
  };
  container.instance(lifecycleRuntimeToken, runtime as never);
  container.instance(loggingToken, { getLogger: () => ({ warn }) } as never);
  const executor = fakeExecutor();
  container.instance(
    jobExecutorServiceToken,
    { getScheduleExecutor: () => executor.api } as unknown as JobExecutorService,
  );
  const provider = new ApprovalTimeoutProvider({
    container,
    appName: 'approval-timeout-provider-test',
  } as unknown as Application);
  return { provider, executor, collectionsGet, runtime, warn };
}

const executionContext = (): ScheduleExecutionContext => ({
  jobId: 'test-firing',
  scheduledAt: new Date(0),
  runAt: new Date(0),
  signal: new AbortController().signal,
});

describe('approval timeout provider scan', () => {
  it('skips the whole sweep quietly when the app has no approvals collection', async () => {
    const { provider, executor, collectionsGet, runtime, warn } =
      buildProvider(false);
    scan.mockClear();
    await provider.boot();

    const job = executor.jobs.get(APPROVAL_REMINDER_JOB_NAME)!;
    expect(job).toBeDefined();

    await expect(job.execute(executionContext())).resolves.toBeUndefined();
    expect(collectionsGet).toHaveBeenCalledWith('approvals');
    expect(scan).not.toHaveBeenCalled();
    expect(runtime.runTriggers).not.toHaveBeenCalled();
    expect(runtime.prune).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('runs the sweep as usual when the approvals collection is present', async () => {
    const { provider, executor, runtime, warn } = buildProvider(true);
    scan.mockClear();
    await provider.boot();

    const job = executor.jobs.get(APPROVAL_REMINDER_JOB_NAME)!;
    await expect(job.execute(executionContext())).resolves.toBeUndefined();
    expect(scan).toHaveBeenCalledOnce();
    expect(runtime.runTriggers).toHaveBeenCalledOnce();
    expect(runtime.prune).toHaveBeenCalledOnce();
    expect(warn).not.toHaveBeenCalled();
  });
});
