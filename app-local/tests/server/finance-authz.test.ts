// @vitest-environment node
import {
  DEFAULT_ADMIN_CREDENTIALS,
  signIn,
  type TestSession,
} from '@nocobase/app-plugin-authentication/testing';
import { expect } from 'vitest';

import { createAppTest } from '../helpers/test-app.js';
import { createItem } from '../helpers/inventory.js';
import {
  createOrder,
  get,
  jsonOf,
  makeRoleUser,
  unique,
  write,
  type Row,
} from '../helpers/orders.js';
import { createStandaloneServer } from '../../server/standalone.js';

/** R-065 授权：三份资源只给 finance；财务读订单只有窄头信息，没有明细与价格。 */
const test = createAppTest({
  createServer: createStandaloneServer,
  config: {
    app: { publicOrigin: 'http://localhost' },
    auth: { secret: 'test-auth-secret-at-least-32-characters' },
  },
});
const TIMEOUT = 30_000;

const FINANCE_GRANTS = [
  { resource: { type: 'composite', id: 'expenses' }, actions: [
    { action: 'view' }, { action: 'create' }, { action: 'update' },
    { action: 'confirm' }, { action: 'void' },
  ] },
  { resource: { type: 'composite', id: 'invoiceReceipts' }, actions: [
    { action: 'view' }, { action: 'create' }, { action: 'update' },
    { action: 'confirm' }, { action: 'void' },
  ] },
  { resource: { type: 'composite', id: 'purchaseOrders' }, actions: [{ action: 'financeView' }] },
];

async function makeUser(
  admin: TestSession,
  testApp: Parameters<typeof signIn>[0],
  prefix: string,
  roles: readonly string[],
): Promise<TestSession> {
  const username = unique(prefix);
  const created = await admin.fetch('/users', write({
    name: username, username, email: `${username.toLowerCase()}@example.test`,
    password: 'R065-authz-123!', roleScopes: { app: [...roles] },
  }));
  expect(created.status).toBe(201);
  return await signIn(testApp, { username, password: 'R065-authz-123!' });
}

test('采购、销售、仓管、无角色用户碰财务端点都是 403，先授权后读内容', async ({ testApp }) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const sessions = await Promise.all([
    makeUser(admin, testApp, 'r065buyer', ['purchase']),
    makeUser(admin, testApp, 'r065seller', ['sales']),
    makeUser(admin, testApp, 'r065keeper', ['warehouse']),
    makeUser(admin, testApp, 'r065nobody', []),
  ]);
  for (const [index, session] of sessions.entries()) {
    const prefix = ['purchase', 'sales', 'warehouse', 'none'][index]!;
    for (const method of ['GET', 'POST'] as const) {
      const response = await session.fetch('/expenses', method === 'GET'
        ? get()
        : write({ expenseDate: '2026-11-28', bindMode: 'none', amount: 1 }));
      expect(response.status, `${prefix} GET/POST /expenses 应当 403：${await response.clone().text()}`).toBe(403);
      expect((await jsonOf(response)).error?.reason).not.toBe('FINANCE_LINE_INVALID');
    }
    expect((await session.fetch('/invoice-receipts', get())).status, `${prefix} invoice 403`).toBe(403);
    // 持 purchaseOrders.view 的采购也能调 payable（设计明写）；其它角色不能。
    expect(
      (await session.fetch('/purchase-orders/payable', get())).status,
      `${prefix} payable`,
    ).toBe(prefix === 'purchase' ? 200 : 403);
  }
  const removed = await sessions[0]!.fetch('/expenses/no-such', {
    method: 'DELETE', headers: { origin: 'http://localhost' },
  });
  expect([403, 404, 405]).toContain(removed.status);
}, TIMEOUT);

test('财务读不到采购订单列表与详情；payable 只有窄头信息', async ({ testApp, connection }) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const item = await createItem(connection);
  const order = await createOrder(admin, 'purchase', {
    lines: [{ itemId: item, qty: 10, price: 113, taxRate: 13 }],
  });
  await admin.fetch(`/purchase-orders/${String(order.id)}/submit`, write());
  const { session: finance } = await makeRoleUser(admin, testApp, 'r065viewer', FINANCE_GRANTS);
  expect((await finance.fetch('/purchase-orders', get())).status).toBe(403);
  expect((await finance.fetch(`/purchase-orders/${String(order.id)}`, get())).status).toBe(403);

  const payable = await jsonOf(await finance.fetch('/purchase-orders/payable', get()));
  expect(payable.items?.length).toBeGreaterThan(0);
  const row = payable.items![0]!;
  for (const key of ['lines', 'remark', 'price', 'handler', 'projectCode', 'discountAmount']) {
    expect(Object.keys(row)).not.toContain(key);
  }
  expect(Object.keys(row.supplier as Row).sort()).toEqual([
    'code', 'id', 'name', 'payeeAccountNo', 'payeeBankCode', 'payeeBankName',
  ]);
  expect(row.paidAmount).toBe(0);
  expect(row.invoicedAmount).toBe(0);
}, TIMEOUT);

test('财务角色能上传附件并绑定到支出记录，响应不回内部列', async ({ testApp, connection }) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const item = await createItem(connection);
  const order = await createOrder(admin, 'purchase', {
    lines: [{ itemId: item, qty: 1 }],
  });
  await admin.fetch(`/purchase-orders/${String(order.id)}/submit`, write());
  const { session: finance } = await makeRoleUser(admin, testApp, 'r065file', FINANCE_GRANTS);
  const form = new FormData();
  form.append('file', new File(['财务附件'], 'f.pdf', { type: 'application/pdf' }));
  const uploaded = await finance.fetch('/doc-files', {
    method: 'POST', headers: { origin: 'http://localhost' }, body: form,
  });
  expect(uploaded.status, `财务上传附件失败：${await uploaded.clone().text()}`).toBe(201);
  const file = await jsonOf(uploaded);
  const created = await finance.fetch('/expenses', write({
    expenseDate: '2026-11-28', bindMode: 'purchase_order',
    lines: [{ purchaseOrderId: order.id, amount: 1 }], fileIds: [String(file.id)],
  }));
  expect(created.status, `绑定附件失败：${await created.clone().text()}`).toBe(201);
  const body = await jsonOf(created);
  expect(body.files).toEqual([{
    id: file.id, name: 'f.pdf', contentType: 'application/pdf', size: 12,
  }]);
  const text = await (await finance.fetch(`/doc-files/${String(file.id)}/content`, get())).text();
  expect(text).toBe('财务附件');
  expect(JSON.stringify(body)).not.toContain('storageKey');
  expect(JSON.stringify(body)).not.toContain('createdById');
}, TIMEOUT);
