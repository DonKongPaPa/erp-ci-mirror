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
import { createEmployee } from '../helpers/orders.js';
import { createStandaloneServer } from '../../server/standalone.js';

/**
 * R-020 波 1 授权：仓管只有盘点建改读作废与调拨五动作；财务只多监盘与盘点读；
 * 别的角色一律 403，且先授权后读内容（非法业务值也先 403）。
 */
const test = createAppTest({
  createServer: createStandaloneServer,
  config: {
    app: { publicOrigin: 'http://localhost' },
    auth: { secret: 'test-auth-secret-at-least-32-characters' },
  },
});

const PASSWORD = 'R020-addon-authz-123!';
const ORIGIN = 'http://localhost';
const unique = (prefix: string) =>
  `${prefix}${randomUUID().replaceAll('-', '').slice(0, 10).toUpperCase()}`;
const write = (body: unknown = {}, method = 'POST'): RequestInit => ({
  method,
  headers: {
    'content-type': 'application/json', origin: ORIGIN,
    'Idempotency-Key': `${Date.now()}.${randomUUID()}`,
  },
  body: JSON.stringify(body),
});
const get = (): RequestInit => ({ method: 'GET' });
const upload = (session: TestSession): Promise<Response> => {
  const form = new FormData();
  form.append('file', new File(['abc'], 'probe.pdf', { type: 'application/pdf' }));
  return session.fetch('/doc-files', {
    method: 'POST', headers: { origin: ORIGIN }, body: form,
  });
};

interface Row { [key: string]: unknown; }
type JsonBody = Row & { items?: Row[]; error?: { reason?: string } };
const jsonOf = async (response: Response): Promise<JsonBody> => (await response.json()) as JsonBody;

async function makeUser(
  admin: TestSession,
  testApp: Parameters<typeof signIn>[0],
  name: string,
  roles: readonly string[],
): Promise<{ session: TestSession; id: string }> {
  const username = unique(name);
  const created = await admin.fetch('/users', write({
    name: username, username,
    email: `${username.toLowerCase()}@example.test`,
    password: PASSWORD,
    roleScopes: { app: [...roles] },
  }));
  expect(created.status, `建用户失败：${await created.clone().text()}`).toBe(201);
  const id = String(((await jsonOf(created)).data as Row | undefined)?.id ?? '');
  return { session: await signIn(testApp, { username, password: PASSWORD }), id };
}

test('仓管可建改读作废与过账，但不能结束盘点；财务可监盘但不能建单与过账调拨', async ({
  testApp, connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const keeper = await makeUser(admin, testApp, 'addonkeeper', ['warehouse']);
  const finance = await makeUser(admin, testApp, 'addonfinance', ['finance']);
  await createEmployee(connection, finance.id);
  const warehouseId = String((await jsonOf(await admin.fetch('/warehouses', write({
    code: unique('WH'), name: '授权测试仓',
  })))).id);
  const itemId = await createItem(connection);

  // 附件摘要只回四列：storageKey 与上传人不外泄。
  const uploaded = await jsonOf(await upload(keeper.session));
  expect(Object.keys(uploaded)).not.toContain('storageKey');
  const created = await jsonOf(await keeper.session.fetch('/stocktakings', write({
    warehouseId, fileIds: [String(uploaded.id)],
    lines: [{ itemId, actualQty: 3 }],
  })));
  const detail = await jsonOf(await keeper.session.fetch(`/stocktakings/${String(created.id)}`, get()));
  expect(detail.files).toEqual([{
    id: uploaded.id, name: 'probe.pdf', contentType: 'application/pdf', size: 3,
  }]);
  for (const key of ['createdById', 'storageKey', 'uploadedById', 'uploadedBy']) {
    expect(Object.keys(detail)).not.toContain(key);
    for (const file of (detail.files ?? []) as Row[]) expect(Object.keys(file)).not.toContain(key);
  }
  const listed = await jsonOf(await keeper.session.fetch('/stocktakings', get()));
  expect(listed.items?.[0]?.files).toBeUndefined();
  expect(listed.items?.[0]?.lines).toBeUndefined();

  const deniedFinish = await keeper.session.fetch(`/stocktakings/${String(created.id)}/finish`, write({
    supervisorUserId: 'no-such-person',
  }));
  expect(deniedFinish.status, '仓管不能监盘结束').toBe(403);
  expect((await jsonOf(deniedFinish)).error?.reason).not.toBe('STOCK_PERSON_INVALID');

  const finished = await finance.session.fetch(`/stocktakings/${String(created.id)}/finish`, write({
    supervisorUserId: finance.id,
  }));
  expect(finished.status, `财务监盘失败：${await finished.clone().text()}`).toBe(200);
  expect((await jsonOf(finished)).stocktaking?.status).toBe('finished');

  const deniedCreate = await finance.session.fetch('/stocktakings', write({
    warehouseId: 'no-such-warehouse', lines: [],
  }));
  expect(deniedCreate.status, '财务不能建盘点单').toBe(403);
  expect((await jsonOf(deniedCreate)).error?.reason).not.toBe('WAREHOUSE_NOT_FOUND');

  const transfer = await jsonOf(await keeper.session.fetch('/transfers', write({
    transferInWarehouseId: warehouseId,
    lines: [{ itemId, qty: 2 }],
  })));
  const transferId = String(transfer.id);
  expect((await keeper.session.fetch(`/transfers/${transferId}`, write({ remark: '改过' }, 'PATCH'))).status).toBe(200);
  expect((await keeper.session.fetch(`/transfers/${transferId}/post`, write())).status).toBe(200);
  expect((await finance.session.fetch(`/transfers/${transferId}/post`, write())).status).toBe(403);
  expect((await finance.session.fetch('/transfers', get())).status).toBe(403);
});

test('其余角色对十二个端点一律 403，且响应里没有单据内容', async ({ testApp, connection }) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const warehouseId = String((await jsonOf(await admin.fetch('/warehouses', write({
    code: unique('WH'), name: '旁人仓',
  })))).id);
  const itemId = await createItem(connection);
  const stocktaking = await jsonOf(await admin.fetch('/stocktakings', write({
    warehouseId, lines: [{ itemId }],
  })));
  const transfer = await jsonOf(await admin.fetch('/transfers', write({
    transferInWarehouseId: warehouseId, lines: [{ itemId, qty: 1 }],
  })));
  const stocktakingId = String(stocktaking.id);
  const transferId = String(transfer.id);

  const others = await Promise.all([
    makeUser(admin, testApp, 'addonstaff', ['staff']),
    makeUser(admin, testApp, 'addonquality', ['quality_manager']),
    makeUser(admin, testApp, 'addoninspector', ['quality_inspector']),
    makeUser(admin, testApp, 'addondept', ['dept_manager']),
    makeUser(admin, testApp, 'addonpurchase', ['purchase']),
    makeUser(admin, testApp, 'addonsales', ['sales']),
    makeUser(admin, testApp, 'addonmember', []),
  ]);
  for (const { session } of others) {
    const responses = [
      await session.fetch('/stocktakings', get()),
      await session.fetch(`/stocktakings/${stocktakingId}`, get()),
      await session.fetch('/stocktakings', write({ warehouseId: 'no-such', lines: [] })),
      await session.fetch(`/stocktakings/${stocktakingId}`, write({ remark: 'x' }, 'PATCH')),
      await session.fetch(`/stocktakings/${stocktakingId}/finish`, write({ supervisorUserId: 'no-such' })),
      await session.fetch(`/stocktakings/${stocktakingId}/void`, write()),
      await session.fetch('/transfers', get()),
      await session.fetch(`/transfers/${transferId}`, get()),
      await session.fetch('/transfers', write({ transferInWarehouseId: 'no-such', lines: [] })),
      await session.fetch(`/transfers/${transferId}`, write({ remark: 'x' }, 'PATCH')),
      await session.fetch(`/transfers/${transferId}/post`, write()),
      await session.fetch(`/transfers/${transferId}/void`, write()),
    ];
    for (const response of responses) {
      expect(response.status, '这十二个端点不该给别的角色').toBe(403);
      const body = await jsonOf(response);
      expect(Object.keys(body)).toEqual(['error']);
      expect(body.docNo).toBeUndefined();
      expect(body.lines).toBeUndefined();
      expect(['WAREHOUSE_NOT_FOUND', 'STOCK_PERSON_INVALID', 'STOCKTAKE_NOT_FOUND',
        'TRANSFER_NOT_FOUND']).not.toContain(body.error?.reason ?? '');
    }
  }
});
