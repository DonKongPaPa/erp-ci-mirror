// @vitest-environment node
import { randomUUID } from 'node:crypto';

import {
  DEFAULT_ADMIN_CREDENTIALS,
  signIn,
  type TestSession,
} from '@nocobase/app-plugin-authentication/testing';
import {
  notificationServiceToken,
  type NotificationService,
} from '@nocobase/app-plugin-notification/server';
import type { Application } from '@nocobase/app-server/application';
import { expect, vi } from 'vitest';

import { createAppTest } from '../helpers/test-app.js';
import { createStandaloneServer } from '../../server/standalone.js';
import { lifecycleRuntimeToken } from '../../server/providers/lifecycles.js';
import {
  APPROVAL_NOTIFICATION_KINDS,
  idempotencyKeyOf,
  type ApprovalNotificationEvent,
} from '../../server/approval-notifications.js';

/**
 * R-017 M4：四个时点各发一次、重放不重发、回滚不留通知。
 * 通知服务全程是假实现（vi.spyOn），不发真实通知；数据在真 Postgres 的应用里。
 */
const test = createAppTest({
  scope: 'test',
  createServer: createStandaloneServer,
  config: {
    app: { publicOrigin: 'http://localhost' },
    auth: { secret: 'test-auth-secret-at-least-32-characters' },
  },
});

const PASSWORD = 'R017-notify-test-123!';
const TIMEOUT = 30_000;
const marker = () => randomUUID().replaceAll('-', '').slice(0, 10);

const write = (body: unknown, method = 'POST'): RequestInit => ({
  method,
  headers: {
    'content-type': 'application/json',
    origin: 'http://localhost',
    'Idempotency-Key': `${Date.now()}.${randomUUID()}`,
  },
  body: JSON.stringify(body),
});

async function expectStatus(response: Response, status: number) {
  const text = await response.text();
  expect(response.status).toBe(status);
  expect(typeof text).toBe('string');
  return JSON.parse(text) as { data?: Record<string, unknown> };
}

async function makeUser(admin: TestSession) {
  const suffix = marker();
  const username = `r017n${suffix}`;
  const created = await expectStatus(
    await admin.fetch(
      '/users',
      write({
        name: `审批${suffix}`,
        username,
        email: `${username}@example.test`,
        password: PASSWORD,
        roleScopes: { app: ['staff'] },
      }),
    ),
    201,
  );
  const id = String(created.data?.id ?? '');
  expect(id).not.toBe('');
  return { id, username };
}

async function signedIn(
  testApp: Parameters<typeof signIn>[0],
  username: string,
): Promise<TestSession> {
  return signIn(testApp, { username, password: PASSWORD });
}

function fakeSender(app: Application) {
  const notifications = app.container.resolve(notificationServiceToken) as NotificationService;
  const sent: Array<{ key: string; input: Record<string, unknown> }> = [];
  const seen = new Map<string, unknown>();
  const spy = vi.spyOn(notifications, 'send').mockImplementation(async (input) => {
    const key = String((input as { idempotencyKey?: string }).idempotencyKey ?? '');
    if (seen.has(key)) {
      return { ...(seen.get(key) as object), deduplicated: true } as never;
    }
    const result = {
      notificationId: randomUUID(),
      idempotencyKey: key,
      deduplicated: false,
      status: 'completed',
      deliveries: [],
    };
    seen.set(key, result);
    sent.push({ key, input: input as unknown as Record<string, unknown> });
    return result as never;
  });
  return { sent, spy };
}

function approvalSends(sent: readonly { key: string }[]) {
  return sent.filter((entry) => entry.key.startsWith('approval:'));
}

test('四个时点各收到一次，内容没有邮箱与单据正文', async ({ testApp, app }) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const applicant = await makeUser(admin);
  const approver = await makeUser(admin);
  const applicantSession = await signedIn(testApp, applicant.username);
  const approverSession = await signedIn(testApp, approver.username);
  const { sent, spy } = fakeSender(app);
  try {
    for (const kind of ['approve', 'reject', 'sendBack']) {
      const before = approvalSends(sent).length;
      const created = await expectStatus(
        await applicantSession.fetch(
          '/approvals',
          write({
            collectionName: 'leaveRequests',
            dataKey: `leave-${marker()}`,
            workflowKey: 'leave',
            data: { amount: 10, approvers: [approver.id] },
            submit: true,
          }),
        ),
        201,
      );
      const id = String(created.data?.id ?? '');
      expect(id).not.toBe('');
      expect(approvalSends(sent).length).toBe(before + 1);
      expect(approvalSends(sent).at(-1)?.key).toContain(':submit:');

      const tasks = await expectStatus(
        await approverSession.fetch('/approvals/tasks?scope=pending', { method: 'GET' }),
        200,
      );
      const list = (tasks.data ?? []) as Array<Record<string, unknown>>;
      const task = list.find((row) => String(row.approvalId) === id);
      expect(task).toBeDefined();
      const path = `/approvals/tasks/${String(task?.id)}/${kind === 'sendBack' ? 'return' : kind}`;
      await expectStatus(
        await approverSession.fetch(path, write({ comment: kind })),
        200,
      );
      expect(approvalSends(sent).length).toBe(before + 2);
      const last = approvalSends(sent).at(-1)!;
      expect(last.key).toContain(`:${kind}:`);
      const inbox = (last.input as { messages?: Record<string, { to: string[]; body: string }> })
        .messages?.inbox;
      expect(inbox?.to).toEqual([applicant.id]);
      expect(inbox?.body).not.toContain('@example.test');
      expect(inbox?.body).not.toContain('同意');
      expect(inbox?.body).toContain('leave');
      expect(inbox?.body).toContain(id);
    }
  } finally {
    spy.mockRestore();
  }
}, TIMEOUT);

test('同一转移的重放不重发；失败转移不留通知', async ({ testApp, app, connection }) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const applicant = await makeUser(admin);
  const approver = await makeUser(admin);
  const applicantSession = await signedIn(testApp, applicant.username);
  const { sent, spy } = fakeSender(app);
  try {
    const created = await expectStatus(
      await applicantSession.fetch(
        '/approvals',
        write({
          collectionName: 'leaveRequests',
          dataKey: `leave-${marker()}`,
          workflowKey: 'leave',
          data: { amount: 10, approvers: [approver.id] },
          submit: false,
        }),
      ),
      201,
    );
    const id = String(created.data?.id ?? '');
    // 草稿没有轮次；重放测试自己建一轮和一个待处理任务，才有收件人。
    await connection.query
      .insertInto('approvalRounds')
      .values({ id: `round-${id}`, approvalId: id, round: 1, status: 'processing', startedAt: new Date(), snapshot: {} })
      .execute();
    await connection.query
      .insertInto('approvalRecords')
      .values({
        id: `task-${id}`,
        roundId: `round-${id}`,
        nodeKey: 'manager',
        assigneeId: approver.id,
        status: 'pending',
        seq: 1,
        origin: 'normal',
      })
      .execute();
    const runtime = app.container.resolve(lifecycleRuntimeToken);
    const event = (
      kind: ApprovalNotificationEvent['kind'],
      version: number,
    ): ApprovalNotificationEvent => ({
      kind,
      approvalId: id,
      workflowKey: 'leave',
      applicantId: applicant.id,
      version,
    });
    expect(idempotencyKeyOf(event('submit', 0))).toBe(`approval:submit:${id}:0`);
    // 同一张单同一类事件的版本不同，必须是不同的键，否则后续轮次会被去重掉。
    expect(idempotencyKeyOf(event('submit', 1))).not.toBe(
      idempotencyKeyOf(event('submit', 2)),
    );
    expect(APPROVAL_NOTIFICATION_KINDS).toContain('reminder');

    const before = approvalSends(sent).length;
    await runtime.fire('approvals', id, 'submit', {
      actor: { id: applicant.id },
      requestId: 'r017-replay-1',
    });
    expect(approvalSends(sent).length).toBe(before + 1);
    await runtime.fire('approvals', id, 'submit', {
      actor: { id: applicant.id },
      requestId: 'r017-replay-1',
    });
    expect(approvalSends(sent).length).toBe(before + 1);

    // 真回滚：事务里走一次合法转移，再抛错让整笔回滚。提交后才跑的通知不能留下。
    await expect(
      connection.transaction(async (tx) => {
        await runtime.fire('approvals', id, 'withdraw', {
          actor: { id: applicant.id },
          transaction: tx,
        });
        throw new Error('force rollback');
      }),
    ).rejects.toThrow('force rollback');
    const rolledBack = await connection.query
      .selectFrom('approvals')
      .select(['status'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    expect(rolledBack.status).toBe('submitted');
    expect(approvalSends(sent).length).toBe(before + 1);
  } finally {
    spy.mockRestore();
  }
}, TIMEOUT);

test('流程级超时：lifecycle 触发器催办一次，状态不变', async ({ testApp, app, connection }) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const applicant = await makeUser(admin);
  const approver = await makeUser(admin);
  const applicantSession = await signedIn(testApp, applicant.username);
  const { sent, spy } = fakeSender(app);
  try {
    const approvals = app.container.resolve(lifecycleRuntimeToken);
    expect(approvals).toBeDefined();
    const created = await expectStatus(
      await applicantSession.fetch(
        '/approvals',
        write({
          collectionName: 'leaveRequests',
          dataKey: `leave-${marker()}`,
          workflowKey: 'leave',
          data: { amount: 10, approvers: [approver.id] },
          submit: true,
        }),
      ),
      201,
    );
    const id = String(created.data?.id ?? '');
    const before = approvalSends(sent).length;
    // 把状态变化时间拨到两天前，触发器按停留时长找单。
    await connection.query
      .updateTable('approvals')
      .set({ statusChangedAt: new Date('2026-11-26T00:00:00.000Z') })
      .where('id', '=', id)
      .execute();
    const swept = await approvals.runTriggers();
    expect(swept).toBeGreaterThan(0);
    expect(approvalSends(sent).length).toBe(before + 1);
    const last = approvalSends(sent).at(-1)!;
    expect(last.key).toContain(':reminder:');
    const row = await connection.query
      .selectFrom('approvals')
      .select(['status'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    expect(row.status).toBe('submitted');
    await approvals.runTriggers();
    expect(approvalSends(sent).length).toBe(before + 1);
  } finally {
    spy.mockRestore();
  }
}, TIMEOUT);
