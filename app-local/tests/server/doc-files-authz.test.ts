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
  createOrder,
  get,
  jsonOf,
  makeRoleUser,
  unique,
  write,
  type Row,
} from '../helpers/orders.js';
import { createStandaloneServer } from '../../server/standalone.js';

/**
 * R-021 加片「单据附件」的授权与风险：先授权后读请求体；越权取内容；
 * 绑定别人的文件、超过 10 个、文件不存在三类规则码；响应不回内部列。
 */
const test = createAppTest({
  createServer: createStandaloneServer,
  config: {
    app: { publicOrigin: 'http://localhost' },
    auth: { secret: 'test-auth-secret-at-least-32-characters' },
  },
});
const TIMEOUT = 30_000;

const upload = (session: TestSession, name = 'doc.pdf'): Promise<Response> => {
  const form = new FormData();
  form.append('file', new File(['附件内容'], name, { type: 'application/pdf' }));
  return session.fetch('/doc-files', {
    method: 'POST', headers: { origin: 'http://localhost' }, body: form,
  });
};

test('没有任何写动作的会话上传得 403，而且坏请求体不会先拿到 400', async ({ testApp, app }) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const { id, session: nobody } = await makeRoleUser(
    admin, testApp, 'r021noupload', [
      { resource: { type: 'composite', id: 'purchaseOrders' }, actions: [{ action: 'view' }] },
    ],
  );
  // R-021 波 1 加片给 staff 补了请购单建/改，也就补了附件上传入口；这里撤掉基线
  // staff，才是真正「没有任何写动作」的会话。
  await app.container.resolve(authorizationToken).permissionSets.revoke(`user:${id}:staff`);
  for (const init of [
    { method: 'POST', headers: { origin: 'http://localhost' }, body: 'not multipart' },
    { method: 'POST', headers: { origin: 'http://localhost' }, body: new FormData() },
  ] as RequestInit[]) {
    const response = await nobody.fetch('/doc-files', init);
    expect(response.status, '先授权后读内容').toBe(403);
  }
  // 不存在的文件是 404；已存在的未绑定文件只有上传人能取（见 api 测试）。
  expect((await nobody.fetch('/doc-files/missing/content', get())).status).toBe(404);
}, TIMEOUT);

test('绑定到出入库草稿：持 stockView 可取内容，没stockView 的会话 403', async ({
  testApp, connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const item = await createItem(connection);
  const warehouse = await jsonOf(await admin.fetch('/warehouses', write({
    code: unique('DOC-WH'), name: '附件仓',
  })));
  const file = await jsonOf(await upload(admin));
  const created = await admin.fetch('/stock-docs', write({
    docType: 'in', reason: 'purchase_receipt', fileIds: [String(file.id)],
    lines: [{ itemId: item, warehouseId: warehouse.id, qty: 2 }],
  }));
  expect(created.status, `建带附件单据失败：${await created.clone().text()}`).toBe(201);
  const doc = await jsonOf(created);
  expect(doc.files).toHaveLength(1);
  const stored = await connection.repository<Row>('docFiles').findOne({ filter: { id: file.id } });
  expect(stored?.ownerType).toBe('stock_doc');
  expect((await admin.fetch(`/doc-files/${String(file.id)}/content`, get())).status).toBe(200);
  const { session: outsider } = await makeRoleUser(
    admin, testApp, 'r021stockoutsider', [
      { resource: { type: 'composite', id: 'inventory' }, actions: [{ action: 'warehouseView' }] },
    ],
  );
  expect((await outsider.fetch(`/doc-files/${String(file.id)}/content`, get())).status).toBe(403);
}, TIMEOUT);

test('风险反向：不存在的文件 404，超过 10 个 400，任何响应里都没有内部列', async ({
  testApp, connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const item = await createItem(connection);
  const supplierId = String((await jsonOf(await admin.fetch('/partners', write({
    name: unique('附件供应商'), isSupplier: true,
  })))).id);
  const base = {
    supplierId, orderDate: '2026-11-28', lines: [{ itemId: item, qty: 1 }],
  };
  const missing = await admin.fetch('/purchase-orders', write({
    ...base, fileIds: [unique('NO-FILE')],
  }));
  expect(missing.status).toBe(404);
  expect((await jsonOf(missing)).error?.reason).toBe('FILE_NOT_FOUND');

  const ids: string[] = [];
  for (let index = 0; index < 11; index += 1) {
    const response = await upload(admin, `f${index}.pdf`);
    expect(response.status).toBe(201);
    const file = await jsonOf(response);
    expect(Object.keys(file).sort()).toEqual(['contentType', 'id', 'name', 'size']);
    ids.push(String(file.id));
  }
  const tooMany = await admin.fetch('/purchase-orders', write({ ...base, fileIds: ids }));
  expect(tooMany.status, `超过 10 个应被拒：${await tooMany.clone().text()}`).toBe(400);
  expect((await jsonOf(tooMany)).error?.reason).toBe('FILE_TOO_MANY');

  const order = await createOrder(admin, 'purchase', { lines: [{ itemId: item, qty: 1 }] });
  for (const response of [
    await admin.fetch(`/purchase-orders/${String(order.id)}`, get()),
    await admin.fetch(`/doc-files/${ids[0]}/content`, get()),
  ]) {
    const text = await response.clone().text();
    expect(text).not.toContain('storageKey');
    expect(text).not.toContain('createdById');
  }
}, TIMEOUT);
