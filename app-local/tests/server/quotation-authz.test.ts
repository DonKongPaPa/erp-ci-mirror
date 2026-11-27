// @vitest-environment node
import {
  DEFAULT_ADMIN_CREDENTIALS,
  signIn,
  type TestSession,
} from '@nocobase/app-plugin-authentication/testing';
import { authorizationToken } from '@nocobase/app-plugin-authorization';
import { expect } from 'vitest';

import { createAppTest } from '../helpers/test-app.js';
import { createItem } from '../helpers/inventory.js';
import {
  createEmployee,
  createPartner,
  createWarehouse,
  get,
  jsonOf,
  unique,
  write,
} from '../helpers/orders.js';
import { upgradeR022Quotation } from '../../cli/authz/upgrade-r022-quotation.js';
import { createStandaloneServer } from '../../server/standalone.js';

/**
 * R-022 复刻波 1 授权：六个动作只给 sales 与 root；别的角色 403 且先授权后读内容；
 * 升级命令只补 sales，重跑不写，别角色与既有 viewPrice 不动。
 */
const test = createAppTest({
  createServer: createStandaloneServer,
  config: {
    app: { publicOrigin: 'http://localhost' },
    auth: { secret: 'test-auth-secret-at-least-32-characters' },
  },
});

const TIMEOUT = 30_000;
const PASSWORD = 'R022-qauthz-123!';

async function makeUser(
  admin: TestSession,
  testApp: Parameters<typeof signIn>[0],
  prefix: string,
  roles: readonly string[],
  employeeConnection?: Parameters<typeof createEmployee>[0],
): Promise<TestSession> {
  const username = unique(prefix);
  const created = await admin.fetch('/users', write({
    name: username, username, email: `${username.toLowerCase()}@example.test`,
    password: PASSWORD, roleScopes: { app: [...roles] },
  }));
  expect(created.status).toBe(201);
  const userId = String((await jsonOf(created)).data?.id);
  // 转单复用销售订单的建单校验：经办人要是在职员工。
  if (employeeConnection !== undefined) await createEmployee(employeeConnection, userId);
  return await signIn(testApp, { username, password: PASSWORD });
}

test('sales 六个动作七条端点都可用；没有删除路由', async ({ testApp, connection }) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const seller = await makeUser(admin, testApp, 'r022qseller', ['sales'], connection);
  const item = await createItem(connection);
  const customer = await createPartner(admin, { isCustomer: true });
  const warehouse = await createWarehouse(admin);
  const body = {
    customerId: customer.id, quoteDate: '2026-11-27', warehouseId: warehouse.id,
    lines: [{ itemId: item, qty: 2, price: 113, taxRate: 13 }],
  };
  const created = await seller.fetch('/quotations', write(body));
  expect(created.status, `建报价单失败：${await created.clone().text()}`).toBe(201);
  const id = String((await jsonOf(created)).id);
  expect((await seller.fetch('/quotations', get())).status).toBe(200);
  expect((await seller.fetch(`/quotations/${id}`, get())).status).toBe(200);
  expect((await seller.fetch(`/quotations/${id}`, write({ contactName: '改' }, 'PATCH'))).status).toBe(200);
  expect((await seller.fetch(`/quotations/${id}/confirm`, write())).status).toBe(200);
  expect((await seller.fetch(`/quotations/${id}/create-sales-order`, write())).status).toBe(200);
  const other = await jsonOf(await seller.fetch('/quotations', write({ ...body, lines: [{ itemId: item, qty: 1 }] })));
  expect((await seller.fetch(`/quotations/${String(other.id)}/void`, write())).status).toBe(200);
  const removed = await seller.fetch(`/quotations/${id}`, {
    method: 'DELETE', headers: { origin: 'http://localhost' },
  });
  expect([404, 405]).toContain(removed.status);
}, TIMEOUT);

test('仓管/采购/财务/员工/质量主管/无角色对报价端点全部 403，非法内容也先 403', async ({
  testApp, connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const item = await createItem(connection);
  const customer = await createPartner(admin, { isCustomer: true });
  const quote = await jsonOf(await admin.fetch('/quotations', write({
    customerId: customer.id, quoteDate: '2026-11-27',
    lines: [{ itemId: item, qty: 1 }],
  })));
  const id = String(quote.id);
  const outsiders = await Promise.all([
    makeUser(admin, testApp, 'r022qwh', ['warehouse']),
    makeUser(admin, testApp, 'r022qpu', ['purchase']),
    makeUser(admin, testApp, 'r022qfi', ['finance']),
    makeUser(admin, testApp, 'r022qst', ['staff']),
    makeUser(admin, testApp, 'r022qqm', ['quality_manager']),
    makeUser(admin, testApp, 'r022qno', []),
  ]);
  const calls: readonly [string, RequestInit][] = [
    ['/quotations', get()],
    [`/quotations/${id}`, get()],
    // 内容非法（有效期倒挂、空明细）：仍须先被授权拒绝，不泄露业务规则码。
    ['/quotations', write({
      customerId: customer.id, quoteDate: '2026-11-27', validUntil: '2026-01-01', lines: [],
    })],
    [`/quotations/${id}`, write({ contactName: '改' }, 'PATCH')],
    [`/quotations/${id}/confirm`, write()],
    [`/quotations/${id}/create-sales-order`, write()],
    [`/quotations/${id}/void`, write()],
  ];
  for (const outsider of outsiders) {
    for (const [path, init] of calls) {
      const response = await outsider.fetch(path, init);
      expect(response.status, `${path} 不该给这个角色`).toBe(403);
    }
  }
}, TIMEOUT);

test('升级命令只给 sales 补六个动作：重跑不写、别角色与 viewPrice 不动', async ({
  app, testApp,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const seller = await makeUser(admin, testApp, 'r022qup', ['sales']);
  const authz = app.container.resolve(authorizationToken);
  const sets = authz.permissionSets;
  const snapshot = Object.fromEntries(
    (await sets.list()).map((set) => [set.key, JSON.stringify(set.grants)]),
  );
  const sales = await sets.get('sales');
  expect(sales, '前置：sales 权限集').toBeDefined();
  const grants = JSON.parse(JSON.stringify(sales!.grants)) as {
    resource: { type: string; id: string };
    actions: { action: string }[];
  }[];
  expect(grants.some((grant) => grant.resource.id === 'quotations'), '前置：seed 已给 sales 报价授权').toBe(true);
  expect(grants.some((grant) => grant.resource.id === 'salesOrders'
    && grant.actions.some((action) => action.action === 'viewPrice')), '前置：sales 已有 viewPrice').toBe(true);
  const without = grants.filter((grant) => grant.resource.id !== 'quotations');
  await sets.update('sales', {
    key: 'sales', ...(sales!.title === undefined ? {} : { title: sales!.title }),
    grants: without as never,
  });
  const strippedRevision = (await sets.get('sales'))?.revision;
  expect((await seller.fetch('/quotations', get())).status, '剥离授权后应 403').toBe(403);

  const report = await upgradeR022Quotation({ authorization: authz }, { info: () => {} });
  expect(report.changed).toEqual(['sales']);
  expect(report.unchanged).toEqual([]);
  expect((await seller.fetch('/quotations', get())).status, '升级后应恢复 200').toBe(200);
  const after = await sets.get('sales');
  expect(after?.revision, '写入要带新的 revision').toBeDefined();
  expect(after?.revision, '升级确实写过一次').not.toBe(strippedRevision);
  const restored = JSON.parse(JSON.stringify(after!.grants)) as typeof grants;
  expect(restored.some((grant) => grant.resource.id === 'quotations')).toBe(true);
  expect(restored.some((grant) => grant.resource.id === 'salesOrders'
    && grant.actions.some((action) => action.action === 'viewPrice'))).toBe(true);

  const again = await upgradeR022Quotation({ authorization: authz }, { info: () => {} });
  expect(again.changed).toEqual([]);
  expect(again.unchanged).toEqual(['sales']);
  expect((await sets.get('sales'))?.revision, '重跑不写，revision 不变').toBe(after?.revision);
  const keys = Object.keys(snapshot).filter((key) => key !== 'sales');
  for (const key of keys) {
    expect(JSON.stringify((await sets.get(key))?.grants), `${key} 不该被动过`).toBe(snapshot[key]);
  }
}, TIMEOUT);
