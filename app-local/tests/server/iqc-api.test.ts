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
  createEmployee,
  createOrder,
  jsonOf,
  unique,
  write,
} from '../helpers/orders.js';
import { createStandaloneServer } from '../../server/standalone.js';

/**
 * R-070 IQC：质量员建单、完成检验、服务端算出三个数量，以及业务规则拒绝。
 * 所有数字从真库与真响应读回；不连开发库、不造真实人员信息。
 */
const test = createAppTest({
  createServer: createStandaloneServer,
  config: {
    app: { publicOrigin: 'http://localhost' },
    auth: { secret: 'test-auth-secret-at-least-32-characters' },
  },
});

const PASSWORD = 'R070-iqc-test-123!';
const FORBIDDEN_KEYS = [
  'createdById', 'storageKey', 'uploadedById', 'uploadedBy',
  'purchasePrice', 'salesPrice', 'basePurchasePrice', 'baseSalesPrice',
  'taxIncludedPrice', 'taxExcludedPrice', 'price', 'email', 'phone', 'mobile',
];

type Row = Record<string, unknown>;

async function makeRoleUser(
  admin: TestSession,
  testApp: Parameters<typeof signIn>[0],
  prefix: string,
  role: string,
): Promise<{ session: TestSession; id: string }> {
  const username = unique(prefix);
  const created = await admin.fetch('/users', write({
    name: username,
    username,
    email: `${username.toLowerCase()}@example.test`,
    password: PASSWORD,
    roleScopes: { app: [role] },
  }));
  expect(created.status, `建用户失败：${await created.clone().text()}`).toBe(201);
  const id = String(((await jsonOf(created)).data as Row | undefined)?.id ?? '');
  expect(id, '建用户响应应当带 id').not.toBe('');
  return { session: await signIn(testApp, { username, password: PASSWORD }), id };
}

async function submittedPurchase(
  admin: TestSession,
  itemId: string,
  qty = 10,
): Promise<Row> {
  const order = await createOrder(admin, 'purchase', {
    lines: [{ itemId, qty }],
  });
  expect(
    (await admin.fetch(`/purchase-orders/${String(order.id)}/submit`, write())).status,
    '采购订单提交失败',
  ).toBe(200);
  return order;
}

const line = (itemId: string, over: Row = {}): Row => ({
  itemId,
  inspectionTypeCode: 'full',
  receivedQty: 10,
  inspectionQty: 8,
  qualifiedQty: 7,
  samplingQty: 2,
  samplingQualifiedQty: 2,
  ...over,
});

test('IQC 正向：建单带出采购行，完成后三个数量由服务端算出', async ({
  testApp, connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const inspector = await makeRoleUser(admin, testApp, 'iqcinsp', 'quality_inspector');
  await createEmployee(connection, inspector.id);
  const itemId = await createItem(connection);
  const order = await submittedPurchase(admin, itemId);

  const created = await inspector.session.fetch('/inspections', write({
    purchaseOrderId: order.id,
    lines: [line(itemId)],
  }));
  expect(created.status, `建检验单失败：${await created.clone().text()}`).toBe(201);
  const body = await jsonOf(created);
  const id = String(body.id);
  expect(String(body.docNo)).toMatch(/^JY-\d{8}-\d{4,}$/u);
  expect(body.status).toBe('pending');
  expect(body.purchaseOrder).toMatchObject({ id: order.id });
  expect(Object.keys(body.purchaseOrder as Row).sort()).toEqual([
    'id', 'orderDate', 'orderNo',
  ]);
  expect(body.inspector).toMatchObject({ userId: inspector.id });
  expect(Object.keys(body.inspector as Row).sort()).toEqual(['name', 'userId']);
  expect(body.lines).toHaveLength(1);
  const first = (body.lines as Row[])[0]!;
  expect(Number(first.purchaseQty)).toBe(10);
  expect(Number(first.receivedQty)).toBe(10);
  expect(Number(first.inspectionQty)).toBe(8);
  expect(Number(first.qualifiedQty)).toBe(7);
  expect(Number(first.unqualifiedQty)).toBe(1);
  expect(Number(first.releasableQty)).toBe(7);
  expect(Number(first.returnQty)).toBe(3);
  expect(Object.keys(first.item as Row).sort()).toEqual([
    'code', 'id', 'name', 'spec', 'unitCode',
  ]);
  for (const key of FORBIDDEN_KEYS) {
    expect(Object.keys(body), `头不该回 ${key}`).not.toContain(key);
    expect(Object.keys(first), `明细不该回 ${key}`).not.toContain(key);
  }

  // 请求体里的服务端算列即使带了也被忽略：合格 7 永远不会变成 9。
  // 同一订单行的收货额度已被上一张单占满，这里换一张采购订单。
  const otherOrder = await submittedPurchase(admin, itemId);
  const tampered = await inspector.session.fetch('/inspections', write({
    purchaseOrderId: otherOrder.id,
    lines: [line(itemId, { qualifiedQty: 7, releasableQty: 99, unqualifiedQty: 99 })],
  }));
  expect(tampered.status).toBe(201);
  const tamperedLine = ((await jsonOf(tampered)).lines as Row[])[0]!;
  expect(Number(tamperedLine.releasableQty)).toBe(7);
  expect(Number(tamperedLine.unqualifiedQty)).toBe(1);

  const completed = await inspector.session.fetch(`/inspections/${id}/complete`, write());
  expect(completed.status, `完成检验失败：${await completed.clone().text()}`).toBe(200);
  const result = await jsonOf(completed);
  expect(result.status).toBe('partial');
  const done = (result.lines as Row[])[0]!;
  expect(Number(done.unqualifiedQty)).toBe(1);
  expect(Number(done.releasableQty)).toBe(7);
  expect(Number(done.returnQty)).toBe(3);

  const stored = await connection.repository<Row>('inspectionLines').findOne({
    filter: { orderId: id },
  });
  expect(Number(stored?.unqualifiedQty)).toBe(1);
  expect(Number(stored?.releasableQty)).toBe(7);
  expect(Number(stored?.returnQty)).toBe(3);
});

test('IQC 规则拒绝：数量非法、同物料重复、收货超额、非 pending 改与完成', async ({
  testApp, connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const inspector = await makeRoleUser(admin, testApp, 'iqcrule', 'quality_inspector');
  await createEmployee(connection, inspector.id);
  const manager = await makeRoleUser(admin, testApp, 'iqcrulemgr', 'quality_manager');
  const itemId = await createItem(connection);
  const order = await submittedPurchase(admin, itemId);

  const badQty = await inspector.session.fetch('/inspections', write({
    purchaseOrderId: order.id,
    lines: [line(itemId, { qualifiedQty: 9 })],
  }));
  expect(badQty.status).toBe(422);
  expect((await jsonOf(badQty)).error?.reason).toBe('IQC_QTY_INVALID');

  const duplicate = await inspector.session.fetch('/inspections', write({
    purchaseOrderId: order.id,
    lines: [line(itemId), line(itemId, { receivedQty: 0, inspectionQty: 0, qualifiedQty: 0, samplingQty: 0, samplingQualifiedQty: 0 })],
  }));
  expect(duplicate.status).toBe(422);
  expect((await jsonOf(duplicate)).error?.reason).toBe('IQC_DUPLICATE_ITEM');

  const overReceived = await inspector.session.fetch('/inspections', write({
    purchaseOrderId: order.id,
    lines: [line(itemId, { receivedQty: 11, inspectionQty: 8, qualifiedQty: 7 })],
  }));
  expect(overReceived.status).toBe(422);
  expect((await jsonOf(overReceived)).error?.reason).toBe('IQC_RECEIVED_EXCEED');

  const draft = await createOrder(admin, 'purchase', { lines: [{ itemId, qty: 5 }] });
  const badOrder = await inspector.session.fetch('/inspections', write({
    purchaseOrderId: draft.id,
    lines: [line(itemId, { receivedQty: 5, inspectionQty: 4, qualifiedQty: 3 })],
  }));
  expect(badOrder.status).toBe(422);
  expect((await jsonOf(badOrder)).error?.reason).toBe('IQC_ORDER_INVALID');

  const created = await inspector.session.fetch('/inspections', write({
    purchaseOrderId: order.id,
    lines: [line(itemId)],
  }));
  expect(created.status).toBe(201);
  const id = String((await jsonOf(created)).id);
  const completed = await inspector.session.fetch(`/inspections/${id}/complete`, write());
  expect(completed.status).toBe(200);
  for (const [path, method] of [
    [`${id}/complete`, 'POST'],
    [`${id}`, 'PATCH'],
    [`${id}/void`, 'POST'],
  ] as const) {
    const session = path.endsWith('/void') ? manager.session : inspector.session;
    const again = await session.fetch(`/inspections/${path}`, write({}, method));
    expect(again.status, `${method} ${path} 应当被状态拒绝`).toBe(422);
    expect((await jsonOf(again)).error?.reason).toBe('IQC_NOT_PENDING');
  }

  const removed = await inspector.session.fetch(`/inspections/${id}`, {
    method: 'DELETE',
    headers: { origin: 'http://localhost' },
  });
  expect([404, 405], '检验单不提供删除').toContain(removed.status);
});

test('IQC 作废只限 pending，完成后另一张单仍按余额校验收货', async ({
  testApp, connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const inspector = await makeRoleUser(admin, testApp, 'iqcvoid', 'quality_inspector');
  await createEmployee(connection, inspector.id);
  const manager = await makeRoleUser(admin, testApp, 'iqcvoidmgr', 'quality_manager');
  const itemId = await createItem(connection);
  const order = await submittedPurchase(admin, itemId);

  const first = await inspector.session.fetch('/inspections', write({
    purchaseOrderId: order.id,
    lines: [line(itemId)],
  }));
  expect(first.status).toBe(201);
  const firstId = String((await jsonOf(first)).id);
  expect((await inspector.session.fetch(`/inspections/${firstId}/void`, write())).status).toBe(403);
  expect((await manager.session.fetch(`/inspections/${firstId}/void`, write())).status).toBe(200);

  const second = await inspector.session.fetch('/inspections', write({
    purchaseOrderId: order.id,
    lines: [line(itemId)],
  }));
  expect(second.status).toBe(201);
  const secondId = String((await jsonOf(second)).id);
  const completed = await inspector.session.fetch(`/inspections/${secondId}/complete`, write());
  expect(completed.status).toBe(200);
  expect((await jsonOf(completed)).status).toBe('partial');
}, 30_000);
