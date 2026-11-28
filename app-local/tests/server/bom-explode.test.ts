// @vitest-environment node
import { randomUUID } from 'node:crypto';

import {
  DEFAULT_ADMIN_CREDENTIALS,
  signIn,
} from '@nocobase/app-plugin-authentication/testing';
import type { DatabaseConnection } from '@nocobase/db';
import { expect } from 'vitest';

import { createAppTest } from '../helpers/test-app.js';
import { createStandaloneServer } from '../../server/standalone.js';

/**
 * R-019 波 2 验收 3 的展开边界：深度上限、子 BOM 不可用与非法 levels。
 * 夹具行按物理结构直接落库（数据全部编造），被测的仍是通过 HTTP 的唯一递归实现。
 */
const test = createAppTest({
  createServer: createStandaloneServer,
  config: {
    app: { publicOrigin: 'http://localhost' },
    auth: { secret: 'test-auth-secret-at-least-32-characters' },
  },
});

const TIMEOUT = 30_000;
const uid = () => randomUUID();
const AS_OF = '2026-03-15';

interface Row {
  [key: string]: unknown;
}
const jsonOf = async (response: Response): Promise<Row> =>
  (await response.json()) as Row;

async function insertItem(
  connection: DatabaseConnection,
  itemType: 'product' | 'material',
): Promise<string> {
  const id = uid();
  const now = new Date();
  await connection.query
    .insertInto('items')
    .values({
      id,
      code: `X${randomUUID().replaceAll('-', '').slice(0, 12)}`,
      name: `测试物料${id.slice(0, 6)}`,
      itemType,
      unitCode: 'PCS',
      status: 'active',
      createdById: 'root',
      createdAt: now,
      updatedAt: now,
    })
    .execute();
  return id;
}

async function insertBom(
  connection: DatabaseConnection,
  productId: string,
  version: string,
  serial: number,
  status = 'active',
): Promise<{ id: string; docNo: string }> {
  const id = uid();
  const docNo = `BOM-${String(serial).padStart(4, '0')}-${uid().slice(0, 8)}`;
  const now = new Date();
  await connection.query
    .insertInto('boms')
    .values({
      id,
      docNo,
      version,
      productId,
      effectiveFrom: '2026-01-01',
      status,
      createdById: 'root',
      createdAt: now,
      updatedAt: now,
    })
    .execute();
  return { id, docNo };
}

async function insertLine(
  connection: DatabaseConnection,
  bomId: string,
  itemId: string,
  lineNo: number,
  childBomId: string | null = null,
): Promise<void> {
  await connection.query
    .insertInto('bomLines')
    .values({
      id: uid(), bomId, lineNo, itemId, qty: 1, childBomId,
    })
    .execute();
}

test('R-019 波2 验收3: 多层展开最多 32 层，超过就整次 422', async ({
  testApp,
  connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const leafItem = await insertItem(connection, 'material');
  const products = await Promise.all(
    Array.from({ length: 33 }, () => insertItem(connection, 'product')),
  );
  const boms = await Promise.all(
    products.map((productId, index) =>
      insertBom(connection, productId, `V${index}`, index + 1)),
  );
  // 从叶子往回挂，先造出 32 层链：第 0 张 BOM 的配件行指向第 1 张。
  for (let index = 0; index < 32; index += 1) {
    await insertLine(
      connection,
      boms[index]!.id,
      leafItem,
      1,
      boms[index + 1]!.id,
    );
  }

  const ok = await admin.fetch(
    `/boms/explode?productId=${products[0]}&asOf=${AS_OF}`,
    { method: 'GET' },
  );
  await expectStatus(ok, 200);
  const body = await jsonOf(ok);
  expect(body.nodes).toHaveLength(32);
  expect(Math.max(...(body.nodes as Row[]).map((node) => Number(node.depth)))).toBe(32);
  expect(body.cycles).toEqual([]);

  // 第 32 张再挂一张叶子，深度变成 33：整次拒绝，不返回半棵树。
  // 这条多出来的版本比 V32 小，选版仍取带子行的 V32，从而真的越过第 32 层。
  const extra = await insertBom(connection, products[32]!, 'AAA', 99);
  await insertLine(connection, boms[32]!.id, leafItem, 1, extra.id);
  const tooDeep = await admin.fetch(
    `/boms/explode?productId=${products[0]}&asOf=${AS_OF}`,
    { method: 'GET' },
  );
  expect(tooDeep.status).toBe(400);
  expect((await jsonOf(tooDeep)).error?.reason).toBe('BOM_INVALID_INPUT');
}, TIMEOUT);

test('R-019 波2 验收3: 子 BOM 停用/不存在/无生效版本各有规则码；levels 非法 400', async ({
  testApp,
  connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const material = await insertItem(connection, 'material');
  const parentProduct = await insertItem(connection, 'product');
  const parent = await insertBom(connection, parentProduct, 'P', 1);
  const query = `productId=${parentProduct}&asOf=${AS_OF}`;

  const inactive = await insertBom(
    connection, await insertItem(connection, 'product'), 'I', 2, 'inactive',
  );
  await insertLine(connection, parent.id, material, 1, inactive.id);
  let response = await admin.fetch(`/boms/explode?${query}`, { method: 'GET' });
  expect(response.status).toBe(422);
  expect((await jsonOf(response)).error?.reason).toBe('BOM_INACTIVE');
  await connection.query
    .deleteFrom('bomLines')
    .where('bomId', '=', parent.id)
    .execute();

  await insertLine(connection, parent.id, material, 1, uid());
  response = await admin.fetch(`/boms/explode?${query}`, { method: 'GET' });
  expect(response.status).toBe(404);
  expect((await jsonOf(response)).error?.reason).toBe('BOM_NOT_FOUND');
  await connection.query
    .deleteFrom('bomLines')
    .where('bomId', '=', parent.id)
    .execute();

  // 子 BOM 指向的成品在 asOf 没有生效版本。
  const childProduct = await insertItem(connection, 'product');
  const child = await insertBom(connection, childProduct, 'C', 3);
  await connection.query
    .updateTable('boms')
    .set({ effectiveFrom: '2027-01-01' })
    .where('id', '=', child.id)
    .execute();
  await insertLine(connection, parent.id, material, 1, child.id);
  response = await admin.fetch(`/boms/explode?${query}`, { method: 'GET' });
  expect(response.status).toBe(422);
  expect((await jsonOf(response)).error?.reason).toBe('BOM_NOT_EFFECTIVE');

  for (const levels of ['0', 'abc', '-1']) {
    response = await admin.fetch(
      `/boms/explode?${query}&levels=${levels}`, { method: 'GET' },
    );
    expect(response.status, `levels=${levels}`).toBe(400);
    expect((await jsonOf(response)).error?.reason).toBe('BOM_INVALID_INPUT');
  }
}, TIMEOUT);

async function expectStatus(response: Response, status: number): Promise<void> {
  if (response.status !== status) {
    throw new Error(`期望 ${status}，实际 ${response.status}：${await response.text()}`);
  }
}
