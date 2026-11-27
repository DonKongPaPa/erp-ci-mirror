import { randomUUID } from 'node:crypto';

import { authorizationToken } from '@nocobase/app-plugin-authorization';
import type { Application } from '@nocobase/app-server/application';
import type { DatabaseConnection } from '@nocobase/db';
import {
  DEFAULT_ADMIN_CREDENTIALS,
  signIn,
  type TestSession,
} from '@nocobase/app-plugin-authentication/testing';
import { expect } from 'vitest';

import type { TestSession } from '@nocobase/app-plugin-authentication/testing';

/** R-021/R-022 的测试夹具：往来单位、仓库、订单，都是真库里的真行。 */
export interface Row {
  [key: string]: unknown;
}
export type JsonBody = Row & {
  items?: Row[];
  lines?: Row[];
  total?: number;
  error?: { reason: string };
};

export const ORIGIN = 'http://localhost';

export const unique = (prefix: string): string =>
  `${prefix}${randomUUID().replaceAll('-', '').slice(0, 10).toUpperCase()}`;

export const write = (body: unknown = {}, method = 'POST'): RequestInit => ({
  method,
  headers: {
    'content-type': 'application/json',
    origin: ORIGIN,
    'Idempotency-Key': `${Date.now()}.${randomUUID()}`,
  },
  body: JSON.stringify(body),
});

export const get = (): RequestInit => ({ method: 'GET' });

export const jsonOf = async (response: Response): Promise<JsonBody> =>
  (await response.json()) as JsonBody;

export async function createPartner(
  session: TestSession,
  flags: { isCustomer?: boolean; isSupplier?: boolean } = { isSupplier: true },
): Promise<Row> {
  const response = await session.fetch('/partners', write({
    name: unique('往来'),
    ...flags,
  }));
  if (response.status !== 201) {
    throw new Error(`建往来单位失败：${response.status} ${await response.text()}`);
  }
  return await jsonOf(response);
}

export async function createWarehouse(session: TestSession): Promise<Row> {
  const response = await session.fetch('/warehouses', write({
    code: unique('WH'),
    name: '订单测试仓',
  }));
  if (response.status !== 201) {
    throw new Error(`建仓库失败：${response.status} ${await response.text()}`);
  }
  return await jsonOf(response);
}

/** 返回一个默认草稿订单；覆盖字段用 override 传入。 */
export async function createOrder(
  session: TestSession,
  kind: 'purchase' | 'sales',
  override: Row = {},
): Promise<Row> {
  const path = kind === 'purchase' ? '/purchase-orders' : '/sales-orders';
  const partner = await createPartner(session, kind === 'purchase'
    ? { isSupplier: true }
    : { isCustomer: true });
  const body = {
    ...(kind === 'purchase' ? { supplierId: partner.id } : { customerId: partner.id }),
    orderDate: '2026-11-27',
    remark: '订单测试',
    lines: [],
    ...override,
  };
  const response = await session.fetch(path, write(body));
  if (response.status !== 201) {
    throw new Error(`建订单失败：${response.status} ${await response.text()}`);
  }
  return await jsonOf(response);
}

/** R-021/R-022 加片：测试数据一律编造，字典取值不进仓库。 */
export async function createDictEntry(
  connection: DatabaseConnection,
  dictType: string,
  code: string,
  status = 'active',
): Promise<void> {
  const now = new Date();
  await connection.query.insertInto('bizDictEntries').values({
    id: `dict-${randomUUID()}`,
    dictType,
    code,
    name: `测试${code}`,
    isDefault: false,
    sort: 0,
    status,
    createdById: 'orders-test',
    createdAt: now,
    updatedAt: now,
  }).execute();
}

/** 在职/离职员工档案：经办人显式给出时服务端按它校验。 */
export async function createEmployee(
  connection: DatabaseConnection,
  userId: string,
  status: 'active' | 'left' = 'active',
): Promise<void> {
  const now = new Date();
  await connection.query.insertInto('employees').values({
    id: `emp-${randomUUID()}`,
    userId,
    employeeNo: `E${randomUUID().replaceAll('-', '').slice(0, 10).toUpperCase()}`,
    hiredOn: '2020-01-01',
    status,
    createdAt: now,
    updatedAt: now,
  }).execute();
}

export const ROLE_PASSWORD = 'R021-price-test-123!';

/** 造一个只带指定授权的权限集账号，用来做「没有 viewPrice」的反向断言。 */
export async function makeRoleUser(
  admin: TestSession,
  testApp: Parameters<typeof signIn>[0],
  prefix: string,
  grants: readonly { resource: { type: string; id: string }; actions: { action: string }[] }[],
): Promise<{ session: TestSession; id: string }> {
  const app = (testApp as unknown as { application: Application }).application;
  const authz = app.container.resolve(authorizationToken);
  const key = unique(prefix);
  await authz.permissionSets.create({ key, grants: [...grants] });
  const username = unique(prefix);
  const created = await admin.fetch('/users', write({
    name: username,
    username,
    email: `${username.toLowerCase()}@example.test`,
    password: ROLE_PASSWORD,
  }));
  expect(created.status, `建用户失败：${await created.clone().text()}`).toBe(201);
  const body = await jsonOf(created);
  const id = String((body.data as Row | undefined)?.id ?? body.id ?? '');
  expect(id, '建用户响应应当带 id').not.toBe('');
  await authz.permissionSets.assign({
    subject: { type: 'user', id },
    permissionSet: key,
  });
  return { id, session: await signIn(testApp, { username, password: ROLE_PASSWORD }) };
}

/** 管理员会话的用户 id：经办人默认值的对照。 */
export async function adminUserId(testApp: Parameters<typeof signIn>[0]): Promise<string> {
  const session = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const response = await session.fetch('/api/auth/me', get());
  if (response.ok) {
    const body = await jsonOf(response);
    return String((body.data as Row | undefined)?.user?.id ?? (body.data as Row | undefined)?.id ?? body.id ?? '');
  }
  return '';
}
