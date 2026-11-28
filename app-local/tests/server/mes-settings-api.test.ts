// @vitest-environment node
import { randomUUID } from 'node:crypto';

import {
  DEFAULT_ADMIN_CREDENTIALS,
  signIn,
  type TestSession,
} from '@nocobase/app-plugin-authentication/testing';
import { expect } from 'vitest';

import { createAppTest } from '../helpers/test-app.js';
import { get, jsonOf, unique, write } from '../helpers/orders.js';
import { createStandaloneServer } from '../../server/standalone.js';

/**
 * R-023 W3-1 基础设置的端点行为：五类设置的增改查、reportRules 默认值、
 * 六个开关列原样读写、服务端发号、停用被引用的工序 422、工价按 priceView 裁键、
 * 以及没有删除路由。
 */
const test = createAppTest({
  createServer: createStandaloneServer,
  config: {
    app: { publicOrigin: 'http://localhost' },
    auth: { secret: 'test-auth-secret-at-least-32-characters' },
  },
});

const PASSWORD = 'R023-mes-api-123!';
type Row = Record<string, unknown>;

async function makeRoleUser(
  admin: TestSession,
  testApp: Parameters<typeof signIn>[0],
  prefix: string,
  role: string,
): Promise<TestSession> {
  const username = unique(prefix);
  const created = await admin.fetch('/users', write({
    name: username,
    username,
    email: `${username.toLowerCase()}@example.test`,
    password: PASSWORD,
    roleScopes: { app: [role] },
  }));
  expect(created.status, `建用户失败：${await created.clone().text()}`).toBe(201);
  return await signIn(testApp, { username, password: PASSWORD });
}

async function createWorkCenter(admin: TestSession, code?: string): Promise<Row> {
  const response = await admin.fetch('/work-centers', write({
    code: code ?? unique('WC'),
    name: '测试工作中心',
    workerCount: 12,
  }));
  expect(response.status, `建工作中心失败：${await response.clone().text()}`).toBe(201);
  return await jsonOf(response);
}

async function createOperation(admin: TestSession, code?: string): Promise<Row> {
  const response = await admin.fetch('/operations', write({
    code: code ?? unique('OP'),
    name: '测试工序',
    sortOrder: 3,
  }));
  expect(response.status, `建工序失败：${await response.clone().text()}`).toBe(201);
  return await jsonOf(response);
}

test('R-023 W3-1: 五类设置能建能改能查，六个开关列原样读写', async ({ testApp }) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);

  const center = await createWorkCenter(admin);
  expect(center).toMatchObject({ name: '测试工作中心', workerCount: 12, active: true });
  expect(center.createdById).toBeUndefined();

  const code = unique('OP');
  const created = await admin.fetch('/operations', write({
    code,
    name: '开关工序',
    sortOrder: 5,
    defaultWorkCenterId: center.id,
    unitHourlyCapacity: 2.5,
    equipmentRequired: true,
    handoverConfirm: false,
    inspectionFree: true,
    autoComplete: false,
    currentReportLimit: '3',
    previousReportLimit: '2',
  }));
  expect(created.status, `建工序失败：${await created.clone().text()}`).toBe(201);
  const operation = await jsonOf(created);
  expect(operation).toMatchObject({
    code,
    equipmentRequired: true,
    handoverConfirm: false,
    inspectionFree: true,
    autoComplete: false,
    currentReportLimit: '3',
    previousReportLimit: '2',
  });
  expect(operation.unitHourlyCapacity).toBe(2.5);

  const patched = await admin.fetch(`/operations/${String(operation.id)}`, write({
    name: '改名后的工序',
    sortOrder: 9,
    inspectionFree: false,
  }, 'PATCH'));
  expect(patched.status, `改工序失败：${await patched.clone().text()}`).toBe(200);
  const changed = await jsonOf(patched);
  expect(changed).toMatchObject({
    name: '改名后的工序', sortOrder: 9, inspectionFree: false,
    // 没在 patch 里的开关原样保留，语义不被解释、不改写成别的规则。
    equipmentRequired: true, currentReportLimit: '3',
  });

  const list = await admin.fetch('/operations?active=active&q=改名后', get());
  expect(list.status).toBe(200);
  const body = await jsonOf(list);
  expect(body.total).toBe(1);
  expect((body.items as Row[])[0]?.id).toBe(operation.id);

  const rules = await admin.fetch('/report-rules', get());
  expect(rules.status).toBe(200);
  const ruleBody = await jsonOf(rules);
  expect(Object.fromEntries(
    (ruleBody.items as Row[]).map((row) => [row.code, row.value]),
  )).toEqual({
    scanReportLimit: 'unrestricted',
    reportOrderLimit: 'none',
    miniProgramPriceDisplay: 'hidden',
    autoReport: 'no',
  });
  const rulePatch = await admin.fetch('/report-rules/autoReport', write({ value: 'yes' }, 'PATCH'));
  expect(rulePatch.status).toBe(200);
  expect((await jsonOf(rulePatch)).value).toBe('yes');
});

test('R-023 W3-1: 不良品项 BL 与工艺流程 GY 由服务端发号', async ({ testApp, connection }) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const defect = await admin.fetch('/defect-items', write({ name: '划伤' }));
  expect(defect.status, `建不良品项失败：${await defect.clone().text()}`).toBe(201);
  const defectRow = await jsonOf(defect);
  expect(defectRow.code).toMatch(/^BL-\d{8}-\d{4}$/u);

  const itemId = randomUUID();
  const route = await admin.fetch('/process-routes', write({
    name: '测试工艺', productId: itemId,
  }));
  expect(route.status, `建工艺失败：${await route.clone().text()}`).toBe(201);
  const routeRow = await jsonOf(route);
  expect(routeRow.docNo).toMatch(/^GY-\d{8}-\d{4}$/u);

  const prefixes = await connection.query.selectFrom('codeSequences')
    .select(['prefix']).where('prefix', 'in', ['BL', 'GY']).execute();
  expect(prefixes.map((row) => row.prefix).sort()).toEqual(['BL', 'GY']);
});

test('R-023 W3-1: 停用被 processRouteSteps 引用的工序回 422 MES_SETTING_IN_USE', async ({
  testApp, connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const operation = await createOperation(admin);
  const routeId = randomUUID();
  const now = new Date().toISOString();
  await connection.query.insertInto('process_routes').values({
    id: routeId, docNo: `GY-${unique('R')}`, name: '引用工艺', productId: randomUUID(),
    active: true, createdById: String(admin.user.id), createdAt: now, updatedAt: now,
  }).execute();
  await connection.query.insertInto('process_route_steps').values({
    id: randomUUID(), routeId, operationId: String(operation.id), stepNo: 1, note: null,
  }).execute();

  const blocked = await admin.fetch(`/operations/${String(operation.id)}`, write({
    active: false,
  }, 'PATCH'));
  expect(blocked.status).toBe(422);
  expect((await jsonOf(blocked)).error?.reason).toBe('MES_SETTING_IN_USE');

  // 前置条件真的被清掉之后，停用才成功；被扣住的失败分支不留副作用。
  await connection.query.deleteFrom('process_route_steps')
    .where('operationId', '=', String(operation.id)).execute();
  expect(await connection.query.selectFrom('process_route_steps').selectAll()
    .where('operationId', '=', String(operation.id)).execute()).toHaveLength(0);
  const allowed = await admin.fetch(`/operations/${String(operation.id)}`, write({
    active: false,
  }, 'PATCH'));
  expect(allowed.status, `停用失败：${await allowed.clone().text()}`).toBe(200);
  expect((await jsonOf(allowed)).active).toBe(false);
});

test('R-023 W3-1: 工价 upsert；无 priceView 时响应没有 unitPrice 键，显式索取回 403', async ({
  testApp,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const production = await makeRoleUser(admin, testApp, 'r023prod', 'production');

  const itemId = randomUUID();
  const operationId = randomUUID();
  const first = await admin.fetch('/operation-prices', write({
    itemId, operationId, unitPrice: 12.34, note: '编造的工价',
  }));
  expect(first.status, `建工价失败：${await first.clone().text()}`).toBe(201);
  const second = await admin.fetch('/operation-prices', write({
    itemId, operationId, unitPrice: 15.6, note: '改过的工价',
  }));
  expect(second.status).toBe(201);
  expect((await jsonOf(second)).unitPrice).toBe(15.6);

  const asAdmin = await admin.fetch('/operation-prices', get());
  expect(asAdmin.status).toBe(200);
  const adminBody = await jsonOf(asAdmin);
  expect(adminBody.total).toBe(1);
  expect((adminBody.items as Row[])[0]?.unitPrice).toBe(15.6);

  const asProduction = await production.fetch('/operation-prices', get());
  expect(asProduction.status).toBe(200);
  const body = await jsonOf(asProduction);
  expect(body.total).toBe(1);
  const row = (body.items as Row[])[0]!;
  expect(Object.prototype.hasOwnProperty.call(row, 'unitPrice')).toBe(false);
  expect(row.itemId).toBe(itemId);
  expect(row.operationId).toBe(operationId);

  const asking = await production.fetch('/operation-prices?includePrice=true', get());
  expect(asking.status).toBe(403);
  expect((await jsonOf(asking)).error?.reason).toBe('MES_PRICE_FORBIDDEN');
});

test('R-023 W3-1: 没有删除路由，DELETE 一律 404 或 405', async ({ testApp }) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const center = await createWorkCenter(admin);
  for (const path of [
    `/work-centers/${String(center.id)}`,
    '/operations/any-id',
    '/process-routes/any-id',
    '/defect-items/any-id',
    '/report-rules/autoReport',
    '/operation-prices/any-id',
  ]) {
    const response = await admin.fetch(path, { method: 'DELETE', headers: { origin: 'http://localhost' } });
    expect([404, 405], `DELETE ${path}`).toContain(response.status);
  }
});
