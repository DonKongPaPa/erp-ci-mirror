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
import {
  mutationDigest,
  mutationReceiptCollection,
} from '@nocobase/app-server/router';
import type { DatabaseConnection } from '@nocobase/db';
import { expect, vi } from 'vitest';

import { createAppTest } from '../helpers/test-app.js';

import { createStandaloneServer } from '../../server/standalone.js';

/**
 * R-032 验收第 3 到 9 条里属于服务端的部分：应用 API 密钥的六个端点。
 * 末尾另有补充设计的两个端点（服务账号的角色）与它们的验收 1 到 4。
 *
 * 六个端点全部只认登录会话，逐个请求核对页面授权 `application.api-keys`。
 * 签发出来的密钥代表服务账号：认证靠服务账号本身，权限靠服务账号被授予的角色。
 * 明文只在签发与轮换的响应里出现，列表永远不带。
 */

const test = createAppTest({
  createServer: createStandaloneServer,
  config: {
    app: { publicOrigin: 'http://localhost' },
    auth: { secret: 'test-auth-secret-at-least-32-characters' },
  },
});

const PASSWORD = 'R032-app-keys-123!';
const ACCOUNTS = '/application-api-keys/accounts';

interface ApiErrorBody {
  error: {
    code: number;
    status: string;
    reason: string;
    domain: string;
    message: string;
  };
}

interface ServiceAccount {
  id: string;
  name: string;
  disabledAt: string | null;
}

interface KeyView {
  id: string;
  name: string | null;
  description: string | null;
  start: string | null;
  enabled: boolean;
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
}

interface CreatedKey {
  key: KeyView;
  secret: string;
}

const operationKey = () => `${Date.now()}.${randomUUID()}`;

const json = (body: unknown, method = 'POST', key = operationKey()) => ({
  method,
  headers: {
    'content-type': 'application/json',
    origin: 'http://localhost',
    'Idempotency-Key': key,
  },
  body: JSON.stringify(body),
});

const apiKeyHeaders = (secret: string) => ({
  'content-type': 'application/json',
  origin: 'http://localhost',
  'x-api-key': secret,
  'Idempotency-Key': operationKey(),
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

interface KeyResponse {
  replayed: boolean;
  data: { key: KeyView; secret?: string };
}

/** 读一个签发或轮换的响应：状态、重放标志与响应体。 */
const readKeyResponse = async (
  response: Response,
  status: number,
): Promise<KeyResponse> => {
  const text = await response.text();
  expect(response.status, `${text}`).toBe(status);
  return {
    replayed: response.headers.get('Idempotency-Replayed') === 'true',
    data: (JSON.parse(text) as { data: KeyResponse['data'] }).data,
  };
};

interface ReceiptRow {
  digest: string;
  result: unknown;
}

/** 按入参摘要找收据行，用来断言收据里没有明文。 */
const receiptsOf = async (
  connection: DatabaseConnection,
  digest: string,
): Promise<ReceiptRow[]> =>
  (await connection.query
    .selectFrom(mutationReceiptCollection)
    .select(['digest', 'result'])
    .where('digest', '=', digest)
    .execute()) as ReceiptRow[];

const receiptText = (row: ReceiptRow | undefined): string =>
  typeof row?.result === 'string' ? row.result : JSON.stringify(row?.result);

/**
 * 让收据表的插入抛一个普通错误（不是唯一键冲突），签发与轮换自己的写入不受影响。
 * 返回的东西可以 `mockRestore()`。
 */
const failReceiptInsert = (connection: DatabaseConnection) => {
  const insertInto = connection.query.insertInto.bind(connection.query);
  const implementation = ((table: string) => {
    if (table === mutationReceiptCollection) {
      throw new Error('R-032 receipt insert failed');
    }
    return insertInto(table);
  }) as typeof connection.query.insertInto;
  return vi
    .spyOn(connection.query, 'insertInto')
    .mockImplementation(implementation);
};

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

const authzOf = (app: Application): AppAuthorization =>
  app.container.resolve(authorizationToken);

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

const createServiceAccount = async (
  admin: TestSession,
  name: string,
): Promise<ServiceAccount> =>
  (
    (await expectJson(await admin.fetch(ACCOUNTS, json({ name })), 201)) as {
      data: ServiceAccount;
    }
  ).data;

const issueKey = async (
  admin: TestSession,
  userId: string,
  body: Record<string, unknown> = {
    name: '微信适配器',
    description: '外部系统投递消息用',
    expiresInDays: 30,
  },
): Promise<CreatedKey> =>
  (
    (await expectJson(
      await admin.fetch(`${ACCOUNTS}/${userId}/keys`, json(body)),
      201,
    )) as { data: CreatedKey }
  ).data;

const listKeys = async (
  admin: TestSession,
  userId: string,
): Promise<KeyView[]> =>
  (
    (await expectJson(
      await admin.fetch(`${ACCOUNTS}/${userId}/keys`),
      200,
    )) as { data: KeyView[] }
  ).data;

interface PermissionSetView {
  key: string;
  title: string | { key: string; ns: string } | null;
}

interface RolesView {
  roles: PermissionSetView[];
  options: PermissionSetView[];
}

const rolesPath = (userId: string) => `${ACCOUNTS}/${userId}/roles`;

const rolesOf = async (
  admin: TestSession,
  userId: string,
): Promise<RolesView> =>
  (
    (await expectJson(await admin.fetch(rolesPath(userId)), 200)) as {
      data: RolesView;
    }
  ).data;

/** 整体替换服务账号的权限集；`keys` 为空表示一个都不给。 */
const replaceRoles = async (
  admin: TestSession,
  userId: string,
  keys: readonly string[],
  idempotencyKey = operationKey(),
): Promise<RolesView> =>
  (
    (await expectJson(
      await admin.fetch(
        rolesPath(userId),
        json({ keys }, 'PUT', idempotencyKey),
      ),
      200,
    )) as { data: RolesView }
  ).data;

/** 这个用户直接持有的权限集（不含 authenticated 的公共授予）。 */
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

/** 一个持有 `fqc.intake` 的权限集；投递端点用来证明密钥真的以服务账号身份通过。 */
const intakeGrant = {
  resource: { type: 'composite', id: 'fqc' },
  actions: [
    {
      action: 'intake',
      policy: {
        type: 'composite',
        scopes: {
          fqcMessages: 'allRecords',
          fqcScreenings: 'allRecords',        },
      },
    },
  ],
};

const intakeBody = (content: string) => ({
  channel: 'wechat',
  content,
});

test('R-032 4: root manages service accounts and keys through all six endpoints', async ({
  testApp,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const rootCalls = (path: string, init?: RequestInit) =>
    admin.fetch(path, init);

  const empty = (await expectJson(await rootCalls(ACCOUNTS), 200)) as {
    data: ServiceAccount[];
    meta: { total: number };
  };
  expect(empty.data, '一开始不该有任何服务账号').toEqual([]);

  const account = await createServiceAccount(admin, 'R032 外部系统');
  expect(account.name).toBe('R032 外部系统');
  expect(account.disabledAt).toBeNull();

  const listed = (await expectJson(await rootCalls(ACCOUNTS), 200)) as {
    data: ServiceAccount[];
  };
  expect(listed.data.map((row) => row.id)).toContain(account.id);

  expect(await listKeys(admin, account.id)).toEqual([]);

  const issued = await issueKey(admin, account.id);
  expect(issued.secret, '签发响应里应当有明文').toBeTruthy();
  expect(issued.key.name).toBe('微信适配器');
  expect(issued.key.expiresAt, '应用密钥必须有过期时间').not.toBeNull();

  const beforeRotate = await listKeys(admin, account.id);
  expect(beforeRotate).toHaveLength(1);
  expect(beforeRotate[0]?.id).toBe(issued.key.id);
  expect(
    beforeRotate.map((row) => Object.keys(row).sort()),
    '列表里的密钥行不该带明文或哈希字段',
  ).toEqual([Object.keys(issued.key).sort()]);

  const rotated = (await expectJson(
    await rootCalls(
      `${ACCOUNTS}/${account.id}/keys/${issued.key.id}/rotate`,
      json({}),
    ),
    200,
  )) as { data: CreatedKey };
  expect(rotated.data.key.id).toBe(issued.key.id);
  expect(rotated.data.secret, '轮换应当返回新明文').not.toBe(issued.secret);
  expect(rotated.data.secret).toBeTruthy();

  const revoked = await rootCalls(
    `${ACCOUNTS}/${account.id}/keys/${issued.key.id}`,
    {
      method: 'DELETE',
      headers: {
        origin: 'http://localhost',
        'Idempotency-Key': operationKey(),
      },
    },
  );
  expect(revoked.status, `${await revoked.text()}`).toBe(204);
  expect(await listKeys(admin, account.id)).toEqual([]);
});

test('R-032 4: a signed-in user without application.api-keys is refused by all six endpoints', async ({
  testApp,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const account = await createServiceAccount(admin, 'R032 受保护的服务账号');
  const issued = await issueKey(admin, account.id);

  await createUser(admin, 'r032nongrant', { app: [] });
  const nobody = await signInAs(testApp, 'r032nongrant');
  const keyPath = `${ACCOUNTS}/${account.id}/keys/${issued.key.id}`;

  for (const [what, path, init] of [
    ['列出服务账号', ACCOUNTS, undefined],
    ['新建服务账号', ACCOUNTS, json({ name: '不该被建出来' })],
    ['列出密钥', `${ACCOUNTS}/${account.id}/keys`, undefined],
    [
      '签发密钥',
      `${ACCOUNTS}/${account.id}/keys`,
      json({ name: '不该被签发', expiresInDays: 30 }),
    ],
    ['轮换密钥', `${keyPath}/rotate`, json({})],
    [
      '吊销密钥',
      keyPath,
      {
        method: 'DELETE',
        headers: {
          origin: 'http://localhost',
          'Idempotency-Key': operationKey(),
        },
      },
    ],
  ] as const) {
    await expectAuthorizationDenied(
      await nobody.fetch(path, init as RequestInit | undefined),
      what,
    );
  }

  const accounts = (await expectJson(await admin.fetch(ACCOUNTS), 200)) as {
    data: ServiceAccount[];
  };
  expect(
    accounts.data.map((row) => row.name),
    '被拒的新建没有留下服务账号',
  ).not.toContain('不该被建出来');
  const keys = await listKeys(admin, account.id);
  expect(keys, '被拒的签发与轮换没有动到已有的密钥').toHaveLength(1);
  expect(keys[0]?.id).toBe(issued.key.id);
});

test('R-032 4: no API key, not even a service account key, may manage application keys', async ({
  testApp,
  app,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const account = await createServiceAccount(admin, 'R032 密钥调用方');
  const issued = await issueKey(admin, account.id);
  const keyPath = `${ACCOUNTS}/${account.id}/keys/${issued.key.id}`;

  const withServiceKey = (path: string, init?: RequestInit) =>
    testApp.request(path, {
      ...init,
      headers: {
        ...(init?.headers as Record<string, string>),
        ...apiKeyHeaders(issued.secret),
      },
    });

  for (const [what, path, init] of [
    ['列出服务账号', ACCOUNTS, undefined],
    ['新建服务账号', ACCOUNTS, json({ name: '服务账号凭密钥不该能建' })],
    ['列出密钥', `${ACCOUNTS}/${account.id}/keys`, undefined],
    [
      '签发密钥',
      `${ACCOUNTS}/${account.id}/keys`,
      json({ name: '服务账号凭密钥不该能签', expiresInDays: 30 }),
    ],
    ['轮换密钥', `${keyPath}/rotate`, json({})],
    [
      '吊销密钥',
      keyPath,
      {
        method: 'DELETE',
        headers: { 'Idempotency-Key': operationKey() },
      },
    ],
  ] as const) {
    const response = await withServiceKey(
      path,
      init as RequestInit | undefined,
    );
    const error = await expectError(response, 403);
    expect(error.status, `${what} 应当是 PERMISSION_DENIED`).toBe(
      'PERMISSION_DENIED',
    );
  }

  // 人自己的密钥同样不行：管理密钥只能从登录会话发起。
  const keys = app.container.resolve(scopedApiKeysToken);
  const rootSecret = (
    await keys.create(
      admin.user.id,
      { name: 'R032 root own key' },
      await keys.identityOf(admin.user.id),
    )
  ).secret;
  const withPersonKey = await testApp.request(ACCOUNTS, {
    headers: apiKeyHeaders(rootSecret),
  });
  expect((await expectError(withPersonKey, 403)).reason).toBe(
    'API_KEY_SESSION_FORBIDDEN',
  );

  expect(await listKeys(admin, account.id)).toHaveLength(1);
});

test('R-032 5: an issued key acts as the service account, and lacks its role gives 403 not 401', async ({
  testApp,
  app,
}) => {
  const authz = authzOf(app);
  await authz.permissionSets.create({
    key: 'r032-application-intake',
    grants: [intakeGrant],
  });
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const allowed = await createServiceAccount(admin, 'R032 有投递权');
  const denied = await createServiceAccount(admin, 'R032 无投递权');
  await authz.permissionSets.assign({
    subject: { type: 'user', id: allowed.id },
    permissionSet: 'r032-application-intake',
  });

  const allowedKey = await issueKey(admin, allowed.id);
  const deniedKey = await issueKey(admin, denied.id);

  const post = (secret: string) =>
    testApp.request('/quality/intake', {
      method: 'POST',
      headers: apiKeyHeaders(secret),
      body: JSON.stringify(intakeBody('R032 应用密钥投递')),
    });

  const accepted = await post(allowedKey.secret);
  const text = await accepted.text();
  expect(accepted.status, `${text}`).toBe(201);
  expect(
    (JSON.parse(text) as { data: { message: { content: string } } }).data
      .message.content,
  ).toBe('R032 应用密钥投递');

  const refused = await post(deniedKey.secret);
  await expectAuthorizationDenied(refused, '没有投递权限的服务账号');
});

test('R-032 6: disabling the service account stops its key at once', async ({
  testApp,
  app,
}) => {
  const authz = authzOf(app);
  await authz.permissionSets.create({
    key: 'r032-disable-intake',
    grants: [intakeGrant],
  });
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const account = await createServiceAccount(admin, 'R032 会停用的服务账号');
  await authz.permissionSets.assign({
    subject: { type: 'user', id: account.id },
    permissionSet: 'r032-disable-intake',
  });
  const issued = await issueKey(admin, account.id);

  const intake = () =>
    testApp.request('/quality/intake', {
      method: 'POST',
      headers: apiKeyHeaders(issued.secret),
      body: JSON.stringify(intakeBody('停用前后的投递')),
    });

  expect((await intake()).status).toBe(201);

  const users = app.container.resolve(userAdministrationServiceToken);
  await users.disable(account.id);

  const after = await intake();
  await expectError(after, 401);
  const listed = (await expectJson(await admin.fetch(ACCOUNTS), 200)) as {
    data: ServiceAccount[];
  };
  expect(
    listed.data.find((row) => row.id === account.id)?.disabledAt,
    '停用的服务账号在列表里要看得出来',
  ).not.toBeNull();
});

test('R-032 7: only issuing and rotating return the secret, and the expiry is required within 1 to 365', async ({
  testApp,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const account = await createServiceAccount(admin, 'R032 明文检查');
  const issued = await issueKey(admin, account.id);

  const listText = await (
    await admin.fetch(`${ACCOUNTS}/${account.id}/keys`)
  ).text();
  expect(listText).not.toContain(issued.secret);
  expect(listText).not.toContain('secret');

  const rotated = (await expectJson(
    await admin.fetch(
      `${ACCOUNTS}/${account.id}/keys/${issued.key.id}/rotate`,
      json({}),
    ),
    200,
  )) as { data: CreatedKey };
  expect(rotated.data.secret).toBeTruthy();
  const rotatedText = await (
    await admin.fetch(`${ACCOUNTS}/${account.id}/keys`)
  ).text();
  expect(rotatedText).not.toContain(rotated.data.secret);

  const before = (await listKeys(admin, account.id)).length;
  for (const body of [
    { name: '缺过期天数' },
    { name: '零天', expiresInDays: 0 },
    { name: '超过一年', expiresInDays: 366 },
    { name: '非整数', expiresInDays: 1.5 },
  ]) {
    const error = await expectError(
      await admin.fetch(`${ACCOUNTS}/${account.id}/keys`, json(body)),
      400,
    );
    expect(
      ['INVALID_ARGUMENT', 'FAILED_PRECONDITION'],
      `${JSON.stringify(body)} 被拒了，但原因不是参数不合法：${error.reason}`,
    ).toContain(error.status);
  }
  expect(
    (await listKeys(admin, account.id)).length,
    '被拒的签发一把密钥都没建',
  ).toBe(before);
});

test('R-032 8: a real user id is not a service account and gets 404 without a key', async ({
  testApp,
  app,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const person = await createUser(admin, 'r032realkeytarget', { app: [] });
  const keys = app.container.resolve(scopedApiKeysToken);

  const before = (await keys.list(person.id)).length;
  const error = await expectError(
    await admin.fetch(
      `${ACCOUNTS}/${person.id}/keys`,
      json({ name: '不该发给真实用户', expiresInDays: 30 }),
    ),
    404,
  );
  expect(error.status).toBe('NOT_FOUND');
  expect(await keys.list(person.id)).toHaveLength(before);
  expect(before, '真实用户一开始没有密钥').toBe(0);

  // 列出、轮换、吊销同样按「不是服务账号」拒绝。
  await expectError(await admin.fetch(`${ACCOUNTS}/${person.id}/keys`), 404);
  await expectError(
    await admin.fetch(
      `${ACCOUNTS}/${person.id}/keys/${randomUUID()}/rotate`,
      json({}),
    ),
    404,
  );
  const remove = await admin.fetch(
    `${ACCOUNTS}/${person.id}/keys/${randomUUID()}`,
    {
      method: 'DELETE',
      headers: {
        origin: 'http://localhost',
        'Idempotency-Key': operationKey(),
      },
    },
  );
  await expectError(remove, 404);
});

test('R-032 6: service accounts are not part of the user management list', async ({
  testApp,
}) => {
  // 设计说服务账号的角色「在用户管理页里改」。核实的结果是否定的：该页读
  // `GET /users`，它默认只列 kind 为 person 的账号，页面上没有服务账号，
  // 也就没有给它改角色的入口。这一页因此不另做一套角色编辑，结论写进交付。
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const account = await createServiceAccount(admin, 'R032 不在用户管理里');

  const page = (await expectJson(await admin.fetch('/users'), 200)) as {
    data: { id: string; email: string }[];
    meta: { total: number };
  };
  expect(page.data.map((row) => row.id)).not.toContain(account.id);
  expect(
    page.data.some((row) => row.email.endsWith('@service.invalid')),
    '用户管理列表里不该出现服务账号的保留地址',
  ).toBe(false);

  // 服务账号本身仍然读得到，供这一页列密钥用。
  const accounts = (await expectJson(await admin.fetch(ACCOUNTS), 200)) as {
    data: ServiceAccount[];
  };
  expect(accounts.data.map((row) => row.id)).toContain(account.id);
});

test('R-032 4: every write requires an Idempotency-Key and replays without creating twice', async ({
  testApp,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);

  const missing = await admin.fetch(ACCOUNTS, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://localhost' },
    body: JSON.stringify({ name: '没有幂等键' }),
  });
  const missingError = await expectError(missing, 400);
  expect(missingError.reason).toBe('OPERATION_KEY_REQUIRED');

  const key = operationKey();
  const created = (await expectJson(
    await admin.fetch(ACCOUNTS, json({ name: 'R032 幂等' }, 'POST', key)),
    201,
  )) as { data: ServiceAccount };
  const replayed = (await expectJson(
    await admin.fetch(ACCOUNTS, json({ name: 'R032 幂等' }, 'POST', key)),
    201,
  )) as { data: ServiceAccount };
  expect(replayed.data.id).toBe(created.data.id);
  const accounts = (await expectJson(await admin.fetch(ACCOUNTS), 200)) as {
    data: ServiceAccount[];
  };
  expect(
    accounts.data.filter((row) => row.name === 'R032 幂等'),
    '同一个幂等键只建一个服务账号',
  ).toHaveLength(1);

  const account = created.data;
  const issueKeyIdempotency = operationKey();
  const issued = (await expectJson(
    await admin.fetch(
      `${ACCOUNTS}/${account.id}/keys`,
      json(
        { name: 'R032 幂等密钥', expiresInDays: 30 },
        'POST',
        issueKeyIdempotency,
      ),
    ),
    201,
  )) as { data: CreatedKey };
  await expectJson(
    await admin.fetch(
      `${ACCOUNTS}/${account.id}/keys`,
      json(
        { name: 'R032 幂等密钥', expiresInDays: 30 },
        'POST',
        issueKeyIdempotency,
      ),
    ),
    201,
  );
  expect(
    (await listKeys(admin, account.id)).map((row) => row.id),
    '同一个幂等键只签一把密钥',
  ).toEqual([issued.data.key.id]);
});

test('R-032 7: a replay carries no secret, and neither receipt stores one', async ({
  testApp,
  connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const account = await createServiceAccount(admin, 'R032 明文不进收据');
  const issueBody = {
    name: 'R032 只出现一次',
    description: '重放不该再带明文',
    expiresInDays: 30,
  };
  const issueKeyIdempotency = operationKey();

  const issued = await readKeyResponse(
    await admin.fetch(
      `${ACCOUNTS}/${account.id}/keys`,
      json(issueBody, 'POST', issueKeyIdempotency),
    ),
    201,
  );
  const issuedSecret = issued.data.secret;
  expect(issuedSecret, '第一次签发应当带明文').toBeTruthy();
  expect(issued.replayed).toBe(false);

  const issueReceipts = (
    await receiptsOf(connection, mutationDigest(issueBody))
  ).filter((row) => receiptText(row).includes(issued.data.key.id));
  expect(issueReceipts, '签发写了一条收据').toHaveLength(1);
  expect(
    receiptText(issueReceipts[0]),
    '收据里不该有明文：明文只在响应里出现一次',
  ).not.toContain(issuedSecret);

  const issueReplay = await readKeyResponse(
    await admin.fetch(
      `${ACCOUNTS}/${account.id}/keys`,
      json(issueBody, 'POST', issueKeyIdempotency),
    ),
    201,
  );
  expect(issueReplay.replayed).toBe(true);
  expect(issueReplay.data).toEqual({ key: issued.data.key });
  expect(issueReplay.data.secret, '重放不带明文').toBeUndefined();
  expect(JSON.stringify(issueReplay.data)).not.toContain(issuedSecret);

  const rotateIdempotency = operationKey();
  const rotated = await readKeyResponse(
    await admin.fetch(
      `${ACCOUNTS}/${account.id}/keys/${issued.data.key.id}/rotate`,
      json({}, 'POST', rotateIdempotency),
    ),
    200,
  );
  const rotatedSecret = rotated.data.secret;
  expect(rotatedSecret, '第一次轮换应当带新明文').toBeTruthy();
  expect(rotated.replayed).toBe(false);

  const rotateReceipts = (
    await receiptsOf(
      connection,
      mutationDigest({ userId: account.id, keyId: issued.data.key.id }),
    )
  ).filter((row) => receiptText(row).includes(issued.data.key.id));
  expect(rotateReceipts, '轮换写了一条收据').toHaveLength(1);
  expect(
    receiptText(rotateReceipts[0]),
    '轮换的收据里同样不该有明文',
  ).not.toContain(rotatedSecret);

  const rotateReplay = await readKeyResponse(
    await admin.fetch(
      `${ACCOUNTS}/${account.id}/keys/${issued.data.key.id}/rotate`,
      json({}, 'POST', rotateIdempotency),
    ),
    200,
  );
  expect(rotateReplay.replayed).toBe(true);
  expect(rotateReplay.data).toEqual({ key: rotated.data.key });
  expect(rotateReplay.data.secret, '轮换的重放不带明文').toBeUndefined();
  expect(JSON.stringify(rotateReplay.data)).not.toContain(rotatedSecret);
});

test('R-032 7: eight concurrent issues of one Idempotency-Key return exactly one usable secret', async ({
  testApp,
  app,
}) => {
  const authz = authzOf(app);
  const role = 'r032-race-issue-intake';
  await authz.permissionSets.create({ key: role, grants: [intakeGrant] });
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const account = await createServiceAccount(admin, 'R032 并发签发');
  await authz.permissionSets.assign({
    subject: { type: 'user', id: account.id },
    permissionSet: role,
  });

  // 让 8 个请求都先签出一把，再一起写收据：唯一键冲突的输家分支必定走到。
  const keys = app.container.resolve(scopedApiKeysToken);
  const originalIssueChecked = keys.issueChecked.bind(keys);
  let arrived = 0;
  const allArrived = Promise.withResolvers<void>();
  const timer = setTimeout(() => allArrived.resolve(), 5_000);
  const issueChecked = vi
    .spyOn(keys, 'issueChecked')
    .mockImplementation(async (userId, input) => {
      arrived += 1;
      if (arrived === 8) allArrived.resolve();
      await allArrived.promise;
      return originalIssueChecked(userId, input);
    });

  try {
    const idempotency = operationKey();
    const body = { name: 'R032 并发签发', expiresInDays: 30 };
    const responses = await Promise.all(
      Array.from({ length: 8 }, () =>
        admin.fetch(
          `${ACCOUNTS}/${account.id}/keys`,
          json(body, 'POST', idempotency),
        ),
      ),
    );
    const raced = await Promise.all(
      responses.map((response) => readKeyResponse(response, 201)),
    );

    const live = raced.filter((entry) => !entry.replayed);
    expect(live, '恰好一个响应标着未重放').toHaveLength(1);
    expect(raced.filter((entry) => entry.replayed)).toHaveLength(7);

    const withSecret = raced.filter((entry) => entry.data.secret !== undefined);
    expect(
      withSecret,
      '并发签发只有赢家的响应带明文，输家不能带自己那把已吊销的明文',
    ).toHaveLength(1);
    expect(withSecret[0], '带明文的必须是标着未重放的那个响应').toBe(live[0]);
    expect(
      raced.filter((entry) => entry.data.secret === undefined),
      '其余 7 个是重放且不带明文',
    ).toHaveLength(7);

    expect(
      (await listKeys(admin, account.id)).map((row) => row.id),
      '收据冲突的输家把自己那把吊销了，库里只剩赢家那一把',
    ).toEqual([live[0]?.data.key.id]);

    const secret = withSecret[0]?.data.secret as string;
    const accepted = await testApp.request('/quality/intake', {
      method: 'POST',
      headers: apiKeyHeaders(secret),
      body: JSON.stringify(intakeBody('并发签发的赢家')),
    });
    expect(accepted.status, `${await accepted.text()}`).toBe(201);
  } finally {
    clearTimeout(timer);
    allArrived.resolve();
    issueChecked.mockRestore();
  }
});

test('R-032 7: eight concurrent rotations of one key rotate once and return exactly one usable secret', async ({
  testApp,
  app,
}) => {
  const authz = authzOf(app);
  const role = 'r032-race-rotate-intake';
  await authz.permissionSets.create({ key: role, grants: [intakeGrant] });
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const account = await createServiceAccount(admin, 'R032 并发轮换');
  await authz.permissionSets.assign({
    subject: { type: 'user', id: account.id },
    permissionSet: role,
  });
  const issued = await issueKey(admin, account.id);

  const keys = app.container.resolve(scopedApiKeysToken);
  const originalRotate = keys.rotate.bind(keys);
  let arrived = 0;
  const allArrived = Promise.withResolvers<void>();
  // 进程内互斥下只有一个请求会进 rotate：等到超时再放行；没有互斥时 8 个都会到。
  const timer = setTimeout(() => allArrived.resolve(), 1_000);
  const rotate = vi
    .spyOn(keys, 'rotate')
    .mockImplementation(async (userId, keyId) => {
      arrived += 1;
      if (arrived === 8) allArrived.resolve();
      await allArrived.promise;
      return originalRotate(userId, keyId);
    });

  try {
    const idempotency = operationKey();
    const responses = await Promise.all(
      Array.from({ length: 8 }, () =>
        admin.fetch(
          `${ACCOUNTS}/${account.id}/keys/${issued.key.id}/rotate`,
          json({}, 'POST', idempotency),
        ),
      ),
    );
    const raced = await Promise.all(
      responses.map((response) => readKeyResponse(response, 200)),
    );

    expect(rotate, '同一把密钥的并发轮换只执行一次').toHaveBeenCalledTimes(1);

    const live = raced.filter((entry) => !entry.replayed);
    expect(live, '恰好一个响应标着未重放').toHaveLength(1);
    expect(raced.filter((entry) => entry.replayed)).toHaveLength(7);

    const withSecret = raced.filter((entry) => entry.data.secret !== undefined);
    expect(withSecret, '并发轮换只有一次轮换出的明文').toHaveLength(1);
    expect(withSecret[0], '带明文的必须是标着未重放的那个响应').toBe(live[0]);

    const intakeWith = (secret: string) =>
      testApp.request('/quality/intake', {
        method: 'POST',
        headers: apiKeyHeaders(secret),
        body: JSON.stringify(intakeBody('并发轮换后的明文')),
      });
    const secret = withSecret[0]?.data.secret as string;
    const accepted = await intakeWith(secret);
    expect(accepted.status, `${await accepted.text()}`).toBe(201);
    const stale = await intakeWith(issued.secret);
    await expectError(stale, 401);

    expect(
      (await listKeys(admin, account.id)).map((row) => row.id),
      '轮换是原地换值，库里仍然只有这一把密钥',
    ).toEqual([issued.key.id]);
  } finally {
    clearTimeout(timer);
    allArrived.resolve();
    rotate.mockRestore();
  }
});

test('R-032 7: a receipt write that fails for another reason revokes the issued key and answers 500', async ({
  testApp,
  app,
  connection,
}) => {
  const keys = app.container.resolve(scopedApiKeysToken);
  const issueChecked = vi.spyOn(keys, 'issueChecked');
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const account = await createServiceAccount(admin, 'R032 收据写失败');
  const failInsert = failReceiptInsert(connection);

  try {
    const response = await admin.fetch(
      `${ACCOUNTS}/${account.id}/keys`,
      json({ name: 'R032 收据写失败', expiresInDays: 30 }),
    );
    await expectError(response, 500);
    expect(issueChecked, '签发的调用确实执行过').toHaveBeenCalledTimes(1);
  } finally {
    failInsert.mockRestore();
    issueChecked.mockRestore();
  }

  expect(
    await listKeys(admin, account.id),
    '收据没写成，刚签出的那把必须吊销：不能留下调用方没拿到明文的有效密钥',
  ).toEqual([]);
});

test('R-032 7: a receipt write that fails after rotating revokes the rotated key and answers 500', async ({
  testApp,
  connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const account = await createServiceAccount(admin, 'R032 轮换收据写失败');
  const issued = await issueKey(admin, account.id);
  const failInsert = failReceiptInsert(connection);

  try {
    const response = await admin.fetch(
      `${ACCOUNTS}/${account.id}/keys/${issued.key.id}/rotate`,
      json({}),
    );
    await expectError(response, 500);
  } finally {
    failInsert.mockRestore();
  }

  expect(
    await listKeys(admin, account.id),
    '收据没写成，刚轮换出的那把必须吊销',
  ).toEqual([]);
});

/**
 * 补充设计（R-032 的缺口）：服务账号的角色就在「应用 API 密钥」页上给。
 *
 * 能进这一页的人（默认只有 root）因此能决定服务账号能做什么，这是一处授权面的扩大；
 * 所以能选的范围不含 root，也不含任何不受限制的权限集。
 */

test('R-032 补充 1: a role assigned here changes what the service account’s already-issued key may do', async ({
  testApp,
  app,
}) => {
  // 全应用只有一个端点接受服务账号的密钥（`/quality/intake`），seed 的四个业务角色
  // 都不含投递 —— 投递按 R-013 只给外部渠道。所以这里建一个只含投递的权限集当「业务角色」。
  const authz = authzOf(app);
  const attemptRole = 'r032-roles-intake';
  await authz.permissionSets.create({
    key: attemptRole,
    grants: [intakeGrant],
  });
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const account = await createServiceAccount(admin, 'R032 角色生效');
  // 密钥先签发，角色后给：授权每次请求都重新解析，不需要重签。
  const issued = await issueKey(admin, account.id);

  const intake = () =>
    testApp.request('/quality/intake', {
      method: 'POST',
      headers: apiKeyHeaders(issued.secret),
      body: JSON.stringify(intakeBody('分配角色前后')),
    });

  await expectAuthorizationDenied(await intake(), '分配角色前的密钥');
  expect(
    (await rolesOf(admin, account.id)).roles,
    '刚建的服务账号一个权限集都没有',
  ).toEqual([]);

  const assigned = await replaceRoles(admin, account.id, [attemptRole]);
  expect(assigned.roles, '分配后要回这个服务账号持有的权限集').toEqual([
    { key: attemptRole, title: null },
  ]);

  const accepted = await intake();
  const text = await accepted.text();
  expect(accepted.status, `${text}`).toBe(201);

  const cleared = await replaceRoles(admin, account.id, []);
  expect(cleared.roles, '空数组表示一个都不给').toEqual([]);
  await expectAuthorizationDenied(await intake(), '撤掉角色后的密钥');
});

test('R-032 补充 2: root and any other unrestricted Permission Set can never be given out', async ({
  testApp,
  app,
}) => {
  const authz = authzOf(app);
  // root 之外的另一个不受限制的权限集：禁的是这一整类，不是认死键名。
  const unrestricted = 'r032-unrestricted';
  await authz.permissionSets.create({ key: unrestricted, grants: [] });
  const release = authz.permissionSets.protect({
    owner: 'r032-test',
    keys: [unrestricted],
    unrestricted: true,
    assignableTo: ['user'],
  });

  try {
    const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
    const account = await createServiceAccount(admin, 'R032 不给 root');

    const options = (await rolesOf(admin, account.id)).options;
    const optionKeys = options.map((option) => option.key);
    expect(optionKeys, '可选项里不该有 root').not.toContain('root');
    expect(
      optionKeys,
      '可选项里不该有别的受限制为「不受限制」的权限集',
    ).not.toContain(unrestricted);
    expect(optionKeys, '可选项不是空清单：业务角色应当在里面').toContain(
      'quality_manager',
    );
    expect(
      options.find((option) => option.key === 'quality_manager')?.title,
      '名称照库里存的形状给，页面自己翻译',
    ).toEqual({
      key: 'permissionSets.business.qualityManager',
      ns: 'app-local',
    });

    for (const keys of [
      ['root'],
      [unrestricted],
      // 整份校验：混进一个好的一起提交，也一样一个都不改。
      ['quality_manager', 'root'],
    ]) {
      const error = await expectError(
        await admin.fetch(rolesPath(account.id), json({ keys }, 'PUT')),
        422,
      );
      expect(error.status, `${keys.join(',')} 应当是 FAILED_PRECONDITION`).toBe(
        'FAILED_PRECONDITION',
      );
      expect(error.reason).toBe('PERMISSION_SET_NOT_ASSIGNABLE');
    }

    expect(
      await permissionSetsOf(authz, account.id),
      '被拒的替换一个权限集都没给出去',
    ).toEqual([]);
    expect((await rolesOf(admin, account.id)).roles).toEqual([]);
  } finally {
    release();
  }
});

test('R-032 补充 3: a real user is not a service account, so both role endpoints answer 404', async ({
  testApp,
  app,
}) => {
  const authz = authzOf(app);
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const person = await createUser(admin, 'r032rolesperson', { app: ['staff'] });
  const before = await permissionSetsOf(authz, person.id);
  expect(before).toEqual(['staff']);

  const listed = await admin.fetch(rolesPath(person.id));
  expect((await expectError(listed, 404)).status).toBe('NOT_FOUND');

  const replaced = await admin.fetch(
    rolesPath(person.id),
    json({ keys: ['quality_manager'] }, 'PUT'),
  );
  expect((await expectError(replaced, 404)).status).toBe('NOT_FOUND');

  expect(
    await permissionSetsOf(authz, person.id),
    '对真人调用什么都不改',
  ).toEqual(before);
});

test('R-032 补充 4: both role endpoints need the page grant and a sign-in session', async ({
  testApp,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const account = await createServiceAccount(admin, 'R032 角色受保护');
  const issued = await issueKey(admin, account.id);
  const path = rolesPath(account.id);
  const writes = [
    ['列出角色', undefined],
    ['调整角色', json({ keys: [] }, 'PUT')],
  ] as const;

  await createUser(admin, 'r032rolesnongrant', { app: [] });
  const nobody = await signInAs(testApp, 'r032rolesnongrant');
  for (const [what, init] of writes) {
    await expectAuthorizationDenied(
      await nobody.fetch(path, init as RequestInit | undefined),
      what,
    );
  }

  // 密钥（含服务账号自己的）不能管角色：管理只能从登录会话发起。
  for (const [what, init] of writes) {
    const response = await testApp.request(path, {
      ...init,
      headers: {
        ...(init?.headers as Record<string, string>),
        ...apiKeyHeaders(issued.secret),
      },
    });
    const error = await expectError(response, 403);
    expect(error.status, `${what} 应当是 PERMISSION_DENIED`).toBe(
      'PERMISSION_DENIED',
    );
  }

  expect((await rolesOf(admin, account.id)).roles).toEqual([]);

  // 写操作带 Idempotency-Key：没有就 400。
  const missing = await admin.fetch(path, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', origin: 'http://localhost' },
    body: JSON.stringify({ keys: [] }),
  });
  expect((await expectError(missing, 400)).reason).toBe(
    'OPERATION_KEY_REQUIRED',
  );
});

test('R-032 补充: a role write replays its receipt instead of replacing twice', async ({
  testApp,
  app,
}) => {
  const authz = authzOf(app);
  const role = 'r032-roles-replay';
  await authz.permissionSets.create({ key: role, grants: [intakeGrant] });
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const account = await createServiceAccount(admin, 'R032 角色幂等');

  const key = operationKey();
  const first = await replaceRoles(admin, account.id, [role], key);
  const replay = await admin.fetch(
    rolesPath(account.id),
    json({ keys: [role] }, 'PUT', key),
  );
  expect(replay.status).toBe(200);
  expect(replay.headers.get('Idempotency-Replayed')).toBe('true');
  expect(await replay.json()).toEqual({ data: first });

  // 同一个键换了入参：拒绝，不执行。
  const conflict = await admin.fetch(
    rolesPath(account.id),
    json({ keys: [] }, 'PUT', key),
  );
  expect((await expectError(conflict, 409)).reason).toBe('OPERATION_CONFLICT');
  expect(await permissionSetsOf(authz, account.id)).toEqual([role]);
});
