import { randomUUID } from 'node:crypto';

import {
  DEFAULT_ADMIN_CREDENTIALS,
  signIn,
  type TestSession,
} from '@nocobase/app-plugin-authentication/testing';
import type { DatabaseConnection } from '@nocobase/db';
import { describe, expect, vi } from 'vitest';

import { createStandaloneServer } from '../../server/standalone.js';
import { createAppTest } from '../helpers/test-app.js';

/**
 * 只读审计 audit-r002-confirmations.md 的 A1/A2/B1 探针，全部跑真 Postgres。
 */
const test = createAppTest({
  scope: 'test',
  createServer: createStandaloneServer,
  config: {
    app: { publicOrigin: 'http://localhost' },
    auth: { secret: 'test-auth-secret-at-least-32-characters' },
  },
});

const PASSWORD = 'R002-probe-123!';

const json = (body: unknown, key?: string) => ({
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    origin: 'http://localhost',
    'Idempotency-Key': key ?? `${Date.now()}.${randomUUID()}`,
  },
  body: JSON.stringify(body),
});

const expectJson = async (response: Response, status: number): Promise<any> => {
  const text = await response.text();
  expect(response.status, `${text}`).toBe(status);
  return JSON.parse(text);
};

const expectError = async (response: Response, status: number) =>
  (await expectJson(response, status)).error as { reason: string };

const uniq = (prefix: string) =>
  `${prefix}${randomUUID().replaceAll('-', '').slice(0, 10)}`;

const createUser = async (admin: TestSession, name: string): Promise<{ id: string; username: string }> =>
  (
    await expectJson(
      await admin.fetch(
        '/users',
        json({
          name: `姓名-${randomUUID().slice(0, 6)}`,
          username: name,
          email: `${name}@example.test`,
          password: PASSWORD,
          roleScopes: { app: ['quality_manager'] },
        }),
      ),
      201,
    )
  ).data;

const signInAs = (app: any, username: string) =>
  signIn(app, { username, password: PASSWORD });

const insertScreening = async (
  connection: DatabaseConnection,
  overrides: Partial<Record<string, unknown>> = {},
) => {
  const now = new Date();
  const values = {
    id: randomUUID(),
    messageId: randomUUID(),
    category: 'appearance',
    severity: 'minor',
    outcome: 'reviewed',
    reviewId: randomUUID(),
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
  await connection.repository('fqcScreenings').createOne({ values });
  return values;
};

const insertTicket = async (
  connection: DatabaseConnection,
  overrides: Partial<Record<string, unknown>> = {},
) => {
  const now = new Date();
  const values = {
    id: randomUUID(),
    code: `T-${randomUUID().slice(0, 8)}`,
    title: '尺寸超差',
    description: '客户正文',
    sourceMessageId: null,
    screeningId: null,
    category: 'dimension',
    severity: 'major',
    departmentId: 'dept-a',
    createdBy: 'creator',
    assigneeId: null,
    state: 'in_progress',
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

describe('审计 A2：改判缺省字段', () => {
  test('只带 severity 改判时，类别保持工单现值而不是回落到草稿', async ({
    testApp,
    connection,
  }) => {
    const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
    const screening = await insertScreening(connection, {
      category: 'appearance',
      severity: 'minor',
    });
    const ticket = await insertTicket(connection, {
      screeningId: screening.id,
      category: 'dimension',
      severity: 'major',
    });
    const manager = await createUser(admin, uniq('a2rejudger'));
    const session = await signInAs(testApp, manager.username);

    await expectJson(
      await session.fetch(`/quality/screenings/${screening.id}/review`, json({ severity: 'critical' })),
      200,
    );
    const storedTicket = await connection
      .repository('fqcTickets')
      .findOne({ filter: { id: ticket.id } });
    expect(storedTicket?.category).toBe('dimension');
    expect(storedTicket?.severity).toBe('critical');
    const reviews = await connection
      .repository('fqcScreeningReviews')
      .findMany({ filter: { screeningId: screening.id } });
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toMatchObject({ kind: 'rejudge', category: 'dimension', severity: 'critical' });
  });
});

describe('审计 A2：改判缺省值与新底座原因码的相互影响', () => {
  test('只带 severity 改判撞版本冲突 → 409 TICKET_VERSION_CONFLICT，工单两列都不动', async ({
    testApp,
    connection,
  }) => {
    const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
    const screening = await insertScreening(connection, {
      category: 'appearance',
      severity: 'minor',
    });
    const ticket = await insertTicket(connection, {
      screeningId: screening.id,
      category: 'dimension',
      severity: 'major',
    });
    const manager = await createUser(admin, uniq('a2versionconflict'));
    const session = await signInAs(testApp, manager.username);

    // 新底座把「已关闭」与「被别人改过」分成两个原因码。这里只推进版本、不改状态，
    // 钉住 A2 的缺省取值不会把版本冲突误判成关单，也不会在回滚后留下半写入。
    const reviewsProto = Object.getPrototypeOf(
      connection.repository('fqcScreeningReviews') as object,
    ) as any;
    const originalCreate = reviewsProto.createMany;
    const spy = vi.spyOn(reviewsProto, 'createMany').mockImplementation(async function (
      this: unknown,
      ...args: unknown[]
    ) {
      await connection.query
        .updateTable('fqcTickets')
        .set({ lifecycleVersion: Number(ticket.lifecycleVersion) + 1 })
        .where('id', '=', ticket.id)
        .execute();
      return originalCreate.apply(this, args);
    });
    try {
      const error = await expectError(
        await session.fetch(
          `/quality/screenings/${screening.id}/review`,
          json({ severity: 'critical' }),
        ),
        409,
      );
      expect(error.reason).toBe('TICKET_VERSION_CONFLICT');
    } finally {
      spy.mockRestore();
    }
    const stored = await connection
      .repository('fqcTickets')
      .findOne({ filter: { id: ticket.id } });
    expect(stored?.category).toBe('dimension');
    expect(stored?.severity).toBe('major');
    expect(
      await connection
        .repository('fqcScreeningReviews')
        .findMany({ filter: { screeningId: screening.id } }),
    ).toHaveLength(0);
  });
});

describe('审计 B1：确认分支 departmentId 校验', () => {
  test('空串 departmentId 被 400 挡掉，不落确认记录', async ({ testApp, connection }) => {
    const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
    const screening = await insertScreening(connection);
    const manager = await createUser(admin, uniq('b1empty'));
    const session = await signInAs(testApp, manager.username);
    expect((await expectError(
      await session.fetch(`/quality/screenings/${screening.id}/review`, json({ departmentId: '' })),
      400,
    )).reason).toBeTruthy();
    expect(
      await connection.repository('fqcScreeningReviews').findMany({ filter: { screeningId: screening.id } }),
    ).toHaveLength(0);
  });

  test('不存在的部门被 422 挡掉，不落确认记录', async ({ testApp, connection }) => {
    const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
    const screening = await insertScreening(connection);
    const manager = await createUser(admin, uniq('b1missing'));
    const session = await signInAs(testApp, manager.username);
    const error = await expectError(
      await session.fetch(`/quality/screenings/${screening.id}/review`, json({ departmentId: randomUUID() })),
      422,
    );
    expect(error.reason).toBe('DEPARTMENT_NOT_FOUND');
    expect(
      await connection.repository('fqcScreeningReviews').findMany({ filter: { screeningId: screening.id } }),
    ).toHaveLength(0);
  });

  test('已停用的部门被 422 挡掉，不落确认记录', async ({ testApp, connection }) => {
    const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
    const screening = await insertScreening(connection);
    const department = await expectJson(
      await admin.fetch(
        '/departments',
        json({ title: `部门-${uniq('b1off')}`, code: uniq('B1OFF-') }),
      ),
      201,
    );
    await connection.query
      .updateTable('departments')
      .set({ active: false })
      .where('id', '=', department.data.id)
      .execute();
    const manager = await createUser(admin, uniq('b1disabled'));
    const session = await signInAs(testApp, manager.username);
    const error = await expectError(
      await session.fetch(
        `/quality/screenings/${screening.id}/review`,
        json({ departmentId: department.data.id }),
      ),
      422,
    );
    expect(error.reason).toBe('DEPARTMENT_NOT_FOUND');
    expect(
      await connection.repository('fqcScreeningReviews').findMany({ filter: { screeningId: screening.id } }),
    ).toHaveLength(0);
  });
});
