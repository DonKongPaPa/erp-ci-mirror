import { randomUUID } from 'node:crypto';

import {
  DEFAULT_ADMIN_CREDENTIALS,
  signIn,
  type TestSession,
} from '@nocobase/app-plugin-authentication/testing';
import { authorizationToken } from '@nocobase/app-plugin-authorization';
import { createAppTest } from '../helpers/test-app.js';
import type { DatabaseConnection } from '@nocobase/db';
import { expect } from 'vitest';

import { createStandaloneServer } from '../../server/standalone.js';

/**
 * R-012 页面那一半：给「加成员」选人用的 `GET /departments/candidates`。
 *
 * 它存在的理由见 R-012「接口契约」的「搜人的端点」：框架自带的用户搜索要「用户 · 读」，
 * 那是 R-028 否决过的宽授权。这里逐条钉住那份契约 —— 只回三列、要 manage、
 * 停用与删除的账户不出现、排除参数生效、`q` 的边界、分页的默认值与上限。
 *
 * 没有 manage 的两种人都要拒：什么授权都没有的账户，以及只有 `departments.view` 的账户。
 */
const test = createAppTest({
  createServer: createStandaloneServer,
  config: {
    app: { publicOrigin: 'http://localhost' },
    auth: { secret: 'test-auth-secret-at-least-32-characters' },
  },
});

const PASSWORD = 'R012-candidates-123!';

interface ApiErrorBody {
  error: {
    code: number;
    status: string;
    reason: string;
    domain: string;
    message: string;
  };
}

interface CandidateRow {
  userId: string;
  name: string | null;
  username: string | null;
}

interface CandidatePage {
  data: CandidateRow[];
  meta: { page: number; pageSize: number; total: number };
}

const json = (body: unknown, method = 'POST') => ({
  method,
  headers: {
    'content-type': 'application/json',
    origin: 'http://localhost',
    'Idempotency-Key': `${Date.now()}.${randomUUID()}`,
  },
  body: JSON.stringify(body),
});

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

/** 每个测试用独立的词根，测试之间共用一个库也不相撞。用户名只接受字母数字。 */
const stem = (): string => randomUUID().replaceAll('-', '').slice(0, 12);

const createUser = async (
  admin: TestSession,
  input: {
    name: string;
    username: string;
    roleScopes?: Record<string, string[]>;
  },
): Promise<{ id: string; name: string; username: string }> => {
  const response = await admin.fetch(
    '/users',
    json({
      name: input.name,
      username: input.username,
      email: `${input.username}@example.test`,
      password: PASSWORD,
      roleScopes: input.roleScopes ?? { app: [] },
    }),
  );
  return (
    (await expectJson(response, 201)) as {
      data: { id: string; name: string; username: string };
    }
  ).data;
};

const createDepartment = async (
  admin: TestSession,
  input: Record<string, unknown>,
): Promise<{ id: string; title: string }> => {
  const response = await admin.fetch('/departments', json(input));
  return (
    (await expectJson(response, 201)) as {
      data: { id: string; title: string };
    }
  ).data;
};

const addMembers = async (
  admin: TestSession,
  departmentId: string,
  userIds: readonly string[],
): Promise<void> => {
  await expectJson(
    await admin.fetch(
      `/departments/${departmentId}/members`,
      json({ userIds }),
    ),
    200,
  );
};

const candidates = async (
  session: TestSession,
  query: Record<string, string | number>,
): Promise<CandidatePage> => {
  const search = new URLSearchParams(
    Object.entries(query).map(([key, value]) => [key, String(value)]),
  );
  const body = (await expectJson(
    await session.fetch(`/departments/candidates?${search.toString()}`),
    200,
  )) as CandidatePage;
  return body;
};

test('R-012 candidates 只回标识、姓名、用户名三列，没有邮箱', async ({
  testApp,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const token = stem();
  const alice = await createUser(admin, {
    name: `候选人甲-${token}`,
    username: `candA${token}`,
  });
  const bob = await createUser(admin, {
    name: `候选人乙-${token}`,
    username: `candB${token}`,
  });

  const response = await admin.fetch(
    `/departments/candidates?q=${encodeURIComponent(`-${token}`)}`,
  );
  expect(response.status, `${await response.clone().text()}`).toBe(200);
  const text = await response.text();
  // 邮箱在库里，但绝不能出现在响应里（R-028 的选择性暴露）。
  expect(text).not.toContain('@example.test');
  const body = JSON.parse(text) as CandidatePage;
  expect(new Map(body.data.map((row) => [row.userId, row]))).toEqual(
    new Map([
      [
        alice.id,
        { userId: alice.id, name: alice.name, username: alice.username },
      ],
      [bob.id, { userId: bob.id, name: bob.name, username: bob.username }],
    ]),
  );
  for (const row of body.data) {
    expect(Object.keys(row).sort()).toEqual(['name', 'userId', 'username']);
  }
});

test('R-012 candidates 没有 manage 的人 403：无授权账户与只有 view 的账户', async ({
  testApp,
  app,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const token = stem();
  const plain = await createUser(admin, {
    name: `无授权-${token}`,
    username: `plain${token}`,
  });

  const authz = app.container.resolve(authorizationToken);
  await authz.permissionSets.create({
    key: `r012-candidates-view-${token}`,
    grants: [
      {
        resource: { type: 'composite', id: 'departments' },
        actions: [{ action: 'view' }],
      },
    ],
  });
  const viewer = await createUser(admin, {
    name: `只看-${token}`,
    username: `viewer${token}`,
    roleScopes: { app: [`r012-candidates-view-${token}`] },
  });

  const credentials = (email: string) => ({
    email,
    password: PASSWORD,
  });
  // 无授权的账户
  const plainSession = await signIn(testApp, {
    ...credentials(`${plain.username}@example.test`),
  });
  const denied = await expectError(
    await plainSession.fetch(
      `/departments/candidates?q=${encodeURIComponent(token)}`,
    ),
    403,
  );
  expect(denied.reason, '无授权账户应当以 AUTHORIZATION_DENIED 被拒').toBe(
    'AUTHORIZATION_DENIED',
  );
  // 只有 view、没有 manage 的账户
  const viewerSession = await signIn(testApp, {
    ...credentials(`${viewer.username}@example.test`),
  });
  const alsoDenied = await expectError(
    await viewerSession.fetch(
      `/departments/candidates?q=${encodeURIComponent(token)}`,
    ),
    403,
  );
  expect(alsoDenied.reason, '只有 view 的账户也不能用搜人端点').toBe(
    'AUTHORIZATION_DENIED',
  );
});

test('R-012 candidates 不出现已停用与已删除的账户', async ({
  testApp,
  connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const token = stem();
  const active = await createUser(admin, {
    name: `在职-${token}`,
    username: `active${token}`,
  });
  const disabled = await createUser(admin, {
    name: `停用-${token}`,
    username: `disabled${token}`,
  });
  const deleted = await createUser(admin, {
    name: `删除-${token}`,
    username: `deleted${token}`,
  });
  await markAccount(connection, disabled.id, { disabledAt: new Date() });
  await markAccount(connection, deleted.id, { deletedAt: new Date() });

  const body = await candidates(admin, { q: `-${token}` });
  expect(body.data.map((row) => row.userId)).toEqual([active.id]);
});

test('R-012 candidates 的 excludeDepartmentId 把现有成员排除掉', async ({
  testApp,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const token = stem();
  const department = await createDepartment(admin, {
    title: `候选-${token}`,
    code: `CAND-${token}`,
  });
  const member = await createUser(admin, {
    name: `成员-${token}`,
    username: `member${token}`,
  });
  const other = await createUser(admin, {
    name: `非成员-${token}`,
    username: `other${token}`,
  });
  await addMembers(admin, department.id, [member.id]);

  const all = await candidates(admin, { q: `-${token}` });
  expect(new Set(all.data.map((row) => row.userId))).toEqual(
    new Set([member.id, other.id]),
  );
  const excluded = await candidates(admin, {
    q: `-${token}`,
    excludeDepartmentId: department.id,
  });
  expect(excluded.data.map((row) => row.userId)).toEqual([other.id]);
});

test('R-012 candidates 按姓名与用户名不分大小写模糊匹配', async ({
  testApp,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const token = stem();
  const byName = await createUser(admin, {
    name: `ZhaoMing${token}`,
    username: `zm${token}`,
  });
  const byUsername = await createUser(admin, {
    name: `另一个人-${token}`,
    username: `zhaoming${token}`,
  });

  for (const q of [
    `zhaoming${token}`,
    `ZHAOMING${token}`,
    `ZhaoMing${token}`,
  ]) {
    const body = await candidates(admin, { q });
    expect(
      new Set(body.data.map((row) => row.userId)),
      `q=${q} 应当同时按姓名与用户名匹配`,
    ).toEqual(new Set([byName.id, byUsername.id]));
  }
});

test('R-012 candidates 的 q 边界：必填、去空白后 1 到 64 个字符', async ({
  testApp,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const token = stem();
  await createUser(admin, {
    name: `边界-${token}`,
    username: `boundary${token}`,
  });

  for (const query of ['', 'q=', 'q=%20%20%20']) {
    const response = await admin.fetch(
      `/departments/candidates${query ? `?${query}` : ''}`,
    );
    expect(response.status, `缺少或空白的 q 应当 400：?${query}`).toBe(400);
  }
  expect((await candidates(admin, { q: 'a' })).meta.page).toBe(1);
  expect((await candidates(admin, { q: 'a'.repeat(64) })).meta.page).toBe(1);
  expect(
    (await admin.fetch(`/departments/candidates?q=${'a'.repeat(65)}`)).status,
    '65 个字符应当 400',
  ).toBe(400);
});

test('R-012 candidates 分页：默认每页 20，上限 50', async ({ testApp }) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const token = stem();
  for (let index = 0; index < 21; index += 1) {
    await createUser(admin, {
      name: `分页${index}-${token}`,
      username: `page${index}${token}`,
    });
  }

  const first = await candidates(admin, { q: `-${token}` });
  expect(first.meta).toMatchObject({ page: 1, pageSize: 20, total: 21 });
  expect(first.data).toHaveLength(20);
  const second = await candidates(admin, { q: `-${token}`, page: 2 });
  expect(second.data).toHaveLength(1);
  expect(second.meta).toMatchObject({ page: 2, pageSize: 20, total: 21 });

  const capped = await candidates(admin, { q: `-${token}`, pageSize: 50 });
  expect(capped.meta.pageSize).toBe(50);
  expect(
    (await admin.fetch(`/departments/candidates?q=${token}&pageSize=51`))
      .status,
    '超过上限应当 400',
  ).toBe(400);
});

/** 直接改库模拟停用与删除：接口那两条路径不属于本端点的验收范围。 */
async function markAccount(
  connection: DatabaseConnection,
  userId: string,
  values: { disabledAt?: Date; deletedAt?: Date },
): Promise<void> {
  await connection
    .repository<{ id: string }>('user')
    .updateMany({ filter: { id: userId }, values });
}
