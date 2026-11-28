// @vitest-environment node
import { randomUUID } from 'node:crypto';

import {
  DEFAULT_ADMIN_CREDENTIALS,
  signIn,
  type TestSession,
} from '@nocobase/app-plugin-authentication/testing';
import { authorizationToken } from '@nocobase/app-plugin-authorization';
import type { PermissionGrant } from '@nocobase/authorization/core';
import { expect } from 'vitest';

import { createAppTest } from '../helpers/test-app.js';
import { createStandaloneServer } from '../../server/standalone.js';
import { ACTIONS, TARGETS, upgradeReports } from '../../cli/authz/upgrade-r078-reports.js';
import { REPORT_DEFINITIONS } from '../../server/providers/report-definitions.js';

/**
 * R-078 验收 3、7、8：服务端裁列、先授权后读、二次判定与升级幂等。
 */
const test = createAppTest({
  createServer: createStandaloneServer,
  config: {
    app: { publicOrigin: 'http://localhost' },
    auth: { secret: 'test-auth-secret-at-least-32-characters' },
  },
});

const PASSWORD = 'R078-authz-test-123!';
const unique = (prefix: string) => `${prefix}${randomUUID().replaceAll('-', '').slice(0, 10)}`;
const write = (body: unknown = {}): RequestInit => ({
  method: 'POST',
  headers: {
    'content-type': 'application/json', origin: 'http://localhost',
    'Idempotency-Key': `${Date.now()}.${randomUUID()}`,
  },
  body: JSON.stringify(body),
});
const get = (): RequestInit => ({ method: 'GET' });
type Row = Record<string, unknown> & { error?: { reason?: string } };
const jsonOf = async (response: Response): Promise<Row> => (await response.json()) as Row;

async function makeUser(
  admin: TestSession, app: Parameters<typeof signIn>[0], role: string,
): Promise<TestSession> {
  const username = unique(`r078${role}`);
  const created = await admin.fetch('/users', write({
    name: username, username, email: `${username.toLowerCase()}@example.test`,
    password: PASSWORD, roleScopes: { app: [role] },
  }));
  expect(created.status).toBe(201);
  return await signIn(app, { username, password: PASSWORD });
}

const grant = (id: string, actions: readonly string[]): PermissionGrant => ({
  resource: { type: 'composite', id },
  actions: actions.map((action) => ({ action })),
});

async function makeCustomUser(
  admin: TestSession, app: Parameters<typeof signIn>[0], grants: readonly PermissionGrant[],
): Promise<TestSession> {
  const authz = app.application.container.resolve(authorizationToken);
  const key = unique('r078role');
  await authz.permissionSets.create({ key, grants });
  const username = unique('r078custom');
  const created = await admin.fetch('/users', write({
    name: username, username, email: `${username.toLowerCase()}@example.test`,
    password: PASSWORD, roleScopes: { app: [key] },
  }));
  expect(created.status).toBe(201);
  return await signIn(app, { username, password: PASSWORD });
}

const entry = grant('reports', ACTIONS);

test('定义与 schema 先授权后读：无入口 403、没有 baseActions 连 schema 都是 403', async ({ testApp }) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const staff = await makeUser(admin, testApp, 'staff');
  const purchase = await makeUser(admin, testApp, 'purchase');

  const listed = await staff.fetch('/reports', get());
  expect(listed.status).toBe(403);
  const listedBody = await jsonOf(listed);
  expect(listedBody.error?.reason).toBe('NO_PERMISSION');
  expect(JSON.stringify(listedBody)).not.toContain('titleKey');

  const schema = await purchase.fetch('/reports/sales_detail/schema', get());
  expect(schema.status).toBe(403);
  const schemaBody = await jsonOf(schema);
  expect(schemaBody.error?.reason).toBe('REPORT_FORBIDDEN');
  const body = JSON.stringify(schemaBody);
  for (const key of ['dimensions', 'measures', 'columns']) expect(body).not.toContain(key);
});

test('跨岗位越权：采购跑销1/财1、仓管跑财2、销售跑入1 都是 403', async ({ testApp }) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const purchase = await makeUser(admin, testApp, 'purchase');
  const warehouse = await makeUser(admin, testApp, 'warehouse');
  const sales = await makeUser(admin, testApp, 'sales');
  const runReport = async (session: TestSession, key: string) =>
    await session.fetch(`/reports/${key}/run`, write({ filters: {} }));
  for (const [session, key] of [
    [purchase, 'sales_detail'], [purchase, 'income_expense_detail'],
    [warehouse, 'invoice_receipt_detail'], [sales, 'stock_movement_detail'],
  ] as const) {
    const response = await runReport(session, key);
    expect(response.status).toBe(403);
    const text = JSON.stringify(await jsonOf(response));
    expect(text).not.toContain('"items"');
  }
});

test('裁列：没有 viewPrice 的会话跑采1 无价格键；planning 的销2 无金额键；schema 同样裁过', async ({ testApp }) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const buyer = await makeCustomUser(admin, testApp, [
    entry, grant('purchaseOrders', ['view']),
  ]);
  const planning = await makeUser(admin, testApp, 'planning');
  const priceKeys = ['taxExcludedPrice', 'taxIncludedPrice', 'taxIncludedAmount'];
  const amountKeys = ['receivedAmount', 'unreceivedAmount', 'invoicedAmount', 'uninvoicedAmount'];

  const purchaseResult = await buyer.fetch('/reports/purchase_detail/run', write({
    filters: {}, dimensions: [], measures: ['qty', ...priceKeys],
  }));
  const purchaseBody = await jsonOf(purchaseResult);
  expect(purchaseResult.status).toBe(200);
  expect(Object.keys((purchaseBody.items as Row[])[0] ?? { qty: 0 })).toEqual(['qty']);
  expect((purchaseBody.columns as Row[]).map((column) => column.key)).toEqual(['qty']);
  const purchaseText = JSON.stringify(purchaseBody);
  for (const key of priceKeys) expect(purchaseText).not.toContain(`"${key}"`);

  const purchaseSchema = await jsonOf(await buyer.fetch('/reports/purchase_detail/schema', get()));
  for (const key of priceKeys) {
    expect((purchaseSchema.columns as Row[]).map((column) => column.key))
      .not.toContain(key);
  }
  expect(purchaseSchema.dimensions).toBeDefined();

  const salesResult = await planning.fetch('/reports/sales_tracking/run', write({
    filters: {}, dimensions: [], measures: ['shippedQty', ...amountKeys],
  }));
  const salesBody = await jsonOf(salesResult);
  expect(salesResult.status).toBe(200);
  const salesText = JSON.stringify(salesBody);
  for (const key of amountKeys) expect(salesText).not.toContain(`"${key}"`);
  expect(salesText).toContain('"shippedQty"');
});

test('没有 reports.export 的用户导出 403', async ({ testApp }) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const viewer = await makeCustomUser(admin, testApp, [
    grant('reports', ['view', 'run']), grant('incomeRecords', ['view']),
  ]);
  const response = await viewer.fetch('/reports/income_expense_detail/export', write({ filters: {} }));
  expect(response.status).toBe(403);
  expect((await jsonOf(response)).error?.reason).toBe('NO_PERMISSION');
});

test('列表只回调用者持 baseActions 的定义；root 能看到全部 23 张', async ({ testApp }) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const purchase = await makeUser(admin, testApp, 'purchase');
  const rootList = await jsonOf(await admin.fetch('/reports?pageSize=100', get()));
  expect(rootList.total).toBe(REPORT_DEFINITIONS.length);
  expect(REPORT_DEFINITIONS.length).toBe(23);
  const purchaseList = await jsonOf(await purchase.fetch('/reports?pageSize=100', get()));
  const keys = (purchaseList.items as Row[]).map((row) => String(row.key));
  expect(keys).toContain('purchase_detail');
  expect(keys).not.toContain('sales_detail');
  expect(keys).not.toContain('income_expense_detail');
});

test('升级：五角色补入口、重跑不写 revision 不动、缺角色跳过、声明不符整条跳过', async () => {
  const stored = new Map<string, { key: string; revision: string; grants: PermissionGrant[] }>();
  for (const target of TARGETS) stored.set(target, { key: target, revision: 'r1', grants: [] });
  const writes: string[] = [];
  const authorization = {
    permissionSets: {
      list: async () => [...stored.values()],
      update: async (key: string, value: { grants: PermissionGrant[] }, revision: string) => {
        writes.push(`${key}:${revision}`);
        stored.set(key, { key, revision: 'r2', grants: value.grants });
      },
    },
    compositeResources: {
      getAction: (id: string, action: string) => id === 'reports' && ACTIONS.includes(action as never),
      validateGrant: () => undefined,
    },
  };
  const logger = { info: () => undefined };
  const first = await upgradeReports({ authorization }, logger);
  expect(first.changed).toEqual([...TARGETS]);
  expect(first.unchanged).toEqual([]);
  expect(writes).toHaveLength(5);
  for (const target of TARGETS) {
    expect(stored.get(target)?.grants[0]?.actions.map((action) => action.action)).toEqual([...ACTIONS]);
  }
  const second = await upgradeReports({ authorization }, logger);
  expect(second.unchanged).toEqual([...TARGETS]);
  expect(writes).toHaveLength(5);

  stored.delete('planning');
  const missing = await upgradeReports({ authorization }, logger);
  expect(missing.missing).toEqual(['planning']);
  const invalidAuthz = {
    ...authorization,
    compositeResources: { ...authorization.compositeResources, getAction: () => false },
  };
  const invalid = await upgradeReports({ authorization: invalidAuthz }, logger);
  expect(invalid.invalid).toEqual([...TARGETS]);
  expect(writes).toHaveLength(5);
});
