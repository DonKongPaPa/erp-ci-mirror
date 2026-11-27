// @vitest-environment node
import { randomUUID } from 'node:crypto';

import {
  DEFAULT_ADMIN_CREDENTIALS,
  signIn,
  type TestSession,
} from '@nocobase/app-plugin-authentication/testing';
import type { DatabaseConnection } from '@nocobase/db';
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

/* -------------------------------------------------------------------------- */
/* R-014 复刻波 0 加片：往来单位补字段                                        */
/* -------------------------------------------------------------------------- */

/** 编造的字典条目；status=inactive 用来走拒绝路径。 */
const makeDictEntry = async (
  connection: DatabaseConnection,
  dictType: string,
  code: string,
  status: 'active' | 'inactive' = 'active',
): Promise<void> => {
  await connection.repository<Row>('bizDictEntries').createOne({
    values: {
      id: randomUUID(),
      dictType,
      code,
      name: `测试${code}`,
      rate: null,
      startDate: null,
      endDate: null,
      description: null,
      isDefault: false,
      sort: 0,
      status,
      createdById: 'test',
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  });
};

/** 编造的用户与员工档案：姓名只用于回显断言，不含真实人员信息。 */
const makeEmployee = async (
  admin: TestSession,
  testApp: Parameters<typeof signIn>[0],
  connection: DatabaseConnection,
  prefix: string,
  status: 'active' | 'left',
): Promise<{ userId: string; name: string }> => {
  const username = unique(prefix);
  const name = `测试人员${prefix}`;
  const created = await admin.fetch('/users', write({
    name,
    username,
    email: `${username.toLowerCase()}@example.test`,
    password: PASSWORD,
    roleScopes: { app: ['member'] },
  }));
  expect(created.status).toBe(201);
  const userId = String((await jsonOf(created)).data!.id);
  await connection.repository<Row>('employees').createOne({
    values: {
      id: randomUUID(),
      userId,
      employeeNo: `E${randomUUID().replaceAll('-', '').slice(0, 6)}`,
      positionId: null,
      gradeId: null,
      reportsToUserId: null,
      hiredOn: '2026-01-01',
      leftOn: status === 'left' ? '2026-06-01' : null,
      status,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  });
  return { userId, name };
};

const makeRoleUser = async (
  admin: TestSession,
  testApp: Parameters<typeof signIn>[0],
  prefix: string,
  role: string,
): Promise<TestSession> => {
  const username = unique(prefix);
  const created = await admin.fetch('/users', write({
    name: `测试${prefix}`,
    username,
    email: `${username.toLowerCase()}@example.test`,
    password: PASSWORD,
    roleScopes: { app: [role] },
  }));
  expect(created.status).toBe(201);
  return await signIn(testApp, { username, password: PASSWORD });
};

const dictCode = (prefix: string): string =>
  `${prefix}${unique('').replaceAll('-', '').slice(0, 6)}`;

const stringsOf = (value: unknown): string[] => {
  if (Array.isArray(value)) return value.flatMap(stringsOf);
  if (value !== null && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).flatMap(stringsOf);
  }
  return typeof value === 'string' ? [value] : [];
};

test('R-014 加片: 采购建供应商带新列读回同值，buyer 只有 userId 与 name', async ({
  testApp,
  connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const purchase = await makeRoleUser(admin, testApp, 'r014ap', 'purchase');
  const groupCode = dictCode('SG');
  await makeDictEntry(connection, 'supplier_group', groupCode);
  const buyer = await makeEmployee(admin, testApp, connection, 'apbuyer', 'active');

  const response = await purchase.fetch('/partners', write({
    name: unique('供应商'),
    isSupplier: true,
    supplierGroupCode: groupCode,
    buyerUserId: buyer.userId,
    payeeAccountNo: 'ACC0001',
    payeeBankName: '测试银行',
    payeeBankCode: 'AB12CD34',
  }));
  if (response.status !== 201) {
    throw new Error(`建供应商失败：${response.status} ${await response.text()}`);
  }
  const created = await jsonOf(response);
  const detail = await jsonOf(
    await purchase.fetch(`/partners/${String(created.id)}`, get()),
  );
  expect(detail).toMatchObject({
    supplierGroupCode: groupCode,
    payeeAccountNo: 'ACC0001',
    payeeBankName: '测试银行',
    payeeBankCode: 'AB12CD34',
    buyer: { userId: buyer.userId, name: buyer.name },
  });
  expect(Object.keys(detail.buyer as Row).sort()).toEqual(['name', 'userId']);
  expect(detail).not.toHaveProperty('salesperson');
  expect(detail).not.toHaveProperty('customerGroupCode');
  const stored = await connection
    .repository<Row>('partners')
    .findOne({ filter: { id: String(created.id) } });
  expect(stored?.buyerUserId).toBe(buyer.userId);
  expect(stored?.supplierGroupCode).toBe(groupCode);
});

test('R-014 加片: 两条交货地址、默认切换、停用仍回、没有删除端点', async ({
  testApp,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const sales = await makeRoleUser(admin, testApp, 'r014addr', 'sales');
  const customer = await create(admin, unique('客户'), { isCustomer: true });
  const id = String(customer.id);

  const firstResponse = await sales.fetch(
    `/partners/${id}/addresses`,
    write({ address: '交货地址甲' }),
  );
  if (firstResponse.status !== 201) {
    throw new Error(`加地址失败：${firstResponse.status} ${await firstResponse.text()}`);
  }
  const first = await jsonOf(firstResponse);
  expect(first).toMatchObject({
    partnerId: id,
    address: '交货地址甲',
    isDefault: false,
    status: 'active',
  });

  const secondResponse = await sales.fetch(
    `/partners/${id}/addresses`,
    write({ address: '交货地址乙', isDefault: true }),
  );
  expect(secondResponse.status).toBe(201);
  const second = await jsonOf(secondResponse);
  expect(second.isDefault).toBe(true);

  const detail = await jsonOf(await sales.fetch(`/partners/${id}`, get()));
  const addresses = detail.addresses as Row[];
  expect(addresses).toHaveLength(2);
  // 默认地址在前，其余按 id 升序；第二条被设为默认后第一条已不是默认。
  expect(addresses.map((row) => row.address)).toEqual(['交货地址乙', '交货地址甲']);
  expect(addresses[1]?.isDefault).toBe(false);

  const off = await sales.fetch(
    `/partners/${id}/addresses/${String(first.id)}`,
    write({ status: 'inactive' }, 'PATCH'),
  );
  expect(off.status).toBe(200);
  expect(await jsonOf(off)).toMatchObject({ status: 'inactive' });
  const after = await jsonOf(await sales.fetch(`/partners/${id}`, get()));
  expect(
    (after.addresses as Row[]).map((row) => [row.address, row.status]),
  ).toContainEqual(['交货地址甲', 'inactive']);

  const removed = await sales.fetch(
    `/partners/${id}/addresses/${String(first.id)}`,
    { method: 'DELETE', headers: { origin: ORIGIN } },
  );
  expect([404, 405]).toContain(removed.status);
});

test('R-014 加片: 没有地址的客户详情回空 addresses，采购侧仍没有这个键', async ({
  testApp,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const sales = await makeRoleUser(admin, testApp, 'r014emptyaddr', 'sales');
  const purchase = await makeRoleUser(admin, testApp, 'r014noaddr', 'purchase');
  const customer = await create(admin, unique('无地址客户'), { isCustomer: true });
  const both = await create(admin, unique('无地址双向'), {
    isCustomer: true,
    isSupplier: true,
  });

  // 客户侧：无论是不是双向单位，没有地址也必须给出空数组而不是省略键。
  const customerDetail = await jsonOf(
    await sales.fetch(`/partners/${String(customer.id)}`, get()),
  );
  expect(customerDetail).toHaveProperty('addresses', []);
  const bothSales = await jsonOf(
    await sales.fetch(`/partners/${String(both.id)}`, get()),
  );
  expect(bothSales).toHaveProperty('addresses', []);

  // 采购侧读同一家双向单位：反向断言不许放宽，依然没有 addresses 键。
  const bothPurchase = await jsonOf(
    await purchase.fetch(`/partners/${String(both.id)}`, get()),
  );
  expect(bothPurchase).not.toHaveProperty('addresses');
});

test('R-014 加片: 停用分组、离职员工、停用单位都被拒', async ({
  testApp,
  connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const inactiveGroup = dictCode('CGX');
  await makeDictEntry(connection, 'customer_group', inactiveGroup, 'inactive');
  const left = await makeEmployee(admin, testApp, connection, 'apleft', 'left');

  const badGroup = await admin.fetch('/partners', write({
    name: unique('坏分组'),
    isCustomer: true,
    customerGroupCode: inactiveGroup,
  }));
  expect(badGroup.status).toBe(422);
  expect((await jsonOf(badGroup)).error?.reason).toBe('PARTNER_DICT_CODE_INVALID');

  const badPerson = await admin.fetch('/partners', write({
    name: unique('坏销售员'),
    isCustomer: true,
    salespersonUserId: left.userId,
  }));
  expect(badPerson.status).toBe(422);
  expect((await jsonOf(badPerson)).error?.reason).toBe('PARTNER_PERSON_INVALID');

  const partner = await create(admin, unique('停用加地址'), { isCustomer: true });
  const id = String(partner.id);
  const off = await admin.fetch(`/partners/${id}`, write({ status: 'inactive' }, 'PATCH'));
  expect(off.status).toBe(200);
  const address = await admin.fetch(
    `/partners/${id}/addresses`,
    write({ address: '不该建成' }),
  );
  expect(address.status).toBe(422);
  // 既有 reasonOf 对 partner-inactive 会产生重复前缀；按既有行为钉住，不借加片改动它。
  expect((await jsonOf(address)).error?.reason).toBe('PARTNER_PARTNER_INACTIVE');
});

test('R-014 加片: 两侧越权——销售改不动收款列，采购读不到客户列（反向断言）', async ({
  testApp,
  connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const sales = await makeRoleUser(admin, testApp, 'r014xs', 'sales');
  const purchase = await makeRoleUser(admin, testApp, 'r014cg', 'purchase');
  const groupCode = dictCode('CG');
  await makeDictEntry(connection, 'customer_group', groupCode);
  const person = await makeEmployee(admin, testApp, connection, 'apsales', 'active');
  const both = await create(admin, unique('两者'), {
    isCustomer: true,
    isSupplier: true,
    customerGroupCode: groupCode,
    salespersonUserId: person.userId,
  });
  const id = String(both.id);

  // 前置条件：客户侧数据确实存在，采购侧收款列确实写进去过。
  const seedPatch = await admin.fetch(
    `/partners/${id}`,
    write({ payeeAccountNo: 'ACC77' }, 'PATCH'),
  );
  if (seedPatch.status !== 200) {
    throw new Error(`写入收款列失败：${seedPatch.status} ${await seedPatch.text()}`);
  }
  expect(await jsonOf(seedPatch)).toMatchObject({ payeeAccountNo: 'ACC77' });
  await sales.fetch(`/partners/${id}/addresses`, write({ address: '交货地址丙' }));

  const salesPatchResponse = await sales.fetch(
    `/partners/${id}`,
    write({ payeeAccountNo: 'HACK99' }, 'PATCH'),
  );
  expect(salesPatchResponse.status).toBe(200);
  const salesPatch = await jsonOf(salesPatchResponse);
  expect(salesPatch, '销售响应不该有 payeeAccountNo').not.toHaveProperty('payeeAccountNo');
  const stored = await connection
    .repository<Row>('partners')
    .findOne({ filter: { id } });
  expect(stored?.payeeAccountNo, '库里的收款账户不该被销售改动').toBe('ACC77');

  const purchaseDetail = await jsonOf(await purchase.fetch(`/partners/${id}`, get()));
  for (const key of ['customerGroupCode', 'salesperson', 'addresses']) {
    expect(purchaseDetail, `${key} 不该出现在采购的响应里`).not.toHaveProperty(key);
  }
  const salesDetail = await jsonOf(await sales.fetch(`/partners/${id}`, get()));
  expect(salesDetail).toMatchObject({
    customerGroupCode: groupCode,
    salesperson: { userId: person.userId, name: person.name },
  });
  expect((salesDetail.addresses as Row[]).map((row) => row.address)).toContain(
    '交货地址丙',
  );
  expect(salesDetail, '销售响应不该有供应商侧收款列').not.toHaveProperty(
    'payeeAccountNo',
  );
});

test('R-014 加片: 销售与采购会话的响应里没有邮箱或手机号格式的值', async ({
  testApp,
  connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const sales = await makeRoleUser(admin, testApp, 'r014sp', 'sales');
  const purchase = await makeRoleUser(admin, testApp, 'r014leak', 'purchase');
  const salesGroup = dictCode('CG');
  const purchaseGroup = dictCode('SG');
  await makeDictEntry(connection, 'customer_group', salesGroup);
  await makeDictEntry(connection, 'supplier_group', purchaseGroup);
  const seller = await makeEmployee(admin, testApp, connection, 'apseller', 'active');
  const buyer = await makeEmployee(admin, testApp, connection, 'apbuyer2', 'active');
  const both = await create(admin, unique('两者'), {
    isCustomer: true,
    isSupplier: true,
    customerGroupCode: salesGroup,
    supplierGroupCode: purchaseGroup,
    salespersonUserId: seller.userId,
    buyerUserId: buyer.userId,
  });
  const id = String(both.id);

  const responses = [
    await jsonOf(await sales.fetch('/partners', get())),
    await jsonOf(await sales.fetch(`/partners/${id}`, get())),
    await jsonOf(await purchase.fetch('/partners', get())),
    await jsonOf(await purchase.fetch(`/partners/${id}`, get())),
  ];
  expect((responses[1] as Row).salesperson).toEqual({
    userId: seller.userId,
    name: seller.name,
  });
  expect((responses[3] as Row).buyer).toEqual({
    userId: buyer.userId,
    name: buyer.name,
  });
  for (const value of stringsOf(responses)) {
    expect(/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value), `${value} 不该出现在响应里`).toBe(
      false,
    );
    expect(/^1[3-9]\d{9}$/u.test(value), `${value} 不该出现在响应里`).toBe(false);
  }
});
