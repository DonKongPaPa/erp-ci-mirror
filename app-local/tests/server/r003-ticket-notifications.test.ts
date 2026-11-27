import { randomUUID } from 'node:crypto';

import {
  DEFAULT_ADMIN_CREDENTIALS,
  signIn,
  type TestSession,
} from '@nocobase/app-plugin-authentication/testing';
import {
  notificationServiceToken,
  notificationTemplateRegistryToken,
  type NotificationService,
} from '@nocobase/app-plugin-notification/server';
import type { DatabaseConnection } from '@nocobase/db';
import { createAppTest } from '../helpers/test-app.js';
import { describe, expect, vi } from 'vitest';

import { createStandaloneServer } from '../../server/standalone.js';
import {
  createTicketNotifier,
  idempotencyKeyOf,
  recipientsOf,
  renderTicketNotification,
  ticketNotificationTemplates,
  ticketNotifierToken,
  TICKET_NOTIFICATION_KINDS,
  type TicketNotificationEvent,
  type TicketNotifier,
} from '../../server/ticket-notifications.js';

/**
 * R-003 S8：五张通知模板（验收 14）。
 *
 * 收件人、幂等键、文案都是纯函数，先用假通知器钉死；事务边界与真实提交后的发送
 * 在真 Postgres 上用应用测：失败流转不发送、成功流转发送、同一幂等键重放不重发。
 * 发送服务全程是 vi.spyOn 假实现，不发真实通知。
 */
const test = createAppTest({
  scope: 'test',
  createServer: createStandaloneServer,
  config: {
    app: { publicOrigin: 'http://localhost' },
    auth: { secret: 'test-auth-secret-at-least-32-characters' },
  },
});

const PASSWORD = 'R003-notify-123!';
const CUSTOMER_TEXT = '客户原始正文-绝不能进通知-9d1c';

const json = (body: unknown, method = 'POST') => ({
  method,
  headers: {
    'content-type': 'application/json',
    origin: 'http://localhost',
    'Idempotency-Key': `${Date.now()}.${randomUUID()}`,
  },
  body: JSON.stringify(body),
});

const expectJson = async (response: Response, status: number): Promise<any> => {
  const text = await response.text();
  expect(response.status, `${text}`).toBe(status);
  return JSON.parse(text);
};

const event = (
  kind: TicketNotificationEvent['kind'],
  overrides: Partial<TicketNotificationEvent> = {},
): TicketNotificationEvent => ({
  kind,
  ticketId: 'ticket-1',
  code: 'FQC-12345678',
  state: 'in_progress',
  version: 3,
  departmentId: 'dept-1',
  assigneeId: 'assignee-1',
  previousAssigneeId: 'previous-1',
  createdBy: 'creator-1',
  ...overrides,
});

const manager = 'manager-1';

const fakeSender = (app: any) => {
    const notifications = app.container.resolve(notificationServiceToken) as any;
    const sent: any[] = [];
    const seen = new Map<string, any>();
    const spy = vi
      .spyOn(notifications, 'send')
      .mockImplementation(async (input: any) => {
        if (seen.has(input.idempotencyKey)) {
          return { ...seen.get(input.idempotencyKey), deduplicated: true };
        }
        sent.push(input);
        const result = {
          notificationId: randomUUID(),
          idempotencyKey: input.idempotencyKey,
          deduplicated: false,
          status: 'completed',
          deliveries: [],
        };
        seen.set(input.idempotencyKey, result);
        return result;
      });
    return { sent, spy };
  };

const makeUser = async (
  admin: TestSession,
  name: string,
  roleScopes: Record<string, string[]> = { app: ['quality_manager'] },
) =>
  (
    await expectJson(
      await admin.fetch(
        '/users',
        json({
          name: `姓名-${randomUUID().slice(0, 6)}`,
          username: name,
          email: `${name}@example.test`,
          password: PASSWORD,
          roleScopes,
        }),
      ),
      201,
    )
  ).data as { id: string; username: string };

const makeDepartment = async (admin: TestSession, suffix: string) =>
  (
    await expectJson(
      await admin.fetch(
        '/departments',
        json({ title: `部门-${suffix}`, code: `N${randomUUID().slice(0, 8)}` }),
      ),
      201,
    )
  ).data as { id: string };

const insertTicket = async (
  connection: DatabaseConnection,
  overrides: Partial<Record<string, unknown>> = {},
) => {
  const now = new Date();
  const values = {
    id: randomUUID(),
    code: `T-${randomUUID().slice(0, 8)}`,
    title: '尺寸超差',
    description: CUSTOMER_TEXT,
    sourceMessageId: null,
    screeningId: null,
    category: 'dimension',
    severity: 'major',
    departmentId: 'dept-a',
    createdBy: 'creator',
    assigneeId: null,
    state: 'open',
    closedAt: null,
    createdAt: now,
    updatedAt: now,
    statusChangedAt: null,
    lifecycleVersion: 0,
    lifecycleDefinition: 'fqcTickets',
    reopenCount: 0,
    dueAt: null,
    ownerDepartment: null,
    ...overrides,
  };
  await connection.repository('fqcTickets').createOne({ values });
  return values;
};

/** 假通知服务：vi.spyOn 替换 send，记录请求并按幂等键去重，不投递真实通知。 */

describe('R-003 S8 纯函数', () => {
  test('五张模板各自的收件人', () => {
    expect(recipientsOf(event('dispatch'), manager)).toEqual([
      manager,
      'assignee-1',
    ]);
    expect(recipientsOf(event('reassign'), manager)).toEqual([
      manager,
      'assignee-1',
      'previous-1',
    ]);
    expect(recipientsOf(event('resolve'), manager)).toEqual(['creator-1']);
    expect(recipientsOf(event('close'), manager)).toEqual(['assignee-1']);
    expect(recipientsOf(event('reopen'), manager)).toEqual([
      'assignee-1',
      manager,
    ]);
    // 没有负责人、没有经办人时收件人不出现空串，也不重复。
    expect(
      recipientsOf(
        event('dispatch', {
          assigneeId: null,
        }),
        null,
      ),
    ).toEqual([]);
    expect(
      recipientsOf(event('reassign', { assigneeId: 'manager-1' }), manager),
    ).toEqual([manager, 'previous-1']);
  });

  test('幂等键按工单 + 事件 + 版本稳定，重放不变、换版本就变', () => {
    const first = idempotencyKeyOf(event('resolve'));
    expect(idempotencyKeyOf(event('resolve'))).toBe(first);
    expect(idempotencyKeyOf(event('resolve', { version: 4 }))).not.toBe(first);
    expect(idempotencyKeyOf(event('close'))).not.toBe(first);
  });

  test('文案走词条；中英文各一份，正文只有编号与状态', () => {
    const t = ((key: string, options?: Record<string, unknown>) =>
      `${key}:${options?.code ?? ''}:${options?.state ?? ''}`) as never;
    const content = renderTicketNotification(t, 'close', 'FQC-1', 'closed');
    expect(content.title).toContain('ticketNotifications.close.title');
    expect(content.body).toContain('FQC-1');
    expect(content.body).toContain('closed');
    expect(JSON.stringify(content)).not.toContain(CUSTOMER_TEXT);
    expect(ticketNotificationTemplates({} as never, undefined)).toHaveLength(5);
    for (const template of ticketNotificationTemplates({} as never, undefined)) {
      expect(TICKET_NOTIFICATION_KINDS).toContain(
        template.id.replace('fqc.ticket.', ''),
      );
      expect(template.locales).toEqual(['zh-CN', 'en-US']);
      expect(template.name).toMatchObject({ ns: 'app-local', key: expect.any(String) });
      expect(template.channels()[0].name).toBe('inbox');
    }
  });

  test('假通知服务：同一幂等键重放只记一次发送，正文不带客户原文', async () => {
    const sent: any[] = [];
    const seen = new Map<string, any>();
    const fake = {
      async send(input: any) {
        if (seen.has(input.idempotencyKey)) {
          return { ...seen.get(input.idempotencyKey), deduplicated: true };
        }
        sent.push(input);
        const result = {
          notificationId: randomUUID(),
          idempotencyKey: input.idempotencyKey,
          deduplicated: false,
          status: 'completed',
          deliveries: [],
        };
        seen.set(input.idempotencyKey, result);
        return result;
      },
    } as unknown as NotificationService;
    const i18n = {
      getDefaultLocale: () => 'zh-CN',
      ensureLocaleLoaded: async () => {},
      getFixedT: () => ((key: string, options?: Record<string, unknown>) =>
        `${key}:${options?.code ?? ''}:${options?.state ?? ''}`) as never,
    } as never;
    const notifier = createTicketNotifier({
      notifications: fake,
      i18n,
      managerOf: async () => manager,
      activeIds: async (ids) => new Set(ids),
    });
    const first = event('dispatch');
    expect(await notifier.notify(first)).toBe(true);
    expect(await notifier.notify(first)).toBe(false);
    expect(sent).toHaveLength(1);
    expect(JSON.stringify(sent[0])).not.toContain(CUSTOMER_TEXT);
    expect(sent[0].messages.inbox.to).toEqual([manager, 'assignee-1']);
  });
});

describe('R-003 S8 应用内真 Postgres 效果', () => {
  test('五张模板注册进通知目录，通道是 inbox', async ({ app, testApp }) => {
    const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
    const list = await expectJson(await admin.fetch('/notifications/templates'), 200);
    for (const kind of TICKET_NOTIFICATION_KINDS) {
      const template = list.data.find((row: any) => row.id === `fqc.ticket.${kind}`);
      expect(template).toBeDefined();
      expect(template.channels[0].name).toBe('inbox');
      expect(template.locales).toEqual(['zh-CN', 'en-US']);
    }
    expect(app.container.resolve(notificationTemplateRegistryToken)).toBeTruthy();
  });

  test('回滚不发通知；成功解决发一条给确认人；重放同键不重发', async ({
    app,
    testApp,
    connection,
  }) => {
    const { sent, spy } = fakeSender(app);
    try {
      const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
      const creator = await makeUser(admin, uniqName('creator'));
      const ticket = await insertTicket(connection, {
        state: 'in_progress',
        createdBy: creator.id,
        assigneeId: null,
      });
      const inspector = await makeUser(admin, uniqName('inspector'));
      const session = await signIn(testApp, {
        username: inspector.username,
        password: PASSWORD,
      });
      const fire = (body: unknown) =>
        session.fetch(`/quality/tickets/${ticket.id}/transitions`, json(body));

      // 校验失败：事务回滚，没有通知。
      const bad = await fire({ name: 'resolve', input: {} });
      expect(bad.status).toBe(400);
      expect(sent).toHaveLength(0);

      const ok = await fire({
        name: 'resolve',
        input: { resolution: '已经调整公差' },
      });
      expect(ok.status).toBe(200);
      expect(sent).toHaveLength(1);
      expect(sent[0].messages.inbox.to).toEqual([creator.id]);
      expect(JSON.stringify(sent[0])).not.toContain(CUSTOMER_TEXT);
      const key = sent[0].idempotencyKey;
      expect(key).toBe(
        `fqc.ticket:resolve:${ticket.id}:${Number(ticket.lifecycleVersion) + 1}`,
      );

      // 同一幂等键重放：假通知服务按 key 去重，不会有第二条投递。
      const notifier = app.container.resolve(ticketNotifierToken) as TicketNotifier;
      const replay: TicketNotificationEvent = {
        kind: 'resolve',
        ticketId: ticket.id,
        code: String(ticket.code),
        state: 'resolved',
        version: Number(ticket.lifecycleVersion) + 1,
        departmentId: 'dept-a',
        assigneeId: creator.id,
        previousAssigneeId: null,
        createdBy: creator.id,
      };
      expect(await notifier.notify(replay)).toBe(false);
      expect(await notifier.notify(replay)).toBe(false);
      expect(sent).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });

  test('转派 / 解决 / 关闭 / 重开各自的通知与收件人', async ({
    app,
    testApp,
    connection,
  }) => {
    const { sent, spy } = fakeSender(app);
    try {
      const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
      const dept = await makeDepartment(admin, 'lifecycle');
      const head = await makeUser(admin, uniqName('head'));
      const first = await makeUser(admin, uniqName('first'));
      const handler = await makeUser(admin, uniqName('handler'));
      const confirmer = await makeUser(admin, uniqName('confirmer'));
      await expectJson(
        await admin.fetch(
          `/departments/${dept.id}/members`,
          json({ userIds: [head.id, first.id, handler.id] }),
        ),
        200,
      );
      await expectJson(
        await admin.fetch(
          `/departments/${dept.id}`,
          json({ managerId: head.id }, 'PATCH'),
        ),
        200,
      );
      const ticket = await insertTicket(connection, {
        departmentId: dept.id,
        createdBy: confirmer.id,
        assigneeId: null,
      });
      const session = await signIn(testApp, {
        username: handler.username,
        password: PASSWORD,
      });
      const fire = (name: string, input?: Record<string, unknown>) =>
        session.fetch(
          `/quality/tickets/${ticket.id}/transitions`,
          json({ name, input }),
        );

      expect((await fire('accept', { assigneeId: first.id })).status).toBe(200);
      expect(sent).toHaveLength(0);
      expect(
        (
          await fire('reassign', {
            departmentId: dept.id,
            assigneeId: handler.id,
          })
        ).status,
      ).toBe(200);
      expect((await fire('resolve', { resolution: '换料' })).status).toBe(200);
      expect((await fire('close')).status).toBe(200);
      expect((await fire('reopen', { reason: '又出现了' })).status).toBe(200);

      const byKind = (kind: string) =>
        sent.filter((input) => input.idempotencyKey.includes(`:${kind}:`));
      expect(byKind('reassign')).toHaveLength(1);
      expect(byKind('reassign')[0].messages.inbox.to).toEqual([
        head.id,
        handler.id,
        first.id,
      ]);
      expect(byKind('resolve')).toHaveLength(1);
      expect(byKind('resolve')[0].messages.inbox.to).toEqual([confirmer.id]);
      expect(byKind('close')).toHaveLength(1);
      expect(byKind('close')[0].messages.inbox.to).toEqual([handler.id]);
      expect(byKind('reopen')).toHaveLength(1);
      expect(byKind('reopen')[0].messages.inbox.to).toEqual([
        handler.id,
        head.id,
      ]);
      expect(new Set(sent.map((input) => input.idempotencyKey)).size).toBe(4);
      for (const input of sent) {
        expect(JSON.stringify(input)).not.toContain(CUSTOMER_TEXT);
      }
    } finally {
      spy.mockRestore();
    }
  });

  test('派单通知在事务提交之后发给责任部门负责人与经办人', async ({
    app,
    testApp,
    connection,
  }) => {
    const { sent, spy } = fakeSender(app);
    try {
      const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
      const dept = await makeDepartment(admin, 'dispatch');
      const managerUser = await makeUser(admin, uniqName('depthead'));
      const assignee = await makeUser(admin, uniqName('handler'));
      await expectJson(
        await admin.fetch(
          `/departments/${dept.id}/members`,
          json({ userIds: [managerUser.id, assignee.id] }),
        ),
        200,
      );
      await expectJson(
        await admin.fetch(
          `/departments/${dept.id}`,
          json({ managerId: managerUser.id }, 'PATCH'),
        ),
        200,
      );
      await connection.repository('fqcRoutingRules').createOne({
        values: {
          category: 'dimension',
          departmentId: dept.id,
          updatedAt: new Date(),
          updatedBy: 'seed',
        },
      });
      const now = new Date();
      const screeningId = randomUUID();
      await connection.repository('fqcScreenings').createOne({
        values: {
          id: screeningId,
          messageId: randomUUID(),
          category: 'dimension',
          severity: 'major',
          suggestedOwner: 'not-a-department',
          summary: '尺寸超差',
          evidence: [],
          outcome: 'needs-review',
          reviewId: null,
          createdAt: now,
          updatedAt: now,
        },
      });
      const inspector = await makeUser(admin, uniqName('dispatcher'));
      const session = await signIn(testApp, {
        username: inspector.username,
        password: PASSWORD,
      });
      const response = await session.fetch(
        `/quality/screenings/${screeningId}/dispatch`,
        json({ assigneeId: assignee.id }),
      );
      const body = await expectJson(response, 201);
      expect(body.data.state).toBe('open');
      expect(sent).toHaveLength(1);
      expect(sent[0].idempotencyKey).toBe(
        `fqc.ticket:dispatch:${body.data.id}:0`,
      );
      expect(sent[0].messages).toHaveProperty('inbox');
      expect(sent[0].messages.inbox.to).toEqual([managerUser.id, assignee.id]);
      expect(JSON.stringify(sent[0])).not.toContain(CUSTOMER_TEXT);
    } finally {
      spy.mockRestore();
    }
  });
});

function uniqName(prefix: string) {
  return `${prefix}${randomUUID().replaceAll('-', '').slice(0, 10)}`;
}

describe('停用账号不收到通知', () => {
  test('责任部门负责人被停用后只发给经办人', async ({ app, testApp, connection }) => {
    const { sent, spy } = fakeSender(app);
    try {
      const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
      const dept = await makeDepartment(admin, 'disabled-head');
      const head = await makeUser(admin, uniqName('headdisabled'));
      const assignee = await makeUser(admin, uniqName('assigneeactive'));
      await expectJson(
        await admin.fetch(
          `/departments/${dept.id}/members`,
          json({ userIds: [head.id, assignee.id] }),
        ),
        200,
      );
      await expectJson(
        await admin.fetch(
          `/departments/${dept.id}`,
          json({ managerId: head.id }, 'PATCH'),
        ),
        200,
      );
      await connection.query
        .updateTable('user')
        .set({ disabledAt: new Date() })
        .where('id', '=', head.id)
        .execute();
      await connection.repository('fqcRoutingRules').createOne({
        values: {
          category: 'dimension',
          departmentId: dept.id,
          updatedAt: new Date(),
          updatedBy: 'seed',
        },
      });
      const now = new Date();
      const screeningId = randomUUID();
      await connection.repository('fqcScreenings').createOne({
        values: {
          id: screeningId,
          messageId: randomUUID(),
          category: 'dimension',
          severity: 'major',
          outcome: 'needs-review',
          reviewId: null,
          createdAt: now,
          updatedAt: now,
        },
      });
      const dispatcher = await makeUser(admin, uniqName('dispatchdisabled'));
      const session = await signIn(testApp, {
        username: dispatcher.username,
        password: PASSWORD,
      });
      const body = await expectJson(
        await session.fetch(
          `/quality/screenings/${screeningId}/dispatch`,
          json({ assigneeId: assignee.id }),
        ),
        201,
      );
      expect(sent).toHaveLength(1);
      expect(sent[0].messages.inbox.to).toEqual([assignee.id]);
      expect(body.data.review.actorName).toBeTruthy();
    } finally {
      spy.mockRestore();
    }
  });
});
