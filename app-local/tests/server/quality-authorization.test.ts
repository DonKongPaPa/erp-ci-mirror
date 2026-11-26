import { randomUUID } from 'node:crypto';

import { userAdministrationServiceToken } from '@nocobase/app-plugin-authentication';
import {
  DEFAULT_ADMIN_CREDENTIALS,
  signIn,
  type SignInTarget,
  type TestSession,
} from '@nocobase/app-plugin-authentication/testing';
import {
  authorizationToken,
  type AppAuthorization,
} from '@nocobase/app-plugin-authorization';
import { scopedApiKeysToken } from '@nocobase/app-plugin-api-keys/server';
import type { Application } from '@nocobase/app-server/application';
import { createAppTest } from '../helpers/test-app.js';
import type { DatabaseConnection } from '@nocobase/db';
import { expect } from 'vitest';

import { createStandaloneServer } from '../../server/standalone.js';

/**
 * R-013 第 2 段：质量五个端点的授权，以及投递端点的资格与幂等键；
 * 另含验收第 11 条后半的「只持业务角色读用户列表得 403」。
 *
 * 验收标准第 3b、7、10、11、12 条。断言之前先确认 FQC 的资源已经注册完成：没注册时
 * 连 root 也是 403，原因码是 RESOURCE_ACTION_NOT_SUPPORTED，那样的 403 不算数。
 * 应用在 createAppTest 启动时已经跑过 provider 的 boot()，这里只是把前提钉住。
 *
 * `canReview` 只看这一行的状态：`needs-review` 为真，其余为假。处理权限由客户端的
 * `useCan` 判，列表端点不在同一个请求里再 authorize 一次。
 */

const test = createAppTest({
  createServer: createStandaloneServer,
  config: {
    app: { publicOrigin: 'http://localhost' },
    auth: { secret: 'test-auth-secret-at-least-32-characters' },
  },
});

const PASSWORD = 'R013-quality-123!';
const FQC_TABLES = ['fqcMessages', 'fqcScreenings', 'fqcTickets'] as const;
const FQC_ACTIONS = ['view', 'handle', 'intake'] as const;

interface ApiErrorBody {
  error: {
    code: number;
    status: string;
    reason: string;
    domain: string;
    message: string;
  };
}

interface IngestedScreening extends Record<string, unknown> {
  id: string;
  outcome: string;
}

interface IngestedMessage extends Record<string, unknown> {
  id: string;
  content: string;
  status: string;
  receivedAt: string;
}

interface IngestedTicket extends Record<string, unknown> {
  id: string;
}

interface Ingested {
  data: {
    message: IngestedMessage;
    screening: IngestedScreening;
    ticket: IngestedTicket;
  };
}

interface ScreeningRow {
  id: string;
  outcome: string;
  canReview: boolean;
}

interface InspectedDecision {
  effect: string;
  reasons: {
    code: string;
    message: string;
    details?: { source?: { plugin?: string; id?: string } };
  }[];
}

const operationKey = () => `${Date.now()}.${randomUUID()}`;

const json = (body: unknown, method = 'POST') => ({
  method,
  headers: {
    'content-type': 'application/json',
    origin: 'http://localhost',
    'Idempotency-Key': operationKey(),
  },
  body: JSON.stringify(body),
});

const apiKeyHeaders = (secret: string, key: string) => ({
  'content-type': 'application/json',
  origin: 'http://localhost',
  'x-api-key': secret,
  'Idempotency-Key': key,
});

/** 断言状态并把响应体读出来；失败时把服务端的原话带进报错。 */
const expectJson = async (
  response: Response,
  status: number,
): Promise<unknown> => {
  const text = await response.text();
  expect(response.status, `${text}`).toBe(status);
  return JSON.parse(text) as unknown;
};

const expectError = async (
  response: Response,
  status: number,
): Promise<ApiErrorBody['error']> =>
  ((await expectJson(response, status)) as ApiErrorBody).error;

/** 被授权插件拒掉：403 PERMISSION_DENIED，原因码 AUTHORIZATION_DENIED。 */
const expectAuthorizationDenied = async (
  response: Response,
  what: string,
): Promise<void> => {
  const error = await expectError(response, 403);
  expect(error.status, `${what} 应当是 PERMISSION_DENIED`).toBe(
    'PERMISSION_DENIED',
  );
  expect(error.reason, `${what} 应当以 AUTHORIZATION_DENIED 被拒`).toBe(
    'AUTHORIZATION_DENIED',
  );
};

/**
 * 201 里的一条与随后从列表读到的同一条逐字段相等。
 *
 * 「投递」不带读，201 由写入的值组成；有查看权限的身份从列表端点读到的是库里的形态。
 * 字段集合与每个值都要对上，否则一边是输入形态、一边是列形态时测试抓不住。
 */
const expectSameRecord = (
  received: Record<string, unknown>,
  stored: Record<string, unknown>,
  label: string,
): void => {
  expect(
    Object.keys(received).sort(),
    `201 响应里的${label}字段与列表端点读到的不是同一组`,
  ).toEqual(Object.keys(stored).sort());
  for (const [field, value] of Object.entries(stored)) {
    expect(
      received[field],
      `${label}的 ${field} 与列表端点读到的形态不一致`,
    ).toEqual(value);
  }
};

const authzOf = (app: Application): AppAuthorization => {
  const authz = app.container.resolve(authorizationToken);
  // 资源没注册时连 root 也 403；先钉住注册结果，后面的 403 才是授权意义上的 403。
  expect(
    authz.compositeResources.getAction('fqc', 'view'),
    'FQC 资源还没注册，此时端点上的 403 不算数',
  ).toBeDefined();
  return authz;
};

/** 建一个用户；`roleScopes` 省略时框架会给它 member，这里一律显式写。 */
const createUser = async (
  admin: TestSession,
  name: string,
  roleScopes: Record<string, string[]>,
): Promise<{ id: string }> => {
  const response = await admin.fetch(
    '/users',
    json({
      name,
      username: name,
      email: `${name}@example.test`,
      password: PASSWORD,
      roleScopes,
    }),
  );
  const text = await response.text();
  expect(response.status, `${text}`).toBe(201);
  return (JSON.parse(text) as { data: { id: string } }).data;
};

const signInAs = (app: SignInTarget, username: string) =>
  signIn(app, { username, password: PASSWORD });

/**
 * R-026：新建的「人」自动带基线角色 staff。要一个真正零赋值的 person 账号，
 * 建完之后把基线撤掉（用 `{ app: [] }` 建不行，基线会在提交之后补上）。
 */
const createNoRoleUser = async (
  admin: TestSession,
  authz: AppAuthorization,
  name: string,
): Promise<{ id: string }> => {
  const user = await createUser(admin, name, { app: [] });
  await authz.permissionSets.revoke(`user:${user.id}:staff`);
  return user;
};

/** 这个用户持有的权限集，用来证明「没有任何角色」与「质量主管」就是字面意思。 */
const permissionSetsOf = async (
  authz: AppAuthorization,
  userId: string,
): Promise<string[]> => {
  const assignments = await authz.permissionSets.listAssignments();
  return assignments
    .filter(
      (assignment) =>
        assignment.subject.type === 'user' && assignment.subject.id === userId,
    )
    .map((assignment) => assignment.permissionSet)
    .sort();
};

const insertScreening = async (
  connection: DatabaseConnection,
  outcome: string,
): Promise<string> => {
  const id = randomUUID();
  const now = new Date();
  await connection.repository('fqcScreenings').createOne({
    values: {
      id,
      messageId: randomUUID(),
      category: 'dimension',
      severity: 'minor',
      suggestedOwner: null,
      summary: null,
      modelName: 'r013-test',
      outcome,
      createdAt: now,
      updatedAt: now,
    },
  });
  return id;
};

const countFqcRows = async (
  connection: DatabaseConnection,
): Promise<Record<string, number>> => {
  const counts: Record<string, number> = {};
  for (const table of FQC_TABLES) {
    counts[table] = await connection.repository(table).count();
  }
  return counts;
};

const intakeBody = (content: string, receivedAt?: string) => ({
  channel: 'wechat',
  senderName: 'R-013 幂等测试客户',
  content,
  ...(receivedAt === undefined ? {} : { receivedAt }),
});

/** 一个持有 `fqc.intake` 的权限集；四个业务角色都不持有投递，测试里现建一份。 */
const intakeGrant = {
  resource: { type: 'composite', id: 'fqc' },
  actions: [
    {
      action: 'intake',
      policy: {
        type: 'composite',
        scopes: {
          fqcMessages: 'allRecords',
          fqcScreenings: 'allRecords',
          fqcTickets: 'allRecords',
        },
      },
    },
  ],
};

test('R-013: the FQC resources are registered before the endpoint checks run', async ({
  app,
}) => {
  const authz = app.container.resolve(authorizationToken);
  for (const table of FQC_TABLES) {
    expect(authz.database.collections.has(table), `${table} 没有注册`).toBe(
      true,
    );
  }
  for (const action of FQC_ACTIONS) {
    expect(
      authz.compositeResources.getAction('fqc', action),
      `fqc.${action} 没有注册`,
    ).toBeDefined();
  }
});

test('R-013 3b: a user with no permission set is refused by every quality endpoint', async ({
  testApp,
  app,
  connection,
}) => {
  const authz = authzOf(app);
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const nobody = await createNoRoleUser(admin, authz, 'r013qnone');
  expect(
    await permissionSetsOf(authz, nobody.id),
    '这个用户不该持有任何权限集',
  ).toEqual([]);

  const session = await signInAs(testApp, 'r013qnone');
  const screeningId = await insertScreening(connection, 'needs-review');

  for (const path of [
    '/quality/tickets',
    '/quality/messages',
    '/quality/screenings',
  ]) {
    await expectAuthorizationDenied(await session.fetch(path), `GET ${path}`);
  }
  await expectAuthorizationDenied(
    await session.fetch(`/quality/screenings/${screeningId}/review`, json({})),
    '复核端点',
  );
  await expectAuthorizationDenied(
    await session.fetch('/quality/intake', json(intakeBody('没有角色的人'))),
    '投递端点',
  );

  // 被拒的请求一行都没写进去。
  expect(
    await connection.repository('fqcScreenings').findOne({
      filter: { id: screeningId },
    }),
  ).toMatchObject({ outcome: 'needs-review' });
});

test('R-013 3b: a quality manager lists and reviews, and may not intake', async ({
  testApp,
  app,
  connection,
}) => {
  const authz = authzOf(app);
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const manager = await createUser(admin, 'r013qmanager', {
    app: ['quality_manager'],
  });
  expect(await permissionSetsOf(authz, manager.id)).toEqual([
    'quality_manager',
    'staff',
  ]);

  const session = await signInAs(testApp, 'r013qmanager');
  for (const path of [
    '/quality/tickets',
    '/quality/messages',
    '/quality/screenings',
  ]) {
    await expectJson(await session.fetch(path), 200);
  }

  const screeningId = await insertScreening(connection, 'needs-review');
  const reviewed = (await expectJson(
    await session.fetch(`/quality/screenings/${screeningId}/review`, json({})),
    200,
  )) as { data: ScreeningRow };
  expect(reviewed.data.id).toBe(screeningId);
  expect(reviewed.data.outcome).toBe('reviewed');

  await expectAuthorizationDenied(
    await session.fetch('/quality/intake', json(intakeBody('质量主管投递'))),
    '质量主管的投递',
  );
});

test('R-013 3b: a restricted record scope filters the list and hides excluded rows from review', async ({
  testApp,
  app,
  connection,
}) => {
  const authz = authzOf(app);
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const allowedId = await insertScreening(connection, 'needs-review');
  const excludedId = await insertScreening(connection, 'needs-review');
  const scopedUser = await createUser(admin, 'r013qscoped', { app: [] });
  // 只有这条初筛在范围里：消息与工单仍放全部，好让 403 只来自初筛表的范围。
  const scoped = (table: 'fqcMessages' | 'fqcScreenings' | 'fqcTickets') =>
    table === 'fqcScreenings'
      ? { type: 'records', ids: [allowedId] }
      : 'allRecords';
  await authz.permissionSets.create({
    key: 'r013q-scoped',
    grants: [
      {
        resource: { type: 'composite', id: 'fqc' },
        actions: ['view', 'handle'].map((action) => ({
          action,
          policy: {
            type: 'composite',
            scopes: {
              fqcMessages: scoped('fqcMessages'),
              fqcScreenings: scoped('fqcScreenings'),
              fqcTickets: scoped('fqcTickets'),
              // R-002：确认要读写确认记录表；范围与业务表分开给。
              fqcScreeningReviews: 'allRecords',
            },
          },
        })),
      },
    ],
  });
  await authz.permissionSets.assign({
    subject: { type: 'user', id: scopedUser.id },
    permissionSet: 'r013q-scoped',
  });

  const session = await signInAs(testApp, 'r013qscoped');
  const rows = (
    (await expectJson(await session.fetch('/quality/screenings'), 200)) as {
      data: ScreeningRow[];
    }
  ).data;
  expect(
    rows.map((row) => row.id),
    '列表应当只出现放行的那一行',
  ).toEqual([allowedId]);

  // 被范围排除的行与不存在同形：404，且这一行没有被改。
  const refused = await session.fetch(
    `/quality/screenings/${excludedId}/review`,
    json({}),
  );
  const error = await expectError(refused, 404);
  expect(error.reason, '范围外的复核应当与不存在的 id 同形').toBe(
    'SCREENING_NOT_FOUND',
  );
  expect(
    await connection.repository('fqcScreenings').findOne({
      filter: { id: excludedId },
    }),
    '范围外的行不该被改',
  ).toMatchObject({ outcome: 'needs-review' });

  // 放行的那一行照常可以复核：证明范围不是把整个端点拒掉。
  const reviewed = (await expectJson(
    await session.fetch(`/quality/screenings/${allowedId}/review`, json({})),
    200,
  )) as { data: ScreeningRow };
  expect(reviewed.data.outcome).toBe('reviewed');
});

test('R-013 3b: a department manager lists but may neither review nor intake', async ({
  testApp,
  app,
  connection,
}) => {
  const authz = authzOf(app);
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const deptManager = await createUser(admin, 'r013qdept', {
    app: ['dept_manager'],
  });
  expect(await permissionSetsOf(authz, deptManager.id)).toEqual([
    'dept_manager',
    'staff',
  ]);

  const session = await signInAs(testApp, 'r013qdept');
  for (const path of [
    '/quality/tickets',
    '/quality/messages',
    '/quality/screenings',
  ]) {
    await expectJson(await session.fetch(path), 200);
  }

  const screeningId = await insertScreening(connection, 'needs-review');
  // 只持查看：复核必须在授权那一步就被拒，而不是走到仓库层才以 WRITE_FORBIDDEN 失败。
  await expectAuthorizationDenied(
    await session.fetch(`/quality/screenings/${screeningId}/review`, json({})),
    '部门主管的复核',
  );
  expect(
    await connection.repository('fqcScreenings').findOne({
      filter: { id: screeningId },
    }),
  ).toMatchObject({ outcome: 'needs-review' });

  await expectAuthorizationDenied(
    await session.fetch('/quality/intake', json(intakeBody('部门主管投递'))),
    '部门主管的投递',
  );
});

test('R-013 3b: root is allowed on every quality endpoint', async ({
  testApp,
  app,
  connection,
}) => {
  authzOf(app);
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  for (const path of [
    '/quality/tickets',
    '/quality/messages',
    '/quality/screenings',
  ]) {
    await expectJson(await admin.fetch(path), 200);
  }

  const screeningId = await insertScreening(connection, 'needs-review');
  const reviewed = (await expectJson(
    await admin.fetch(`/quality/screenings/${screeningId}/review`, json({})),
    200,
  )) as { data: ScreeningRow };
  expect(reviewed.data.outcome).toBe('reviewed');

  const ingested = (await expectJson(
    await admin.fetch('/quality/intake', json(intakeBody('超管投递'))),
    201,
  )) as Ingested;
  expect(ingested.data.message.content).toBe('超管投递');
});

test('R-013: the screening list marks needs-review rows with canReview for both quality roles', async ({
  testApp,
  app,
  connection,
}) => {
  authzOf(app);
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  await createUser(admin, 'r013qcanreviewmanager', {
    app: ['quality_manager'],
  });
  await createUser(admin, 'r013qcanreviewdept', { app: ['dept_manager'] });

  // 三种状态各一行：只有「待人工复核」算可以确认。
  const seeded = new Map<string, string>();
  for (const outcome of ['needs-review', 'auto', 'reviewed']) {
    seeded.set(outcome, await insertScreening(connection, outcome));
  }

  const manager = await signInAs(testApp, 'r013qcanreviewmanager');
  const dept = await signInAs(testApp, 'r013qcanreviewdept');
  const rowsOf = async (session: TestSession) =>
    (
      (await expectJson(await session.fetch('/quality/screenings'), 200)) as {
        data: ScreeningRow[];
      }
    ).data;

  const managerRows = await rowsOf(manager);
  for (const row of managerRows) {
    expect(
      row.canReview,
      `初筛 ${row.id}（${row.outcome}）的 canReview 应当只表示这一行的状态`,
    ).toBe(row.outcome === 'needs-review');
  }
  for (const [outcome, id] of seeded) {
    expect(
      managerRows.find((row) => row.id === id)?.canReview,
      `${outcome} 这一行的 canReview 不对`,
    ).toBe(outcome === 'needs-review');
  }

  const deptRows = await rowsOf(dept);
  expect(
    new Map(deptRows.map((row) => [row.id, row.canReview])),
    '部门主管与质量主管看到的 canReview 应当一致',
  ).toEqual(new Map(managerRows.map((row) => [row.id, row.canReview])));
});

test('R-013 12: a service account key holding fqc.intake intakes once per idempotency key', async ({
  testApp,
  app,
  connection,
}) => {
  const authz = authzOf(app);
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  // 重放要经请求自己的读范围读回那一行（R-002 的裁决），所以夹具给这份投递权限集
  // 再加一份全量读；没有读范围的投递账号重放会得到 409，那一条在
  // `tests/server/quality-drafting.test.ts` 的「重放经请求自己的读范围」里。
  const replayViewGrant = {
    resource: { type: 'composite', id: 'fqc' },
    actions: [
      {
        action: 'view',
        policy: {
          type: 'composite',
          scopes: {
            fqcMessages: 'allRecords',
            fqcScreenings: 'allRecords',
            fqcTickets: 'allRecords',
            fqcScreeningReviews: 'allRecords',
          },
        },
      },
    ],
  };
  await authz.permissionSets.create({
    key: 'r013q-intake',
    grants: [intakeGrant, replayViewGrant],
  });

  const users = app.container.resolve(userAdministrationServiceToken);
  const keys = app.container.resolve(scopedApiKeysToken);
  const allowed = await users.createServiceAccount({
    name: 'R013 quality intake',
  });
  const denied = await users.createServiceAccount({
    name: 'R013 quality intake denied',
  });
  await authz.permissionSets.assign({
    subject: { type: 'user', id: allowed.id },
    permissionSet: 'r013q-intake',
  });
  expect(
    await permissionSetsOf(authz, allowed.id),
    '服务账号没有拿到投递权限集',
  ).toEqual(['r013q-intake']);
  expect(await permissionSetsOf(authz, denied.id)).toEqual([]);

  const secretOf = async (id: string): Promise<string> =>
    (
      await keys.create(
        id,
        { name: 'r013q-intake-key' },
        await keys.identityOf(id),
      )
    ).secret;
  const allowedSecret = await secretOf(allowed.id);
  const deniedSecret = await secretOf(denied.id);

  const before = await countFqcRows(connection);
  const body = intakeBody('这批零件尺寸超差，装配不上');
  const key = operationKey();
  const post = (secret: string, idempotencyKey: string, payload: unknown) =>
    testApp.request('/quality/intake', {
      method: 'POST',
      headers: apiKeyHeaders(secret, idempotencyKey),
      body: JSON.stringify(payload),
    });

  // ① 持 fqc.intake 的密钥：201，三张表各多一行。
  const first = await post(allowedSecret, key, body);
  expect(first.headers.get('Idempotency-Replayed')).toBe('false');
  const firstBody = (await expectJson(first, 201)) as Ingested;
  const afterFirst = await countFqcRows(connection);
  for (const table of FQC_TABLES) {
    expect(afterFirst[table], `${table} 应当多一行`).toBe(before[table] + 1);
  }

  // ② 同一个键再投一次：返回第一次的结果，库里仍然只有那几行。
  const replay = await post(allowedSecret, key, body);
  expect(replay.headers.get('Idempotency-Replayed')).toBe('true');
  const replayBody = (await expectJson(replay, 201)) as Ingested;
  expect(replayBody.data.message.id).toBe(firstBody.data.message.id);
  expect(replayBody.data.screening.id).toBe(firstBody.data.screening.id);
  expect(replayBody.data.ticket.id).toBe(firstBody.data.ticket.id);
  expect(await countFqcRows(connection)).toEqual(afterFirst);

  // ③ 同一个键换了请求体：409 OPERATION_CONFLICT，同样一行都不写。
  const conflict = await post(
    allowedSecret,
    key,
    intakeBody('同一个键的另一条消息'),
  );
  expect((await expectError(conflict, 409)).reason).toBe('OPERATION_CONFLICT');
  expect(await countFqcRows(connection)).toEqual(afterFirst);

  // ④ 不持 fqc.intake 的服务账号密钥：403，一行都不写。
  await expectAuthorizationDenied(
    await post(deniedSecret, operationKey(), intakeBody('没有投递权限的密钥')),
    '不持投递权限的服务账号',
  );
  expect(await countFqcRows(connection)).toEqual(afterFirst);

  // ⑤ 没有投递权限的普通用户走会话：同样 403。
  await createUser(admin, 'r013qintakemanager', {
    app: ['quality_manager'],
  });
  const manager = await signInAs(testApp, 'r013qintakemanager');
  await expectAuthorizationDenied(
    await manager.fetch('/quality/intake', json(intakeBody('普通用户投递'))),
    '普通用户的投递',
  );
  expect(await countFqcRows(connection)).toEqual(afterFirst);
});

test('R-026 9/10: 投递写 open，重复的 (channel, externalId) 是 409 且一行不多', async ({
  testApp,
  app,
  connection,
}) => {
  authzOf(app);
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const before = await countFqcRows(connection);

  const first = (await expectJson(
    await admin.fetch(
      '/quality/intake',
      json({
        channel: 'wechat',
        externalId: 'r026-intake-dup-1',
        content: 'R-026 第一次投递',
      }),
    ),
    201,
  )) as Ingested;
  expect(
    first.data.message.status,
    '投递写入的消息状态应当是 open，不再是 screened',
  ).toBe('open');
  const stored = await connection
    .repository('fqcMessages')
    .findOne({ filter: { id: first.data.message.id } });
  expect(stored, '投递之后库里找不到那条消息').toMatchObject({
    status: 'open',
    externalId: 'r026-intake-dup-1',
    ownerId: null,
  });
  const afterFirst = await countFqcRows(connection);
  for (const table of FQC_TABLES) {
    expect(afterFirst[table], `${table} 应当多一行`).toBe(before[table] + 1);
  }

  // 不同幂等键、同一个 (channel, externalId)：409 FEEDBACK_ALREADY_RECORDED，一行不多。
  const duplicateResponse = await admin.fetch(
    '/quality/intake',
    json({
      channel: 'wechat',
      externalId: 'r026-intake-dup-1',
      content: 'R-026 第二次投递',
    }),
  );
  const duplicateText = await duplicateResponse.text();
  expect(duplicateResponse.status, `${duplicateText}`).toBe(409);
  const duplicateBody = JSON.parse(duplicateText) as {
    error: ApiErrorBody['error'];
    data?: unknown;
  };
  expect(duplicateBody.error.reason).toBe('FEEDBACK_ALREADY_RECORDED');
  expect(duplicateBody.error.status).toBe('ALREADY_EXISTS');
  expect(duplicateBody.error.domain).toBe('quality');
  expect(duplicateBody, '投递的 409 不该带任何一行的内容').not.toHaveProperty(
    'data',
  );
  expect(duplicateText, '409 里不该带已有那一行的标识').not.toContain(
    first.data.message.id,
  );
  expect(await countFqcRows(connection)).toEqual(afterFirst);

  // 外部标识为空的两条可以并存（空值互不相等）。
  await expectJson(
    await admin.fetch(
      '/quality/intake',
      json({ channel: 'wechat', content: '空标识一' }),
    ),
    201,
  );
  await expectJson(
    await admin.fetch(
      '/quality/intake',
      json({ channel: 'wechat', content: '空标识二' }),
    ),
    201,
  );
  const afterNulls = await countFqcRows(connection);
  expect(afterNulls.fqcMessages, '两条空标识应当各建一行').toBe(
    afterFirst.fqcMessages + 2,
  );
});

/**
 * R-003 S1：新加的七列在授权第二片定契约之前，任何走「查看」的读接口都拿不到。
 *
 * 声明逐列列出原来的十五列，不写 `read('*')`。这里从列表端点验行为：守门的
 * 「201 与列表同一组字段」只保证了两边一致，两边一起多回七列它也不会红。
 */
test('R-003 S1: the seven new ticket columns are absent from every view read', async ({
  testApp,
  app,
}) => {
  authzOf(app);
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  await createUser(admin, 'r003s1viewfields', { app: ['quality_manager'] });
  await expectJson(
    await admin.fetch(
      '/quality/intake',
      json({ channel: 'wechat', content: 'R-003 S1 查看收窄' }),
    ),
    201,
  );

  const viewer = await signInAs(testApp, 'r003s1viewfields');
  const rows = (
    (await expectJson(await viewer.fetch('/quality/tickets'), 200)) as {
      data: Record<string, unknown>[];
    }
  ).data;
  expect(rows.length, '列表里应当能看到刚投递建的那张工单').toBeGreaterThan(0);
  for (const row of rows) {
    expect(Object.keys(row).sort(), '工单列表不该多出 R-003 的新列').toEqual(
      [
        'assigneeId',
        'category',
        'closedAt',
        'code',
        'createdAt',
        'description',
        'dueAt',
        'id',
        'ownerDepartment',
        'screeningId',
        'severity',
        'sourceMessageId',
        'state',
        'title',
        'updatedAt',
      ].sort(),
    );
    for (const field of [
      'departmentId',
      'createdBy',
      'resolution',
      'reopenCount',
      'statusChangedAt',
      'lifecycleVersion',
      'lifecycleDefinition',
    ]) {
      expect(row, `工单列表读到了 R-003 新加的 ${field}`).not.toHaveProperty(
        field,
      );
    }
  }
});

test('R-013: the intake response matches the stored message, screening and ticket the list endpoints read', async ({
  testApp,
  app,
}) => {
  authzOf(app);
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  await createUser(admin, 'r013qshapemanager', { app: ['quality_manager'] });

  // 带偏移的输入会被换算成服务器本地墙钟；201 与列表都必须是换算后的同一形态。
  const ingested = (await expectJson(
    await admin.fetch(
      '/quality/intake',
      json(
        intakeBody('这批零件尺寸超差，装配不上', '2026-11-24T19:20:00+08:00'),
      ),
    ),
    201,
  )) as Ingested;
  expect(
    ingested.data.message.receivedAt,
    '201 的 receivedAt 应当是列里存的墙钟形态，而不是输入的偏移形态',
  ).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}$/u);

  // 「投递」不带读，201 由写入的值组成；有查看权限的身份从列表端点读到的是库里的形态。
  // 三样记录逐字段相等，置信度也就不会一边是数字、一边是字符串。
  const viewer = await signInAs(testApp, 'r013qshapemanager');
  const messageRows = (
    (await expectJson(await viewer.fetch('/quality/messages'), 200)) as {
      data: IngestedMessage[];
    }
  ).data;
  const storedMessage = messageRows.find(
    (row) => row.id === ingested.data.message.id,
  );
  expect(storedMessage, '列表里找不到刚投递的那条消息').toBeDefined();
  // R-026 起投递的 201 还带新加的表单字段，「查看」只读原来的十一列；
  // 按读者实际读到的列投影后再比，仍然逐字段相等。
  const viewedMessage = Object.fromEntries(
    Object.keys(storedMessage!).map((key) => [
      key,
      (ingested.data.message as Record<string, unknown>)[key],
    ]),
  );
  expectSameRecord(viewedMessage, storedMessage!, '消息');

  const screeningRows = (
    (await expectJson(await viewer.fetch('/quality/screenings'), 200)) as {
      data: (ScreeningRow & Record<string, unknown>)[];
    }
  ).data;
  const storedScreening = screeningRows.find(
    (row) => row.id === ingested.data.screening.id,
  );
  expect(storedScreening, '列表里找不到刚投递的那条初筛').toBeDefined();
  const screeningFields: Record<string, unknown> = { ...storedScreening };
  delete screeningFields.canReview;
  expectSameRecord(ingested.data.screening, screeningFields, '初筛');
  expect(
    ingested.data.screening.confidence,
    '201 响应里的置信度应当与库里一致，是字符串',
  ).toBe(storedScreening?.confidence);
  // R-002：投递的响应带上六个出处列与 reviewId。这一段只会出规则版，开关默认关着。
  expect(
    ingested.data.screening,
    '投递的初筛应当带上 R-002 的七个字段',
  ).toMatchObject({
    engine: 'rules',
    promptVersion: null,
    degraded: false,
    degradeReason: 'model-disabled',
    knowledgeRefs: [],
    redacted: false,
    reviewId: null,
  });

  const ticketRows = (
    (await expectJson(await viewer.fetch('/quality/tickets'), 200)) as {
      data: IngestedTicket[];
    }
  ).data;
  const storedTicket = ticketRows.find(
    (row) => row.id === ingested.data.ticket.id,
  );
  expect(storedTicket, '列表里找不到刚投递的那条工单').toBeDefined();
  expectSameRecord(ingested.data.ticket, storedTicket!, '工单');
});

test('R-013 10: the inspector reports the quality manager permission set as the source, and denies a user with no role', async ({
  testApp,
  app,
}) => {
  const authz = authzOf(app);
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const manager = await createUser(admin, 'r013qinspectormanager', {
    app: ['quality_manager'],
  });
  const nobody = await createNoRoleUser(admin, authz, 'r013qinspectornone');
  expect(await permissionSetsOf(authz, nobody.id)).toEqual([]);

  const decide = async (id: string): Promise<InspectedDecision> =>
    (
      (await expectJson(
        await admin.fetch(
          '/authorization/inspector/decide',
          json({
            subject: { type: 'user', id },
            resource: { type: 'composite', id: 'fqc' },
            action: 'view',
          }),
        ),
        200,
      )) as { data: InspectedDecision }
    ).data;

  const granted = await decide(manager.id);
  expect(granted.effect, '质量主管的查看应当是「有条件放行」').toBe(
    'conditional',
  );
  const sources = granted.reasons
    .filter((reason) => reason.code === 'GRANT_MATCHED')
    .map((reason) => reason.details?.source);
  expect(sources, '质量主管的放行应当来自他持有的权限集').toContainEqual(
    expect.objectContaining({
      plugin: 'permission-sets',
      id: 'quality_manager',
    }),
  );

  const refused = await decide(nobody.id);
  expect(refused.effect, '没有任何角色的用户应当被判拒绝').toBe('deny');
  expect(refused.reasons.map((reason) => reason.code)).toContain(
    'NO_MATCHING_GRANT',
  );
});

test('R-013 7: two sessions saving the same revision answer PERMISSION_SET_CONFLICT', async ({
  testApp,
  app,
}) => {
  authzOf(app);
  const first = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const second = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);

  const created = (await expectJson(
    await first.fetch(
      '/authorization/permissionSets',
      json({ key: 'r013q-editor', grants: [] }),
    ),
    201,
  )) as { data: { key: string; revision: string } };
  expect(created.data.key).toBe('r013q-editor');
  const revision = created.data.revision;
  expect(typeof revision, '权限集应当带版本号').toBe('string');

  const pageGrant = {
    resource: { type: 'page', id: 'quality' },
    actions: [{ action: 'access' }],
  };
  const saved = (await expectJson(
    await first.fetch(
      '/authorization/permissionSets/r013q-editor',
      json({ expectedRevision: revision, grants: [pageGrant] }, 'PATCH'),
    ),
    200,
  )) as { data: { revision: string } };
  expect(saved.data.revision, '保存成功后版本号应当变化').not.toBe(revision);

  const stale = await second.fetch(
    '/authorization/permissionSets/r013q-editor',
    json({ expectedRevision: revision, grants: [] }, 'PATCH'),
  );
  const error = await expectError(stale, 409);
  expect(error.reason, '版本落后应当以 PERMISSION_SET_CONFLICT 报 409').toBe(
    'PERMISSION_SET_CONFLICT',
  );
});

test('R-013 11: the four business roles are refused on the user list, root is allowed', async ({
  testApp,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);

  // 验收第 11 条后半：四个业务角色都不持有「用户 · 读」，用户列表接口一律 403。
  for (const role of [
    'quality_manager',
    'quality_inspector',
    'dept_manager',
    'staff',
  ] as const) {
    const username = `r013users${role.replace(/_/gu, '')}`;
    await createUser(admin, username, { app: [role] });
    const session = await signInAs(testApp, username);
    const response = await session.fetch('/users');
    await response.text();
    expect(response.status, `${role} 不该能读用户列表`).toBe(403);
  }

  // 同一条请求 root 拿到 200，证明请求本身发对了，上面的 403 来自角色而不是接口。
  await expectJson(await admin.fetch('/users'), 200);
});
