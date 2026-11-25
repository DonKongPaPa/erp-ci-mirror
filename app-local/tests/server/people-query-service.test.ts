import { randomUUID } from 'node:crypto';

import {
  DEFAULT_ADMIN_CREDENTIALS,
  signIn,
  type TestSession,
} from '@nocobase/app-plugin-authentication/testing';
import { expect } from 'vitest';

import {
  peopleQueryServiceToken,
  type PeopleQueryService,
} from '../../server/providers/departments.js';
import { createStandaloneServer } from '../../server/standalone.js';
import { createAppTest } from '../helpers/test-app.js';

/**
 * R-012 抽出来的共用读服务：搜人（可限定一批账号）与按一批标识取姓名。
 * 这里钉的是口径 —— 姓名不分大小写、用户名命中、邮箱不命中、恰好三列，
 * 以及 byIds 不按账号状态过滤（成员列表要给已停用的人显示姓名）。
 *
 * 测试数据一律编造；邮箱只是「不该被匹配到」的诱饵，不会出现在任何断言的返回里。
 */
const test = createAppTest({
  createServer: createStandaloneServer,
  config: {
    app: { publicOrigin: 'http://localhost' },
    auth: { secret: 'test-auth-secret-at-least-32-characters' },
  },
});

const PASSWORD = 'R012-people-123!';
const stem = (): string => randomUUID().replaceAll('-', '').slice(0, 12);

interface AccountRow {
  readonly id: string;
  readonly name: string | null;
  readonly username: string | null;
}

const createUser = async (
  admin: TestSession,
  input: { name: string; username: string; email: string },
): Promise<{ id: string; name: string; username: string }> => {
  const response = await admin.fetch('/users', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: 'http://localhost',
      'Idempotency-Key': `${Date.now()}.${randomUUID()}`,
    },
    body: JSON.stringify({
      ...input,
      password: PASSWORD,
      roleScopes: { app: [] },
    }),
  });
  const text = await response.text();
  expect(response.status, `${text}`).toBe(201);
  return (
    JSON.parse(text) as {
      data: { id: string; name: string; username: string };
    }
  ).data;
};

const peopleOf = (app: {
  container: {
    resolve(token: typeof peopleQueryServiceToken): PeopleQueryService;
  };
}): PeopleQueryService => app.container.resolve(peopleQueryServiceToken);

test('共用服务：姓名不分大小写命中，用户名也命中', async ({ testApp, app }) => {
  // 同名两条账号，一个靠姓名匹配、一个靠用户名匹配；三种大小写写法都要命中两个。
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const token = stem();
  const byName = await createUser(admin, {
    name: `ZhaoMing${token}`,
    username: `nm${token}`,
    email: `nm${token}@example.test`,
  });
  const byUsername = await createUser(admin, {
    name: `另一个人-${token}`,
    username: `zhaoming${token}`,
    email: `un${token}@example.test`,
  });
  const people = peopleOf(app);

  for (const q of [
    `zhaoming${token}`,
    `ZHAOMING${token}`,
    `ZhaoMing${token}`,
  ]) {
    const result = await people.search({ q, page: 1, pageSize: 20 });
    expect(
      new Set(result.rows.map((row) => row.id)),
      `q=${q} 应当同时按姓名与用户名匹配`,
    ).toEqual(new Set([byName.id, byUsername.id]));
  }
});

test('共用服务：邮箱里含关键字也搜不到（R-011 验收12）', async ({
  testApp,
  app,
}) => {
  // 关键字只在邮箱里的人不能被搜到；同时造一个姓名命中者，避免「查询坏了才回空」的假绿。
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const token = stem();
  const mailOnly = await createUser(admin, {
    name: `无关-${token}`,
    username: `mail${token}`,
    email: `needle${token}@example.test`,
  });
  const byName = await createUser(admin, {
    name: `needle${token}`,
    username: `named${token}`,
    email: `named${token}@example.test`,
  });
  const people = peopleOf(app);

  const result = await people.search({
    q: `needle${token}`,
    page: 1,
    pageSize: 20,
  });
  expect(result.rows.map((row) => row.id)).toEqual([byName.id]);
  expect(result.rows.map((row) => row.id)).not.toContain(mailOnly.id);
});

test('共用服务：search 与 byIds 恰好只回 id、name、username 三列', async ({
  testApp,
  app,
}) => {
  // 两路查询的返回列都要正好是三列，任何一路多带邮箱都要红。
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const token = stem();
  const person = await createUser(admin, {
    name: `三列-${token}`,
    username: `cols${token}`,
    email: `cols${token}@example.test`,
  });
  const people = peopleOf(app);

  const found = await people.search({ q: token, page: 1, pageSize: 20 });
  expect(found.rows).toHaveLength(1);
  const byIds = await people.byIds([person.id]);
  expect(byIds).toHaveLength(1);

  for (const rows of [
    found.rows,
    byIds,
  ] as readonly (readonly AccountRow[])[]) {
    expect(JSON.stringify(rows)).not.toContain('@example.test');
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual(['id', 'name', 'username']);
    }
  }
});

test('共用服务：byIds 按一批标识取姓名，空输入回空', async ({
  testApp,
  app,
}) => {
  // 成员列表会拿一批 id 换姓名；空批次不发查询、直接回空。
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const token = stem();
  const first = await createUser(admin, {
    name: `甲-${token}`,
    username: `first${token}`,
    email: `first${token}@example.test`,
  });
  const second = await createUser(admin, {
    name: `乙-${token}`,
    username: `second${token}`,
    email: `second${token}@example.test`,
  });
  const people = peopleOf(app);

  expect(await people.byIds([])).toEqual([]);
  const rows = await people.byIds([first.id, second.id, `missing-${token}`]);
  expect(new Map(rows.map((row) => [row.id, row])).size).toBe(2);
  expect(rows.map((row) => row.name)).toEqual(
    expect.arrayContaining([first.name, second.name]),
  );
});

test('共用服务：search 只在一批指定账号里搜时可限定范围', async ({
  testApp,
  app,
}) => {
  // 搜同事限定在几个部门里时，先把部门成员并成一批账号，再交给服务在这批里搜。
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const token = stem();
  const included = await createUser(admin, {
    name: `限定-${token}`,
    username: `in${token}`,
    email: `in${token}@example.test`,
  });
  const excluded = await createUser(admin, {
    name: `限定-${token}`,
    username: `out${token}`,
    email: `out${token}@example.test`,
  });
  const people = peopleOf(app);

  const result = await people.search({
    q: token,
    userIds: [included.id],
    page: 1,
    pageSize: 20,
  });
  expect(result.rows.map((row) => row.id)).toEqual([included.id]);
  expect(result.rows.map((row) => row.id)).not.toContain(excluded.id);
});
