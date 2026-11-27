// @vitest-environment node
import { randomUUID } from 'node:crypto';

import {
  DEFAULT_ADMIN_CREDENTIALS,
  signIn,
  type TestSession,
} from '@nocobase/app-plugin-authentication/testing';
import {
  authorizationToken,
  type AppAuthorization,
} from '@nocobase/app-plugin-authorization';
import type { DatabaseConnection } from '@nocobase/db';
import { expect, vi } from 'vitest';

import { createAppTest } from '../helpers/test-app.js';
import { createStandaloneServer } from '../../server/standalone.js';
import AuthzUpgradeR072, {
  upgradeR072,
  type R072UpgradeServices,
} from '../../cli/authz/upgrade-r072.js';
import { bizDictReaderToken } from '../../server/providers/biz-dict.js';
import { employeeServiceToken } from '../../server/providers/employee-service.js';

/**
 * R-072 授权与暴露面（真 Postgres）：采购能读字典与两个选项端点、不能写；staff 全拒；
 * 无授权者带着业务上非法的请求体也先得 403。人员选项每行只有四列 —— q 不按邮箱匹配，
 * 响应里没有邮箱、手机号、工号、用户名，离职员工不在结果里。
 */
const test = createAppTest({
  createServer: createStandaloneServer,
  config: {
    app: { publicOrigin: 'http://localhost' },
    auth: { secret: 'test-auth-secret-at-least-32-characters' },
  },
});

const PASSWORD = 'R072-authz-123!';
const unique = (prefix: string) =>
  `${prefix}${randomUUID().replaceAll('-', '').slice(0, 10)}`;
const write = (body: unknown, method = 'POST'): RequestInit => ({
  method,
  headers: {
    'content-type': 'application/json',
    origin: 'http://localhost',
    'Idempotency-Key': `${Date.now()}.${randomUUID()}`,
  },
  body: JSON.stringify(body),
});
const get = (): RequestInit => ({ method: 'GET' });

interface Row {
  [key: string]: unknown;
}
const jsonOf = async (response: Response): Promise<Row & { error?: { reason: string } }> =>
  (await response.json()) as Row & { error?: { reason: string } };

type TestApp = Parameters<typeof signIn>[0];

async function makeUser(
  admin: TestSession,
  testApp: TestApp,
  prefix: string,
  roles: readonly string[],
  email?: string,
): Promise<{ session: TestSession; userId: string; username: string }> {
  const username = unique(prefix);
  const created = await admin.fetch('/users', write({
    name: username,
    username,
    email: email ?? `${username.toLowerCase()}@example.test`,
    password: PASSWORD,
    roleScopes: { app: [...roles] },
  }));
  expect(created.status, `建用户失败：${await created.clone().text()}`).toBe(201);
  const userId = String(((await jsonOf(created)).data as Row).id);
  return {
    userId,
    username,
    session: await signIn(testApp, { username, password: PASSWORD }),
  };
}

async function linkEmployee(admin: TestSession, userId: string): Promise<void> {
  const response = await admin.fetch(
    '/employees/link',
    write({ userId, hiredOn: '2026-01-01' }),
  );
  expect(response.status, `补档案失败：${await response.clone().text()}`).toBe(201);
}

test('采购：字典与选项端点可读，写字典被拒且先授权后读内容', async ({ testApp }) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const buyer = (await makeUser(admin, testApp, 'r072buyer', ['purchase'])).session;

  for (const path of [
    '/biz-dict/types',
    '/biz-dict/entries?dictType=settlement',
    '/person-options',
    '/department-options',
  ]) {
    const response = await buyer.fetch(path, get());
    expect(response.status, `${path} 应可读`).toBe(200);
  }

  // 请求体在业务上非法（给 settlement 填 rate），但授权在前：403 而不是 422。
  const invalidCreate = await buyer.fetch(
    '/biz-dict/entries',
    write({ dictType: 'settlement', code: unique('ST'), name: '无权建', rate: 13 }),
  );
  expect(invalidCreate.status).toBe(403);
  expect((await jsonOf(invalidCreate)).error?.reason).not.toBe('DICT_FIELD_NOT_APPLICABLE');

  const validCreate = await buyer.fetch(
    '/biz-dict/entries',
    write({ dictType: 'settlement', code: unique('ST'), name: '无权建' }),
  );
  expect(validCreate.status).toBe(403);
  const validPatch = await buyer.fetch(
    '/biz-dict/entries/no-such-id',
    write({ name: '无权改' }, 'PATCH'),
  );
  expect(validPatch.status).toBe(403);
});

test('staff：字典与两个选项端点一律 403，连非法请求也先被授权挡住', async ({ testApp }) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const staff = (await makeUser(admin, testApp, 'r072staff', ['staff'])).session;

  for (const response of [
    await staff.fetch('/biz-dict/types', get()),
    await staff.fetch('/biz-dict/entries?dictType=settlement', get()),
    await staff.fetch('/biz-dict/entries?dictType=bogus', get()),
    await staff.fetch('/person-options', get()),
    await staff.fetch('/department-options', get()),
    await staff.fetch(
      '/biz-dict/entries',
      write({ dictType: 'settlement', code: unique('ST'), name: '无权建', rate: 13 }),
    ),
  ]) {
    expect(response.status, 'staff 这一片不该有任何授权').toBe(403);
    expect((await jsonOf(response)).error?.reason).not.toBe('DICT_TYPE_INVALID');
  }
});

test('先授权后读内容：无授权的请求连取数服务都不调用', async ({ app, testApp }) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const staff = (await makeUser(admin, testApp, 'r072probe', ['staff'])).session;
  const people = app.container.resolve(employeeServiceToken);
  const dictionary = app.container.resolve(bizDictReaderToken);
  const personSpy = vi.spyOn(people, 'activePersonOptions');
  const createSpy = vi.spyOn(dictionary, 'create');
  try {
    expect((await staff.fetch('/person-options', get())).status).toBe(403);
    const created = await staff.fetch(
      '/biz-dict/entries',
      write({ dictType: 'settlement', code: unique('ST'), name: '无权建' }),
    );
    expect(created.status).toBe(403);
    // 只看 403 不够：把授权挪到取数之后，这两个服务就会被调用。
    expect(personSpy, '无授权时不应读人员').not.toHaveBeenCalled();
    expect(createSpy, '无授权时不应写字典').not.toHaveBeenCalled();
  } finally {
    personSpy.mockRestore();
    createSpy.mockRestore();
  }
});

test('人员选项：只有四列，q 不按邮箱匹配，离职员工不在结果里', async ({ testApp }) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const buyer = (await makeUser(admin, testApp, 'r072picker', ['purchase'])).session;

  // 只在邮箱里出现的字，姓名与用户名都不含它。
  const mailOnly = `mailonly${randomUUID().replaceAll('-', '').slice(0, 10)}`;
  const visible = await makeUser(
    admin, testApp, 'r072visible', ['purchase'], `${mailOnly}@example.test`,
  );
  await linkEmployee(admin, visible.userId);
  const gone = await makeUser(admin, testApp, 'r072gone', ['purchase']);
  await linkEmployee(admin, gone.userId);
  const left = await admin.fetch(
    `/employees/${gone.userId}/leave`,
    write({ leftOn: '2026-11-01' }),
  );
  expect([200, 201], `离职失败：${await left.clone().text()}`).toContain(left.status);

  const found = await buyer.fetch(
    `/person-options?q=${encodeURIComponent(visible.username)}`,
    get(),
  );
  expect(found.status).toBe(200);
  const body = await jsonOf(found);
  const rows = (body.items ?? []) as Row[];
  expect(rows).toHaveLength(1);
  const row = rows[0]!;
  expect(row.userId).toBe(visible.userId);
  expect(Object.keys(row).sort()).toEqual([
    'departmentId', 'departmentName', 'name', 'userId',
  ]);
  const text = JSON.stringify(body);
  expect(text.includes(mailOnly)).toBe(false);
  expect(text.includes('@')).toBe(false);

  const byEmail = await buyer.fetch(
    `/person-options?q=${encodeURIComponent(mailOnly)}`,
    get(),
  );
  expect(byEmail.status).toBe(200);
  expect(((await jsonOf(byEmail)).items ?? [])).toHaveLength(0);

  const byLeftName = await buyer.fetch(
    `/person-options?q=${encodeURIComponent(gone.username)}`,
    get(),
  );
  expect(byLeftName.status).toBe(200);
  expect(((await jsonOf(byLeftName)).items ?? [])).toHaveLength(0);

  // 没有授权字段这一层：过宽的分页也不允许。
  const tooBig = await buyer.fetch('/person-options?pageSize=21', get());
  expect(tooBig.status).toBe(400);
});

test('部门选项只回 id 与 name，停用的部门不在结果里', async ({ testApp }) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const buyer = (await makeUser(admin, testApp, 'r072dept', ['purchase'])).session;
  const title = unique('DEPT');
  const created = await admin.fetch(
    '/departments',
    write({ title, code: unique('D'), kind: 'department' }),
  );
  expect(created.status, `建部门失败：${await created.clone().text()}`).toBe(201);
  const id = String(((await jsonOf(created)).data as Row).id);

  const before = await buyer.fetch(
    `/department-options?q=${encodeURIComponent(title)}`,
    get(),
  );
  expect(before.status).toBe(200);
  const rows = ((await jsonOf(before)).items ?? []) as Row[];
  expect(rows.map((row) => String(row.id))).toContain(id);
  for (const row of rows) {
    expect(Object.keys(row).sort()).toEqual(['id', 'name']);
  }

  const deactivated = await admin.fetch(
    `/departments/${id}/deactivate`,
    write({}),
  );
  expect(deactivated.status, `停用失败：${await deactivated.clone().text()}`).toBe(200);
  const after = await buyer.fetch(
    `/department-options?q=${encodeURIComponent(title)}`,
    get(),
  );
  expect(((await jsonOf(after)).items ?? [])).toHaveLength(0);
});

/** 下面两条是升级命令的验收：旧环境补两条读授权，幂等、带 revision、声明不符整条跳过。 */
const UPGRADE_TARGETS = ['purchase', 'sales', 'warehouse'] as const;
const OTHER_ROLES = [
  'staff', 'dept_manager', 'quality_manager', 'quality_inspector', 'member',
] as const;
const NEW_IDS = ['bizDict', 'bizOptions'] as const;

interface JsonGrant {
  resource: { type: string; id: string };
  actions: { action: string }[];
}
interface Snapshot {
  grants: JsonGrant[];
  revision: string;
  title: unknown;
}
const grantsOf = (set: { grants: unknown }): JsonGrant[] =>
  JSON.parse(JSON.stringify(set.grants)) as JsonGrant[];
const snapshotOf = async (authz: AppAuthorization, key: string): Promise<Snapshot> => {
  const set = await authz.permissionSets.get(key);
  if (set === undefined) throw new Error(`permission set ${key} is missing`);
  return { grants: grantsOf(set), revision: set.revision as string, title: set.title };
};
const upgradeServices = (app: {
  container: { resolve(token: typeof authorizationToken): AppAuthorization };
}): R072UpgradeServices => ({ authorization: app.container.resolve(authorizationToken) });

/** 把三个角色的新授权整条删掉，模拟 seed 之前的旧环境（revision 不动）。 */
async function makeOld(
  connection: DatabaseConnection,
  authz: AppAuthorization,
): Promise<void> {
  for (const key of UPGRADE_TARGETS) {
    const set = await authz.permissionSets.get(key);
    if (set === undefined) throw new Error(`permission set ${key} is missing`);
    const next = grantsOf(set).filter(
      (grant) =>
        !(
          grant.resource.type === 'composite' &&
          (NEW_IDS as readonly string[]).includes(grant.resource.id)
        ),
    );
    await connection.query
      .updateTable('authorizationPermissionSets')
      .set({ grants: JSON.stringify(next) })
      .where('key', '=', key)
      .execute();
  }
}

test('升级：三个角色各补两条读授权，原有授权不动；重跑不写；别的角色不动', async ({
  app,
  connection,
}) => {
  const authz = app.container.resolve(authorizationToken);
  await makeOld(connection, authz);
  const before = new Map<string, Snapshot>();
  for (const key of [...UPGRADE_TARGETS, ...OTHER_ROLES]) {
    before.set(key, await snapshotOf(authz, key));
  }

  const lines: string[] = [];
  const report = await upgradeR072(upgradeServices(app), {
    info: (line) => lines.push(line),
  });
  expect(report.changed).toEqual([...UPGRADE_TARGETS]);
  expect(report.unchanged).toEqual([]);
  expect(report.missing).toEqual([]);
  expect(report.invalid).toEqual([]);
  expect(lines.some((line) => line.includes('[r072] purchase before:'))).toBe(true);

  const after = new Map<string, Snapshot>();
  for (const key of [...UPGRADE_TARGETS, ...OTHER_ROLES]) {
    after.set(key, await snapshotOf(authz, key));
  }
  for (const key of UPGRADE_TARGETS) {
    const old = before.get(key)!;
    const now = after.get(key)!;
    expect(now.revision, `${key} 的 revision 应当更新`).not.toBe(old.revision);
    expect(now.grants.slice(0, old.grants.length)).toEqual(old.grants);
    expect(
      now.grants.slice(old.grants.length).map((grant) => grant.resource.id).sort(),
    ).toEqual([...NEW_IDS].sort());
  }
  for (const key of OTHER_ROLES) {
    expect(after.get(key), `${key} 不该被动`).toEqual(before.get(key));
  }
  // 只加不改、不写维护权。
  for (const key of UPGRADE_TARGETS) {
    for (const grant of after.get(key)!.grants.filter((entry) =>
      (NEW_IDS as readonly string[]).includes(entry.resource.id),
    )) {
      expect(grant.actions.map((action) => action.action)).toEqual(['view']);
    }
  }

  const second = await upgradeR072(upgradeServices(app), { info: () => undefined });
  expect(second.changed).toEqual([]);
  expect(second.unchanged).toEqual([...UPGRADE_TARGETS]);
  for (const key of [...UPGRADE_TARGETS, ...OTHER_ROLES]) {
    expect(await snapshotOf(authz, key), `${key} 重跑不该变化`).toEqual(after.get(key));
  }
});

test('升级：声明对不上时整条跳过、不写库', async ({ app, connection }) => {
  const authz = app.container.resolve(authorizationToken);
  await makeOld(connection, authz);
  const before = new Map<string, Snapshot>();
  for (const key of UPGRADE_TARGETS) before.set(key, await snapshotOf(authz, key));

  const real = authz.compositeResources.getAction.bind(authz.compositeResources);
  const spy = vi
    .spyOn(authz.compositeResources, 'getAction')
    .mockImplementation((id, action) =>
      id === 'bizDict' && action === 'view' ? undefined : real(id, action),
    );
  try {
    const report = await upgradeR072(upgradeServices(app), { info: () => undefined });
    expect(report.invalid).toEqual([...UPGRADE_TARGETS]);
    expect(report.changed).toEqual([]);
    for (const key of UPGRADE_TARGETS) {
      expect(await snapshotOf(authz, key), `${key} 不该被写`).toEqual(before.get(key));
    }
  } finally {
    spy.mockRestore();
  }
  expect(AuthzUpgradeR072.summary).toContain('purchase');
  expect(AuthzUpgradeR072.description).toContain('bizDict.view');
});
