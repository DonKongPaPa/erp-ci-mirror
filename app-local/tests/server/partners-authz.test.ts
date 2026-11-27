// @vitest-environment node
import { randomUUID } from 'node:crypto';

import {
  DEFAULT_ADMIN_CREDENTIALS,
  signIn,
  type TestSession,
} from '@nocobase/app-plugin-authentication/testing';
import { authorizationToken } from '@nocobase/app-plugin-authorization';
import { expect } from 'vitest';

import { createAppTest } from '../helpers/test-app.js';
import { createStandaloneServer } from '../../server/standalone.js';

/**
 * R-014 MVP 的授权：销售只看/建/改客户，采购只看/建/改供应商，其它角色没有；
 * root 全部。停用与启用都走 PATCH。资源声明逐列收窄，不回建单人标识，不登记删除。
 */
const test = createAppTest({
  createServer: createStandaloneServer,
  config: {
    app: { publicOrigin: 'http://localhost' },
    auth: { secret: 'test-auth-secret-at-least-32-characters' },
  },
});

const PASSWORD = 'R014-authz-123!';
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
const jsonOf = async (response: Response): Promise<Row> => (await response.json()) as Row;

const makeUser = async (
  admin: TestSession,
  testApp: Parameters<typeof signIn>[0],
  prefix: string,
  roles: readonly string[],
): Promise<{ session: TestSession; userId: string }> => {
  const username = unique(prefix);
  const created = await admin.fetch('/users', write({
    name: username,
    username,
    email: `${username.toLowerCase()}@example.test`,
    password: PASSWORD,
    roleScopes: { app: [...roles] },
  }));
  expect(created.status).toBe(201);
  const userId = String((await jsonOf(created)).data!.id);
  return {
    session: await signIn(testApp, { username, password: PASSWORD }),
    userId,
  };
};

const createPartner = async (
  admin: TestSession,
  name: string,
  flags: Row,
): Promise<Row> => {
  const response = await admin.fetch('/partners', write({ name, ...flags }));
  if (response.status !== 201) {
    throw new Error(`建用户失败：${response.status} ${await response.text()}`);
  }
  return await jsonOf(response);
};

const can = (
  app: { container: { resolve(token: typeof authorizationToken): unknown } },
  userId: string,
  resource: string,
  action: string,
): Promise<boolean> => {
  const authz = app.container.resolve(authorizationToken) as {
    for(input: { principal: { type: string; id: string } }): {
      can(request: { resource: { type: string; id: string }; action: string }): Promise<boolean>;
    };
  };
  return authz
    .for({ principal: { type: 'user', id: userId } })
    .can({ resource: { type: 'composite', id: resource }, action });
};

test('R-014: seed 给销售客户、采购供应商；其它角色与 root 的形状', async ({
  app,
  testApp,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const sales = await makeUser(admin, testApp, 'r014sales', ['sales']);
  const purchase = await makeUser(admin, testApp, 'r014buy', ['purchase']);
  const outsider = await makeUser(admin, testApp, 'r014out', ['staff']);

  for (const action of ['view', 'create', 'update'] as const) {
    expect(await can(app, sales.userId, 'customers', action)).toBe(true);
    expect(await can(app, sales.userId, 'suppliers', action)).toBe(false);
    expect(await can(app, purchase.userId, 'suppliers', action)).toBe(true);
    expect(await can(app, purchase.userId, 'customers', action)).toBe(false);
    expect(await can(app, outsider.userId, 'customers', action)).toBe(false);
    expect(await can(app, outsider.userId, 'suppliers', action)).toBe(false);
    expect(await can(app, String(admin.user.id), 'customers', action)).toBe(true);
    expect(await can(app, String(admin.user.id), 'suppliers', action)).toBe(true);
  }
});

test('R-014: 销售读客户读不到供应商，采购反之，其它角色 403', async ({
  testApp,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const sales = await makeUser(admin, testApp, 'r014sales', ['sales']);
  const purchase = await makeUser(admin, testApp, 'r014buy', ['purchase']);
  const outsider = await makeUser(admin, testApp, 'r014out', ['staff']);
  const customer = await createPartner(admin, unique('客户'), { isCustomer: true });
  const supplier = await createPartner(admin, unique('供应商'), { isSupplier: true });

  expect((await sales.session.fetch('/partners?kind=customer', get())).status).toBe(200);
  expect((await sales.session.fetch('/partners?kind=supplier', get())).status).toBe(403);
  expect((await purchase.session.fetch('/partners?kind=supplier', get())).status).toBe(200);
  expect((await purchase.session.fetch('/partners?kind=customer', get())).status).toBe(403);
  for (const session of [outsider.session]) {
    expect((await session.fetch('/partners?kind=customer', get())).status).toBe(403);
    expect((await session.fetch('/partners?kind=supplier', get())).status).toBe(403);
  }

  // 详情：销售读得到客户详情，读供应商详情被拒。
  expect(
    (await sales.session.fetch(`/partners/${String(customer.id)}`, get())).status,
  ).toBe(200);
  expect(
    (await sales.session.fetch(`/partners/${String(supplier.id)}`, get())).status,
  ).toBe(403);
  expect(
    (await purchase.session.fetch(`/partners/${String(supplier.id)}`, get())).status,
  ).toBe(200);
  expect(
    (await purchase.session.fetch(`/partners/${String(customer.id)}`, get())).status,
  ).toBe(403);

  // 建：销售只能建客户，采购只能建供应商。
  const salesCreate = await sales.session.fetch('/partners', write({
    name: unique('销售建'),
    isCustomer: true,
  }));
  expect(salesCreate.status).toBe(201);
  const salesSupplier = await sales.session.fetch('/partners', write({
    name: unique('销售越界'),
    isSupplier: true,
  }));
  expect(salesSupplier.status).toBe(403);
  const purchaseCreate = await purchase.session.fetch('/partners', write({
    name: unique('采购建'),
    isSupplier: true,
  }));
  expect(purchaseCreate.status).toBe(201);
});

test('R-014: 销售可停用/启用客户，采购可停用/启用供应商；写权限逐列收窄', async ({
  testApp,
  app,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const sales = await makeUser(admin, testApp, 'r014sales', ['sales']);
  const purchase = await makeUser(admin, testApp, 'r014buy', ['purchase']);
  const customer = await createPartner(admin, unique('客户'), { isCustomer: true });
  const supplier = await createPartner(admin, unique('供应商'), { isSupplier: true });

  for (const [session, partner] of [
    [sales.session, customer],
    [purchase.session, supplier],
  ] as const) {
    const id = String(partner.id);
    const off = await session.fetch(`/partners/${id}`, write({ status: 'inactive' }, 'PATCH'));
    if (off.status !== 200) {
      throw new Error(`停用失败：${off.status} ${await off.text()}`);
    }
    expect(await jsonOf(off)).toMatchObject({ status: 'inactive' });
    const on = await session.fetch(`/partners/${id}`, write({ status: 'active' }, 'PATCH'));
    expect(on.status).toBe(200);
    expect(await jsonOf(on)).toMatchObject({ status: 'active' });
  }

  // 声明层：两张表都逐列收窄，view 不回建单人，动作清单没有 delete。
  const authz = app.container.resolve(authorizationToken) as {
    database: {
      collections: {
        list(): readonly { name: string; actions: readonly string[] }[];
      };
    };
    compositeResources: {
      getAction(resource: string, action: string): unknown;
    };
  };
  for (const table of ['partners', 'partnerContacts']) {
    const definition = authz.database.collections.list().find((c) => c.name === table);
    expect(definition?.actions, `${table} 动作清单`).toEqual(['read', 'create', 'update']);
  }
  for (const resource of ['customers', 'suppliers']) {
    expect(authz.compositeResources.getAction(resource, 'view')).toBeDefined();
    expect(authz.compositeResources.getAction(resource, 'delete')).toBeUndefined();
  }
});

/* R-014 加片：新表声明与两条地址写端点的授权。 */

test('R-014 加片: partnerAddresses 声明逐列收窄，没有 delete 动作', async ({
  app,
}) => {
  const authz = app.container.resolve(authorizationToken) as {
    database: {
      collections: {
        list(): readonly { name: string; actions: readonly string[] }[];
      };
    };
    compositeResources: {
      getAction(resource: string, action: string): unknown;
    };
  };
  const definition = authz.database.collections
    .list()
    .find((collection) => collection.name === 'partnerAddresses');
  expect(definition, 'partnerAddresses 必须登记进授权表清单').toBeDefined();
  expect(definition?.actions).toEqual(['read', 'create', 'update']);
  for (const resource of ['customers', 'suppliers']) {
    expect(authz.compositeResources.getAction(resource, 'view')).toBeDefined();
    expect(authz.compositeResources.getAction(resource, 'update')).toBeDefined();
    expect(authz.compositeResources.getAction(resource, 'delete')).toBeUndefined();
  }
});

test('R-014 加片: 地址写端点只认客户侧，采购侧与无关角色 403', async ({ testApp }) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const sales = await makeUser(admin, testApp, 'r014asales', ['sales']);
  const purchase = await makeUser(admin, testApp, 'r014abuy', ['purchase']);
  const outsider = await makeUser(admin, testApp, 'r014aout', ['staff']);
  const customer = await createPartner(admin, unique('客户'), { isCustomer: true });
  const supplier = await createPartner(admin, unique('供应商'), { isSupplier: true });
  const customerId = String(customer.id);
  const supplierId = String(supplier.id);

  const add = (session: TestSession, id: string) =>
    session.fetch(`/partners/${id}/addresses`, write({ address: `地址${unique('T')}` }));
  expect((await add(sales.session, customerId)).status).toBe(201);
  expect((await add(sales.session, supplierId)).status).toBe(403);
  // 交货地址是客户侧的数据：只是供应商的单位，采购侧也是 403。
  expect((await add(purchase.session, supplierId)).status).toBe(403);
  expect((await add(purchase.session, customerId)).status).toBe(403);
  expect((await add(outsider.session, customerId)).status).toBe(403);
  expect((await add(outsider.session, supplierId)).status).toBe(403);

  // 既是客户又是供应商的单位：销售能加，采购照样 403（合并前收紧，比设计原文的「所属资源」更窄）。
  const shared = await createPartner(admin, unique('双向'), {
    isCustomer: true,
    isSupplier: true,
  });
  const sharedId = String(shared.id);
  expect((await add(sales.session, sharedId)).status).toBe(201);
  expect((await add(purchase.session, sharedId)).status).toBe(403);

  const customerDetail = await jsonOf(
    await sales.session.fetch(`/partners/${customerId}`, get()),
  );
  const addressId = String((customerDetail.addresses as { id: string }[])[0]?.id);
  expect(addressId).toBeTruthy();
  const patch = await purchase.session.fetch(
    `/partners/${customerId}/addresses/${addressId}`,
    write({ status: 'inactive' }, 'PATCH'),
  );
  expect(patch.status).toBe(403);
  const sharedDetail = await jsonOf(
    await sales.session.fetch(`/partners/${sharedId}`, get()),
  );
  const sharedAddressId = String(
    (sharedDetail.addresses as { id: string }[])[0]?.id,
  );
  expect(sharedAddressId).toBeTruthy();
  const sharedPatch = await purchase.session.fetch(
    `/partners/${sharedId}/addresses/${sharedAddressId}`,
    write({ status: 'inactive' }, 'PATCH'),
  );
  expect(sharedPatch.status).toBe(403);
  const ownPatch = await sales.session.fetch(
    `/partners/${customerId}/addresses/${addressId}`,
    write({ status: 'inactive' }, 'PATCH'),
  );
  expect(ownPatch.status).toBe(200);
});
