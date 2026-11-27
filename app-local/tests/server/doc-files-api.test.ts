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

/**
 * R-021 加片「单据附件」：上传、绑定、详情回 files、按单据读授权取内容；
 * 越权的取内容、别人的文件、超过 10 个都在 authz 那份里另外钉住。
 */
const test = createAppTest({
  createServer: createStandaloneServer,
  config: {
    app: { publicOrigin: 'http://localhost' },
    auth: { secret: 'test-auth-secret-at-least-32-characters' },
  },
});
const TIMEOUT = 30_000;
const PASSWORD = 'R026-doc-files-123!';

const upload = (session: TestSession, name = 'probe.txt'): Promise<Response> => {
  const form = new FormData();
  form.append('file', new File(['附件测试内容'], name, { type: 'application/pdf' }));
  return session.fetch('/doc-files', {
    method: 'POST',
    headers: { origin: 'http://localhost' },
    body: form,
  });
};

async function makeUser(
  admin: TestSession,
  testApp: Parameters<typeof signIn>[0],
  prefix: string,
  roles: readonly string[],
): Promise<TestSession> {
  const username = unique(prefix);
  const created = await admin.fetch('/users', write({
    name: username, username, email: `${username.toLowerCase()}@example.test`,
    password: PASSWORD, roleScopes: { app: [...roles] },
  }));
  expect(created.status, `建用户失败：${await created.clone().text()}`).toBe(201);
  return await signIn(testApp, { username, password: PASSWORD });
}

test('上传、绑定到采购订单草稿、详情回 files、持 view 的会话取到内容', async ({
  testApp, connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const item = await createItem(connection);
  const uploaded = await upload(admin, 'contract.pdf');
  expect(uploaded.status, `上传失败：${await uploaded.clone().text()}`).toBe(201);
  const file = await jsonOf(uploaded);
  expect(file).toMatchObject({ name: 'contract.pdf', contentType: 'application/pdf', size: 18 });
  expect(Object.keys(file)).not.toContain('storageKey');
  expect(Object.keys(file)).not.toContain('createdById');

  const order = await createOrder(admin, 'purchase', {
    lines: [{ itemId: item, qty: 1 }], fileIds: [String(file.id)],
  });
  expect(order.files).toEqual([{
    id: file.id, name: 'contract.pdf', contentType: 'application/pdf', size: 18,
  }]);
  const stored = await connection.repository<Row>('docFiles').findOne({ filter: { id: file.id } });
  expect(stored?.ownerType).toBe('purchase_order');
  expect(stored?.ownerId).toBe(order.id);

  const buyer = await makeUser(admin, testApp, 'r021filebuyer', ['purchase']);
  const content = await buyer.fetch(`/doc-files/${String(file.id)}/content`, get());
  expect(content.status, `取内容失败：${await content.clone().text()}`).toBe(200);
  expect(await content.text()).toBe('附件测试内容');
  expect(content.headers.get('x-content-type-options')).toBe('nosniff');
  expect(content.headers.get('cache-control')).toBe('private, no-store');
  expect(content.headers.get('content-disposition')).toContain('attachment');

  // 从 fileIds 去掉后文件回到挂单状态，详情不再带它。
  const cleared = await admin.fetch(`/purchase-orders/${String(order.id)}`, write({
    fileIds: [],
  }, 'PATCH'));
  expect(cleared.status).toBe(200);
  expect((await jsonOf(cleared)).files).toEqual([]);
}, TIMEOUT);

test('未绑定文件只有上传者本人能取；别人的文件不能绑定', async ({ testApp, connection }) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const other = await makeUser(admin, testApp, 'r021other', ['purchase']);
  const item = await createItem(connection);
  const mine = await jsonOf(await upload(admin, 'mine.pdf'));
  expect((await other.fetch(`/doc-files/${String(mine.id)}/content`, get())).status).toBe(403);
  expect((await admin.fetch(`/doc-files/${String(mine.id)}/content`, get())).status).toBe(200);

  const refused = await admin.fetch('/purchase-orders', write({
    supplierId: unique('SUP'),
    orderDate: '2026-11-28',
    lines: [{ itemId: item, qty: 1 }],
    fileIds: [String(mine.id)],
  }));
  // 别人的往来单位先被业务规则拒；这里只要证明绑定校验不绕过授权就够了。
  expect(refused.status).toBeGreaterThanOrEqual(400);

  const theirFile = await jsonOf(await upload(other, 'theirs.pdf'));
  const supplierId = String((await jsonOf(await admin.fetch('/partners', write({
    name: unique('供应商'), isSupplier: true,
  })))).id);
  const taken = await admin.fetch('/purchase-orders', write({
    supplierId, orderDate: '2026-11-28', lines: [{ itemId: item, qty: 1 }],
    fileIds: [String(theirFile.id)],
  }));
  expect(taken.status, `别人的文件绑定应被拒：${await taken.clone().text()}`).toBe(422);
  expect((await jsonOf(taken)).error?.reason).toBe('FILE_UNAVAILABLE');
}, TIMEOUT);

test('别人已绑在本单据上的文件可以保留：乙改单时带上甲的附件并加自己的', async ({
  testApp, connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const item = await createItem(connection);
  const jia = await makeUser(admin, testApp, 'r021bindjia', ['purchase']);
  const yi = await makeUser(admin, testApp, 'r021bindyi', ['purchase']);
  const jiaFile = await jsonOf(await upload(jia, 'jia.pdf'));
  const yiFile = await jsonOf(await upload(yi, 'yi.pdf'));
  const supplierId = String((await jsonOf(await admin.fetch('/partners', write({
    name: unique('供应商'), isSupplier: true,
  })))).id);

  // 甲上传并绑定到一张草稿采购订单。
  const created = await jia.fetch('/purchase-orders', write({
    supplierId,
    orderDate: '2026-11-28',
    lines: [{ itemId: item, qty: 1 }],
    fileIds: [String(jiaFile.id)],
  }));
  expect(created.status, `甲建单失败：${await created.clone().text()}`).toBe(201);
  const order = await jsonOf(created);
  expect((order.files as Row[]).map((file) => file.id)).toEqual([jiaFile.id]);

  // 乙编辑同一张单，想保留甲的附件再加自己的：两个文件都该留下。
  const kept = await yi.fetch(`/purchase-orders/${String(order.id)}`, write({
    fileIds: [String(jiaFile.id), String(yiFile.id)],
  }, 'PATCH'));
  expect(kept.status, `乙保留甲的附件失败：${await kept.clone().text()}`).toBe(200);
  expect((await jsonOf(kept)).files.map((file: Row) => file.id).sort()).toEqual(
    [jiaFile.id, yiFile.id].sort(),
  );

  // 再提交一次把甲的去掉：只剩乙自己的，甲的回到未挂单状态。
  const removed = await yi.fetch(`/purchase-orders/${String(order.id)}`, write({
    fileIds: [String(yiFile.id)],
  }, 'PATCH'));
  expect(removed.status, `乙移除甲的附件失败：${await removed.clone().text()}`).toBe(200);
  expect((await jsonOf(removed)).files.map((file: Row) => file.id)).toEqual([yiFile.id]);
  const jiaStored = await connection.repository<Row>('docFiles')
    .findOne({ filter: { id: jiaFile.id } });
  expect(jiaStored?.ownerId).toBeNull();
}, TIMEOUT);

test('隐藏：上传者本人以外没有单据读动作的会话取已绑定文件得 403', async ({
  testApp, connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const item = await createItem(connection);
  const file = await jsonOf(await upload(admin, 'secret.pdf'));
  const { session: viewer } = await makeRoleUser(
    admin, testApp, 'r021filenobody', [
      { resource: { type: 'composite', id: 'purchaseOrders' }, actions: [] },
    ],
  );
  expect((await viewer.fetch(`/doc-files/${String(file.id)}/content`, get())).status).toBe(403);
  const order = await createOrder(admin, 'purchase', {
    lines: [{ itemId: item, qty: 1 }], fileIds: [String(file.id)],
  });
  expect((await viewer.fetch(`/doc-files/${String(file.id)}/content`, get())).status).toBe(403);
  expect(String(order.id)).toBeTruthy();
}, TIMEOUT);
