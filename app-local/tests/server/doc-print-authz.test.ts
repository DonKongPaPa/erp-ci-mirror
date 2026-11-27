// @vitest-environment node
import { randomUUID } from 'node:crypto';

import {
  DEFAULT_ADMIN_CREDENTIALS,
  signIn,
  type TestSession,
} from '@nocobase/app-plugin-authentication/testing';
import { expect } from 'vitest';

import { createAppTest } from '../helpers/test-app.js';
import { createItem } from '../helpers/inventory.js';
import { createWarehouse } from '../helpers/orders.js';
import { createStandaloneServer } from '../../server/standalone.js';

/**
 * R-076 授权与暴露面：价格用独立 printPrice 隔列。仓管能打三种单但拿不到任何
 * 价格键；采购只在采购入库、销售只在销售出库拿到价格；别的组合 403。
 */
const test = createAppTest({
  createServer: createStandaloneServer,
  config: {
    app: { publicOrigin: 'http://localhost' },
    auth: { secret: 'test-auth-secret-at-least-32-characters' },
  },
});

const PASSWORD = 'R076-authz-test-123!';
const unique = (prefix: string) => `${prefix}${randomUUID().replaceAll('-', '').slice(0, 10)}`;
const write = (body: unknown = {}): RequestInit => ({
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    origin: 'http://localhost',
    'Idempotency-Key': `${Date.now()}.${randomUUID()}`,
  },
  body: JSON.stringify(body),
});
const get = (): RequestInit => ({ method: 'GET' });
interface Row { [key: string]: unknown; error?: { reason?: string } }
const jsonOf = async (response: Response): Promise<Row> => (await response.json()) as Row;

const PRICE_KEYS = [
  'taxIncludedPrice', 'taxExcludedPrice', 'taxRate', 'taxAmount',
  'taxIncludedAmount', 'amount', 'amountInWords',
] as const;
const TOTAL_KEYS = [
  'taxIncludedTotal', 'taxExcludedTotal', 'taxTotal', 'payableTotal',
] as const;

async function makeUser(
  admin: TestSession,
  app: Parameters<typeof signIn>[0],
  role: string,
): Promise<TestSession> {
  const username = unique(`r076${role}`);
  const created = await admin.fetch('/users', write({
    name: username,
    username,
    email: `${username.toLowerCase()}@example.test`,
    password: PASSWORD,
    roleScopes: { app: [role] },
  }));
  expect(created.status, `建用户失败：${await created.clone().text()}`).toBe(201);
  return await signIn(app, { username, password: PASSWORD });
}

const DOCS = [
  { reason: 'internal_use', docType: 'out', path: 'internal-use' },
  { reason: 'sales_issue', docType: 'out', path: 'sales-issue' },
  { reason: 'purchase_receipt', docType: 'in', path: 'purchase-receipt' },
] as const;

test('仓管能打三种单，但响应里没有任何价格键', async ({ testApp, connection }) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const keeper = await makeUser(admin, testApp, 'warehouse');
  const itemId = await createItem(connection);
  const warehouse = await createWarehouse(admin);
  for (const entry of DOCS) {
    const created = await admin.fetch('/stock-docs', write({
      docType: entry.docType,
      reason: entry.reason,
      lines: [{ itemId, warehouseId: String(warehouse.id), qty: 10, taxIncludedPrice: 113, taxRate: 13 }],
    }));
    expect(created.status).toBe(201);
    const doc = await jsonOf(created);
    const response = await keeper.fetch(
      `/doc-print/${entry.path}/${encodeURIComponent(String(doc.docNo))}`,
      get(),
    );
    expect(response.status, `仓管打 ${entry.reason}`).toBe(200);
    const body = JSON.stringify(await jsonOf(response));
    for (const key of [...PRICE_KEYS, ...TOTAL_KEYS]) {
      expect(body, `仓管不该拿到 ${key}`).not.toContain(`"${key}"`);
    }
    // 非价格的打印信息仍在。
    expect(body).toContain('"lines"');
    expect(body).toContain('"totals"');
    expect(body).toContain('"approval"');
  }
});

test('采购只在采购入库、销售只在销售出库拿到价格；错误组合 403', async ({ testApp, connection }) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const purchase = await makeUser(admin, testApp, 'purchase');
  const sales = await makeUser(admin, testApp, 'sales');
  const itemId = await createItem(connection);
  const warehouse = await createWarehouse(admin);
  const docNos: Record<string, string> = {};
  for (const entry of DOCS) {
    const created = await admin.fetch('/stock-docs', write({
      docType: entry.docType,
      reason: entry.reason,
      lines: [{ itemId, warehouseId: String(warehouse.id), qty: 10, taxIncludedPrice: 113, taxRate: 13 }],
    }));
    expect(created.status).toBe(201);
    docNos[entry.reason] = String((await jsonOf(created)).docNo);
  }

  const purchaseDoc = await purchase.fetch(
    `/doc-print/purchase-receipt/${encodeURIComponent(docNos.purchase_receipt!)}`,
    get(),
  );
  expect(purchaseDoc.status).toBe(200);
  const withPrice = await jsonOf(purchaseDoc);
  const pricedLine = (withPrice.lines as Row[])[0]!;
  for (const key of PRICE_KEYS.filter((key) => key !== 'amountInWords')) {
    expect(pricedLine[key], `采购明细应有 ${key}`).toBeDefined();
  }
  for (const key of TOTAL_KEYS) expect((withPrice.totals as Row)[key], `采购应有 ${key}`).toBeDefined();
  expect(withPrice.amountInWords).toBe('壹仟壹佰叁拾元整');

  const salesDoc = await sales.fetch(
    `/doc-print/sales-issue/${encodeURIComponent(docNos.sales_issue!)}`,
    get(),
  );
  expect(salesDoc.status).toBe(200);
  expect((await jsonOf(salesDoc)).amountInWords).toBe('壹仟壹佰叁拾元整');

  for (const [session, path, docNo] of [
    [purchase, 'internal-use', docNos.internal_use],
    [purchase, 'sales-issue', docNos.sales_issue],
    [sales, 'purchase-receipt', docNos.purchase_receipt],
  ] as const) {
    const denied = await session.fetch(`/doc-print/${path}/${encodeURIComponent(docNo!)}`, get());
    expect(denied.status).toBe(403);
    expect((await jsonOf(denied)).error?.reason).toBe('NO_PERMISSION');
  }
});

test('没有对应 print 的人不能写痕迹', async ({ testApp }) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const staff = await makeUser(admin, testApp, 'staff');
  const response = await staff.fetch('/doc-print/internal-use/NO-SUCH/print-mark', write());
  expect(response.status).toBe(403);
  expect((await jsonOf(response)).error?.reason).toBe('NO_PERMISSION');
});
