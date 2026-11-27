// @vitest-environment node
import { randomUUID } from 'node:crypto';

import {
  DEFAULT_ADMIN_CREDENTIALS,
  signIn,
  type TestSession,
} from '@nocobase/app-plugin-authentication/testing';
import { expect } from 'vitest';

import { createAppTest } from '../helpers/test-app.js';
import { createStandaloneServer } from '../../server/standalone.js';

/**
 * R-014 MVP 的六个端点：授权、形状、规则码与暴露面。
 *
 * 每条断言都从真库读回写入结果；无授权的人先被 403 拦下，进不到内容校验。
 * 编码由底座发号器在事务里发，客户 CU、供应商 SU，两者都是用 CU。
 */
const test = createAppTest({
  createServer: createStandaloneServer,
  config: {
    app: { publicOrigin: 'http://localhost' },
    auth: { secret: 'test-auth-secret-at-least-32-characters' },
  },
});

const PASSWORD = 'R014-api-123!';
const ORIGIN = 'http://localhost';
const unique = (prefix: string) =>
  `${prefix}${randomUUID().replaceAll('-', '').slice(0, 8).toUpperCase()}`;
const write = (body: unknown, method = 'POST'): RequestInit => ({
  method,
  headers: {
    'content-type': 'application/json',
    origin: ORIGIN,
    'Idempotency-Key': `${Date.now()}.${randomUUID()}`,
  },
  body: JSON.stringify(body),
});
const get = (): RequestInit => ({ method: 'GET' });

interface Row {
  [key: string]: unknown;
}
type JsonBody = Row & {
  data?: Row;
  items?: Row[];
  contacts?: Row[];
  error?: { reason: string; code?: number };
};
const jsonOf = async (response: Response): Promise<JsonBody> =>
  (await response.json()) as JsonBody;

const create = async (
  session: TestSession,
  name: string,
  extra: Row = {},
): Promise<Row> => {
  const response = await session.fetch('/partners', write({ name, ...extra }));
  if (response.status !== 201) {
    throw new Error(`建往来单位失败：${response.status} ${await response.text()}`);
  }
  return await jsonOf(response);
};

/** 建一个没有任何业务角色的用户，用来验证「先授权后读内容」。 */
const makeOutsider = async (
  admin: TestSession,
  testApp: Parameters<typeof signIn>[0],
  prefix: string,
): Promise<TestSession> => {
  const username = unique(prefix);
  const created = await admin.fetch('/users', write({
    name: username,
    username,
    email: `${username.toLowerCase()}@example.test`,
    password: PASSWORD,
    roleScopes: { app: ['staff'] },
  }));
  expect(created.status).toBe(201);
  return await signIn(testApp, { username, password: PASSWORD });
};

/** 递归收集响应 JSON 的全部键，抓的是字段名不是值。 */
const keysOf = (value: unknown): string[] => {
  if (Array.isArray(value)) return value.flatMap(keysOf);
  if (value !== null && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => [
      key,
      ...keysOf(child),
    ]);
  }
  return [];
};

/** 登录身份与人员标识不进任何读响应；email/phone 是业务联系方式，允许出现。 */
const FORBIDDEN_KEYS = [
  'username',
  'userId',
  'createdById',
  'employeeNo',
  'password',
  'accountId',
];

test('R-014: 客户 CU、供应商 SU、两者都是用 CU；没有删除', async ({ testApp }) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const customer = await create(admin, unique('客户'), { isCustomer: true });
  const supplier = await create(admin, unique('供应商'), { isSupplier: true });
  const both = await create(admin, unique('两者'), {
    isCustomer: true,
    isSupplier: true,
  });
  expect(String(customer.code)).toMatch(/^CU/u);
  expect(String(supplier.code)).toMatch(/^SU/u);
  expect(String(both.code)).toMatch(/^CU/u);
  expect(both.isCustomer).toBe(true);
  expect(both.isSupplier).toBe(true);
  expect(customer.status).toBe('active');

  const removed = await admin.fetch(`/partners/${String(customer.id)}`, {
    method: 'DELETE',
    headers: { origin: ORIGIN },
  });
  expect([404, 405]).toContain(removed.status);
  expect((await admin.fetch(`/partners/${String(customer.id)}`, get())).status).toBe(200);
});

test('R-014: 列表按 kind 过滤、q 匹配、status 筛选与分页；详情带联系人', async ({
  testApp,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const tag = unique('Q');
  const customerName = `客户${tag}`;
  const supplierName = `供应商${tag}`;
  const customer = await create(admin, customerName, { isCustomer: true });
  const supplier = await create(admin, supplierName, { isSupplier: true });

  const customers = await jsonOf(
    await admin.fetch(`/partners?kind=customer&q=${encodeURIComponent(tag)}`, get()),
  );
  const ids = (customers.items ?? []).map((row) => String(row.id));
  expect(ids).toContain(String(customer.id));
  expect(ids).not.toContain(String(supplier.id));
  expect(customers).toMatchObject({ page: 1, pageSize: 20 });

  const suppliers = await jsonOf(
    await admin.fetch(`/partners?kind=supplier&q=${encodeURIComponent(tag)}`, get()),
  );
  const supplierIds = (suppliers.items ?? []).map((row) => String(row.id));
  expect(supplierIds).toContain(String(supplier.id));
  expect(supplierIds).not.toContain(String(customer.id));

  const contactResponse = await admin.fetch(
    `/partners/${String(customer.id)}/contacts`,
    write({ name: '联系人甲', title: '经理', isPrimary: true }),
  );
  if (contactResponse.status !== 200) {
    throw new Error(`加联系人失败：${contactResponse.status} ${await contactResponse.text()}`);
  }
  const contact = await jsonOf(contactResponse);
  expect(contact).toMatchObject({ name: '联系人甲', isPrimary: true });

  const detail = await jsonOf(
    await admin.fetch(`/partners/${String(customer.id)}`, get()),
  );
  expect(detail).toMatchObject({ id: String(customer.id), name: customerName });
  expect((detail.contacts ?? []).map((row) => String(row.name))).toContain('联系人甲');

  const contactId = String(contact.id);
  const patchedContact = await admin.fetch(
    `/partners/${String(customer.id)}/contacts/${contactId}`,
    write({ title: '总监', isPrimary: false }, 'PATCH'),
  );
  expect(patchedContact.status).toBe(200);
  expect(await jsonOf(patchedContact)).toMatchObject({ title: '总监', isPrimary: false });
});

test('R-014: 停用与启用、规则码、未授权先于内容校验', async ({
  testApp,
  connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const outsider = await makeOutsider(admin, testApp, 'r014out');

  // 未授权的人发一个「至少一个标志必填」的坏请求，先得到 403，不是 422。
  const denied = await outsider.fetch('/partners', write({ name: unique('坏') }));
  expect(denied.status).toBe(403);
  expect((await jsonOf(denied)).error?.reason).not.toBe('PARTNER_KIND_REQUIRED');

  // 两个标志都不给：422 + 明确规则码。
  const missingKind = await admin.fetch('/partners', write({ name: unique('无类') }));
  expect(missingKind.status).toBe(422);
  expect((await jsonOf(missingKind)).error?.reason).toBe('PARTNER_KIND_REQUIRED');

  const partner = await create(admin, unique('停用'), { isCustomer: true });
  const id = String(partner.id);
  const deactivated = await admin.fetch(
    `/partners/${id}`,
    write({ status: 'inactive' }, 'PATCH'),
  );
  expect(deactivated.status).toBe(200);
  expect(await jsonOf(deactivated)).toMatchObject({ status: 'inactive' });
  expect((await admin.fetch(`/partners?status=inactive`, get())).status).toBe(200);
  const inactiveList = await jsonOf(
    await admin.fetch(
      `/partners?status=inactive&q=${encodeURIComponent(String(partner.name))}`,
      get(),
    ),
  );
  expect((inactiveList.items ?? []).map((row) => String(row.id))).toContain(id);

  const activated = await admin.fetch(
    `/partners/${id}`,
    write({ status: 'active' }, 'PATCH'),
  );
  expect(activated.status).toBe(200);
  expect(await jsonOf(activated)).toMatchObject({ status: 'active' });
  expect(
    await connection.repository<Row>('partners').count({ filter: { id } }),
  ).toBe(1);
});

test('R-014: 任何响应都不回登录账号、用户名与建单人标识', async ({ testApp }) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const partner = await create(admin, unique('暴露'), { isSupplier: true });
  await admin.fetch(`/partners/${String(partner.id)}/contacts`, write({ name: '联系人乙' }));
  const responses = [
    partner,
    await jsonOf(await admin.fetch('/partners', get())),
    await jsonOf(await admin.fetch(`/partners/${String(partner.id)}`, get())),
  ];
  const keys = keysOf(responses);
  for (const forbidden of FORBIDDEN_KEYS) {
    expect(keys, `${forbidden} 不该出现在响应里`).not.toContain(forbidden);
  }
  const text = JSON.stringify(responses);
  for (const secret of [
    DEFAULT_ADMIN_CREDENTIALS.username,
    DEFAULT_ADMIN_CREDENTIALS.email,
  ]) {
    expect(text.includes(secret), `${secret} 不该出现在响应里`).toBe(false);
  }
});
