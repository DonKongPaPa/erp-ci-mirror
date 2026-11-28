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
 * R-019 波 2 验收 6 的授权与暴露面：view / explode 只给 craft 与 planning（和 root），
 * 四个维护动作只给 root；别的业务角色调用一律 403，且先授权后读内容；
 * includeCost 的金额键还受 items.viewPurchasePrice 这把锁管。
 */
const test = createAppTest({
  createServer: createStandaloneServer,
  config: {
    app: { publicOrigin: 'http://localhost' },
    auth: { secret: 'test-auth-secret-at-least-32-characters' },
  },
});

const ORIGIN = 'http://localhost';
const TIMEOUT = 30_000;
const PASSWORD = 'R019Bom-authz-123!';
const unique = (prefix: string) =>
  `${prefix}${randomUUID().replaceAll('-', '').slice(0, 10).toUpperCase()}`;
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
const jsonOf = async (response: Response): Promise<Row> =>
  (await response.json()) as Row;
async function expectStatus(response: Response, status: number): Promise<void> {
  if (response.status !== status) {
    throw new Error(`期望 ${status}，实际 ${response.status}：${await response.text()}`);
  }
}
const has = (row: Row | undefined, key: string): boolean =>
  row !== undefined && Object.prototype.hasOwnProperty.call(row, key);

async function makeUser(
  admin: TestSession,
  testApp: Parameters<typeof signIn>[0],
  role: string,
): Promise<TestSession> {
  const username = unique('r019bom');
  const created = await admin.fetch('/users', write({
    name: username,
    username,
    email: `${username.toLowerCase()}@example.test`,
    password: PASSWORD,
    roleScopes: { app: [role] },
  }));
  await expectStatus(created, 201);
  const id = String(((await jsonOf(created)).data as Row).id);
  const authz = testApp.application.container.resolve(authorizationToken);
  for (const assignment of await authz.permissionSets.listAssignments('staff')) {
    if (assignment.subject.type === 'user' && assignment.subject.id === id) {
      await authz.permissionSets.revoke(assignment.id);
    }
  }
  return await signIn(testApp, { username, password: PASSWORD });
}

async function fixture(admin: TestSession): Promise<{
  bomId: string;
  productId: string;
  itemId: string;
}> {
  const unit = unique('U');
  await expectStatus(
    await admin.fetch('/units', write({ code: unit, name: '单位' })),
    201,
  );
  const productResponse = await admin.fetch('/items', write({
    name: unique('成品'), itemType: 'product', unitCode: unit,
  }));
  await expectStatus(productResponse, 201);
  const itemResponse = await admin.fetch('/items', write({
    name: unique('配件'), itemType: 'material', unitCode: unit,
    basePurchasePrice: 12.5, baseSalesPrice: 88,
  }));
  await expectStatus(itemResponse, 201);
  const product = await jsonOf(productResponse);
  const item = await jsonOf(itemResponse);
  const bomResponse = await admin.fetch('/boms', write({
    version: '1',
    productId: product.id,
    effectiveFrom: '2026-01-01',
    lines: [{ itemId: item.id, qty: 2 }],
  }));
  await expectStatus(bomResponse, 201);
  const bom = await jsonOf(bomResponse);
  return {
    bomId: String(bom.id),
    productId: String(product.id),
    itemId: String(item.id),
  };
}

test('R-019 波2 验收6: craft / planning 只读只读得到，维护端点 403', async ({
  testApp,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const { bomId, productId, itemId } = await fixture(admin);
  for (const role of ['craft', 'planning'] as const) {
    const session = await makeUser(admin, testApp, role);
    for (const [label, response] of [
      ['列表', await session.fetch('/boms', get())],
      ['详情', await session.fetch(`/boms/${bomId}`, get())],
      ['生效版本', await session.fetch(
        `/boms/effective?productId=${productId}&asOf=2026-03-15`, get())],
      ['展开', await session.fetch(
        `/boms/explode?productId=${productId}&asOf=2026-03-15`, get())],
    ] as const) {
      expect(response.status, `${role} ${label} 应可读`).toBe(200);
    }
    for (const [label, response] of [
      ['建单', await session.fetch('/boms', write({
        version: 'X', productId, effectiveFrom: '2026-01-01',
        lines: [{ itemId, qty: 1 }],
      }))],
      ['改单', await session.fetch(`/boms/${bomId}`, write({ remark: '改' }, 'PATCH'))],
      ['停用', await session.fetch(`/boms/${bomId}/void`, write())],
    ] as const) {
      expect(response.status, `${role} ${label} 应被拒绝`).toBe(403);
    }
  }
}, TIMEOUT);

test('R-019 波2 验收6: 采购/销售/仓管/财务/质量七个端点全 403，非法内容也先 403', async ({
  testApp,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const { bomId, productId, itemId } = await fixture(admin);
  for (const role of [
    'purchase', 'sales', 'warehouse', 'finance', 'quality_inspector',
  ] as const) {
    const session = await makeUser(admin, testApp, role);
    const paths: readonly [string, RequestInit][] = [
      ['/boms', get()],
      [`/boms/${bomId}`, get()],
      ['/boms', write({
        version: 'X', productId, effectiveFrom: '2026-01-01',
        lines: [{ itemId, qty: -1 }],
      })],
      // zod 合法但业务不合法（数量为负）：先授权后读内容的证据。
      [`/boms/${bomId}`, write({ lines: [{ itemId, qty: -1 }] }, 'PATCH')],
      [`/boms/${bomId}/void`, write()],
      [`/boms/effective?productId=${productId}&asOf=2026-03-15`, get()],
      [`/boms/explode?productId=${productId}&asOf=2026-03-15`, get()],
    ];
    for (const [path, options] of paths) {
      const response = await session.fetch(path, options);
      expect(response.status, `${role} ${path} 应当先被授权拒绝`).toBe(403);
      const reason = (await jsonOf(response)).error?.reason;
      expect(reason, `${role} ${path} 不该泄漏业务规则码`).not.toBe('BOM_INVALID_INPUT');
    }
  }
}, TIMEOUT);

test('R-019 波2 验收6: craft 没有 items.viewPurchasePrice，展开的金额键不出现', async ({
  testApp,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const { productId, bomId } = await fixture(admin);
  const craft = await makeUser(admin, testApp, 'craft');
  const query = `productId=${productId}&asOf=2026-03-15&includeCost=1`;

  const deniedCost = await jsonOf(await craft.fetch(`/boms/explode?${query}`, get()));
  const totals = deniedCost.totals as Row[];
  expect(totals).toHaveLength(1);
  expect(has(totals[0], 'basePurchasePrice'), 'craft 不该拿到采购价').toBe(false);
  expect(has(totals[0], 'estimatedCost'), 'craft 不该拿到预估成本').toBe(false);

  const allowed = await jsonOf(await admin.fetch(`/boms/explode?${query}`, get()));
  const rootTotals = allowed.totals as Row[];
  expect(rootTotals[0]?.basePurchasePrice).toBe(12.5);
  expect(rootTotals[0]?.estimatedCost).toBe(25);

  // 详情、列表、展开的树与根都不回建单人 id、不回两个基准价。
  for (const body of [
    await jsonOf(await craft.fetch(`/boms/${bomId}`, get())),
    await jsonOf(await craft.fetch('/boms', get())),
    await jsonOf(await craft.fetch(`/boms/explode?productId=${productId}&asOf=2026-03-15`, get())),
  ]) {
    expect(JSON.stringify(body)).not.toContain('createdById');
    expect(JSON.stringify(body)).not.toContain('basePurchasePrice');
    expect(JSON.stringify(body)).not.toContain('baseSalesPrice');
    for (const line of (body.lines ?? []) as Row[]) {
      if (line.item !== undefined) {
        expect(Object.keys(line.item as Row).sort()).toEqual([
          'brand', 'code', 'id', 'manufacturerModel', 'name', 'spec', 'unitCode',
        ]);
      }
    }
  }
}, TIMEOUT);

test('R-019 波2 验收6: 资源声明六个动作、两张表无删除；业务角色只拿到两个读动作', async ({
  app,
}) => {
  const authz = app.container.resolve(authorizationToken);
  const actionsOf = (id: string): readonly string[] =>
    authz.compositeResources.list()
      .find((resource) => resource.name === id)
      ?.actions.map((action) => action.name)
      .sort() ?? [];
  expect(actionsOf('boms')).toEqual(['create', 'explode', 'update', 'view', 'void']);
  for (const table of ['boms', 'bomLines']) {
    const definition = authz.database.collections.list()
      .find((entry) => entry.name === table);
    expect(definition, `${table} 未登记`).toBeDefined();
    expect(definition?.actions, `${table} 不该登记删除`).not.toContain('delete');
  }

  const grantsOf = async (key: string): Promise<readonly Row[]> => {
    const grants = (await authz.permissionSets.get(key))?.grants ?? [];
    return JSON.parse(JSON.stringify(grants)) as Row[];
  };

  for (const role of ['craft', 'planning'] as const) {
    const grant = (await grantsOf(role)).find(
      (entry) => (entry.resource as Row).id === 'boms',
    );
    expect(grant, `${role} 缺 BOM 授权`).toBeDefined();
    expect(
      (grant?.actions as Row[]).map((action) => action.action).sort(),
      `${role} 只该拿到两个读动作`,
    ).toEqual(['explode', 'view']);
  }
  for (const role of [
    'purchase', 'sales', 'warehouse', 'finance', 'quality_inspector',
  ] as const) {
    const grants = await grantsOf(role);
    expect(
      grants.some((entry) => (entry.resource as Row).id === 'boms'),
      `${role} 不该有 BOM 资源`,
    ).toBe(false);
  }
}, TIMEOUT);
