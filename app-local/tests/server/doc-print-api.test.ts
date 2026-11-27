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
import { createItem } from '../helpers/inventory.js';
import { createWarehouse } from '../helpers/orders.js';
import { createStandaloneServer } from '../../server/standalone.js';

/**
 * R-076 打印数据端点：三种单据的正向形状与人民币大写、先授权后读内容、
 * 每次 print-mark 加一（含十次并发）。数据一律编造，真 Postgres 上跑。
 */
const test = createAppTest({
  createServer: createStandaloneServer,
  config: {
    app: { publicOrigin: 'http://localhost' },
    auth: { secret: 'test-auth-secret-at-least-32-characters' },
  },
});

const PASSWORD = 'R076-api-test-123!';
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

interface Row {
  [key: string]: unknown;
  error?: { reason?: string };
}
const jsonOf = async (response: Response): Promise<Row> => (await response.json()) as Row;

async function makeUser(
  admin: TestSession,
  app: Parameters<typeof signIn>[0],
  prefix: string,
  roles: readonly string[],
): Promise<{ session: TestSession; id: string }> {
  const username = unique(prefix);
  const created = await admin.fetch('/users', write({
    name: username,
    username,
    email: `${username.toLowerCase()}@example.test`,
    password: PASSWORD,
    roleScopes: { app: [...roles] },
  }));
  expect(created.status, `建用户失败：${await created.clone().text()}`).toBe(201);
  const body = await jsonOf(created);
  const id = String((body.data as Row | undefined)?.id ?? body.id ?? '');
  expect(id, '建用户响应应当带 id').not.toBe('');
  return { id, session: await signIn(app, { username, password: PASSWORD }) };
}

async function baseDocs(
  connection: DatabaseConnection,
  admin: TestSession,
): Promise<{ itemId: string; warehouseId: string }> {
  const itemId = await createItem(connection);
  const warehouse = await createWarehouse(admin);
  return { itemId, warehouseId: String(warehouse.id) };
}

async function createDoc(
  session: TestSession,
  reason: 'internal_use' | 'sales_issue' | 'purchase_receipt',
  docType: 'in' | 'out',
  itemId: string,
  warehouseId: string,
): Promise<Row> {
  const response = await session.fetch('/stock-docs', write({
    docType,
    reason,
    lines: [{ itemId, warehouseId, batchNo: 'B1', qty: 10, taxIncludedPrice: 113, taxRate: 13 }],
  }));
  expect(response.status, `建单据失败：${await response.clone().text()}`).toBe(201);
  return await jsonOf(response);
}

const CASES = [
  { reason: 'internal_use', docType: 'out', path: 'internal-use' },
  { reason: 'sales_issue', docType: 'out', path: 'sales-issue' },
  { reason: 'purchase_receipt', docType: 'in', path: 'purchase-receipt' },
] as const;

test('三种单据的正向打印数据：形状、合计、人民币大写与空审批占位', async ({ testApp, connection }) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const { itemId, warehouseId } = await baseDocs(connection, admin);

  for (const entry of CASES) {
    const doc = await createDoc(admin, entry.reason, entry.docType, itemId, warehouseId);
    const response = await admin.fetch(
      `/doc-print/${entry.path}/${encodeURIComponent(String(doc.docNo))}`,
      get(),
    );
    expect(response.status, `${entry.reason} 打印数据`).toBe(200);
    const data = await jsonOf(response);
    expect(data).toMatchObject({ docType: entry.reason, docNo: doc.docNo });
    for (const key of ['header', 'lines', 'party', 'totals', 'preparedBy', 'printedAt', 'approval']) {
      expect(data[key], `${entry.reason} 缺少 ${key}`).toBeDefined();
    }
    expect(data.printCount).toBe(0);
    const lines = data.lines as Row[];
    expect(lines).toHaveLength(1);
    const totals = data.totals as Row;
    expect(Number(totals.totalQty)).toBe(
      lines.reduce((sum, line) => sum + Number(line.qty), 0),
    );
    expect(totals.payableTotal).toBe(1130);
    expect(data.amountInWords).toBe('壹仟壹佰叁拾元整');
    expect(data.approval).toEqual({
      approver: '', approvedAt: '', approvalStatus: '', approvalFlow: '',
    });
    expect(data.preparedBy).toEqual(expect.objectContaining({
      id: expect.any(String), name: expect.any(String),
    }));
    expect(JSON.stringify(data)).not.toMatch(/@[a-z]+\.[a-z]+/u);
  }
});

test('没有 print 的人三个端点都 403，响应体没有任何单据内容', async ({ testApp, connection }) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const { itemId, warehouseId } = await baseDocs(connection, admin);
  const staff = await makeUser(admin, testApp, 'r076staff', ['staff']);
  for (const entry of CASES) {
    const doc = await createDoc(admin, entry.reason, entry.docType, itemId, warehouseId);
    const response = await staff.session.fetch(
      `/doc-print/${entry.path}/${encodeURIComponent(String(doc.docNo))}`,
      get(),
    );
    expect(response.status).toBe(403);
    const body = JSON.stringify(await jsonOf(response));
    expect(body).toContain('NO_PERMISSION');
    for (const key of ['header', 'lines', 'totals', 'party', 'preparedBy', 'docNo']) {
      expect(body, `403 不应回 ${key}`).not.toContain(key);
    }
  }
});

test('print-mark：连打三次次数加一、痕迹是调用人；并发十次恰好十', async ({ testApp, connection }) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const { itemId, warehouseId } = await baseDocs(connection, admin);
  const keeper = await makeUser(admin, testApp, 'r076keeper', ['warehouse']);
  const doc = await createDoc(admin, 'purchase_receipt', 'in', itemId, warehouseId);
  const docNo = String(doc.docNo);
  const path = `/doc-print/purchase-receipt/${encodeURIComponent(docNo)}/print-mark`;

  let previous = '';
  for (let expected = 1; expected <= 3; expected += 1) {
    const response = await keeper.session.fetch(path, write());
    expect(response.status, `第 ${expected} 次 print-mark`).toBe(201);
    const mark = await jsonOf(response);
    expect(mark.docNo).toBe(docNo);
    expect(mark.printCount).toBe(expected);
    expect(mark.lastPrintedBy).toBe(keeper.id);
    expect(String(mark.lastPrintedAt) > previous).toBe(true);
    previous = String(mark.lastPrintedAt);
  }

  const race = await Promise.all(
    Array.from({ length: 10 }, () => keeper.session.fetch(path, write())),
  );
  for (const response of race) expect(response.status).toBe(201);
  const counts = await Promise.all(
    race.map(async (response) => Number((await jsonOf(response)).printCount)),
  );
  expect([...counts].sort((a, b) => a - b)).toEqual([4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
  const data = await jsonOf(
    await admin.fetch(`/doc-print/purchase-receipt/${encodeURIComponent(docNo)}`, get()),
  );
  expect(data.printCount).toBe(13);
});

test('非法的 docType 与不存在的单据回 404 且不回内容', async ({ testApp }) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const badType = await admin.fetch('/doc-print/not-a-type/no-such/print-mark', write());
  expect(badType.status).toBe(404);
  const body = await jsonOf(badType);
  expect(body.error?.reason).toBe('PRINT_DOC_TYPE_INVALID');
  expect(JSON.stringify(body)).not.toContain('header');

  const missing = await admin.fetch('/doc-print/purchase-receipt/NO-SUCH-DOC', get());
  expect(missing.status).toBe(404);
  expect((await jsonOf(missing)).error?.reason).toBe('PRINT_DOC_NOT_FOUND');
});
