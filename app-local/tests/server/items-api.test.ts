// @vitest-environment node
import { randomUUID } from 'node:crypto';

import {
  DEFAULT_ADMIN_CREDENTIALS,
  signIn,
  type TestSession,
} from '@nocobase/app-plugin-authentication/testing';
import { expect } from 'vitest';

import { createAppTest } from '../helpers/test-app.js';
import { createStandaloneServer } from '../../server/standalone.js';

/**
 * R-019 MVP 验收 2–5：真 Postgres 上的发号、编码不可变、停用与单位被引用。
 *
 * 每条断言都从真库读回写入结果；所有请求带 Origin 与操作键（写端点的框架前置条件）。
 * 服务端就是被测的一半：这里不替接口回答。
 */
const test = createAppTest({
  createServer: createStandaloneServer,
  config: {
    app: { publicOrigin: 'http://localhost' },
    auth: { secret: 'test-auth-secret-at-least-32-characters' },
  },
});

const ORIGIN = 'http://localhost';
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
type JsonBody = Row & {
  items?: Row[];
  error?: { reason?: string; message?: string };
};
const jsonOf = async (response: Response): Promise<JsonBody> =>
  (await response.json()) as JsonBody;

async function expectStatus(response: Response, status: number): Promise<void> {
  if (response.status !== status) {
    throw new Error(`期望 ${status}，实际 ${response.status}：${await response.text()}`);
  }
}

const createUnit = async (
  session: TestSession,
  code: string,
  decimals = 0,
): Promise<Row> => {
  const response = await session.fetch('/units', write({ code, name: `单位${code}`, decimals }));
  await expectStatus(response, 201);
  return await jsonOf(response);
};

const createCategory = async (
  session: TestSession,
  code: string,
): Promise<Row> => {
  const response = await session.fetch('/item-categories', write({
    id: randomUUID(),
    code,
    name: `分类${code}`,
    parentId: null,
  }));
  await expectStatus(response, 201);
  return await jsonOf(response);
};

const createItem = async (
  session: TestSession,
  unitCode: string,
  itemType: 'material' | 'product' = 'material',
  extra: Row = {},
): Promise<Row> => {
  const response = await session.fetch('/items', write({
    name: `物料${unique('N')}`,
    itemType,
    unitCode,
    ...extra,
  }));
  await expectStatus(response, 201);
  return await jsonOf(response);
};

test('R-019 验收2: 建物料与产品由发号服务自动发 M / P 号，编码全表唯一', async ({
  testApp,
  connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const unitCode = unique('U');
  await createUnit(admin, unitCode);

  const material = await createItem(admin, unitCode, 'material');
  const product = await createItem(admin, unitCode, 'product');
  expect(material.itemType).toBe('material');
  expect(product.itemType).toBe('product');
  // 底座的格式是 前缀-yyyymmdd-四位序号（main 发号器），满位自动进位。
  expect(String(material.code)).toMatch(/^M-\d{8}-\d{4,}$/u);
  expect(String(product.code)).toMatch(/^P-\d{8}-\d{4,}$/u);
  expect(material.id).not.toBe(product.id);

  const stored = await connection
    .repository<Row>('items')
    .findOne({ filter: { id: String(material.id) } });
  expect(stored?.code).toBe(material.code);
  expect(stored?.status).toBe('active');
  expect(stored?.createdById).toBeDefined();

  // 请求体里带 code 也发号，不会用客户端给的码。
  const forced = await createItem(admin, unitCode, 'material', {
    code: 'HACKED',
  });
  expect(String(forced.code)).toMatch(/^M-\d{8}-\d{4,}$/u);
  expect(forced.code).not.toBe('HACKED');
});

test('R-019 验收3: 改字段不改编码；PATCH 带 code 被 422 拒且库里的行不变', async ({
  testApp,
  connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const unitCode = unique('U');
  const categoryCode = unique('C');
  await createUnit(admin, unitCode);
  const category = await createCategory(admin, categoryCode);
  const item = await createItem(admin, unitCode);
  const id = String(item.id);
  const before = await connection
    .repository<Row>('items')
    .findOne({ filter: { id } });
  expect(before).toBeDefined();

  const patched = await admin.fetch(
    `/items/${id}`,
    write({
      name: '新名称',
      spec: '规格A',
      categoryCode,
      note: '备注',
    }, 'PATCH'),
  );
  await expectStatus(patched, 200);
  const row = await jsonOf(patched);
  expect(row).toMatchObject({
    id,
    code: item.code,
    name: '新名称',
    spec: '规格A',
    categoryCode,
    note: '备注',
  });
  expect(String(category.id)).not.toBe('');

  const immutable = await admin.fetch(
    `/items/${id}`,
    write({ name: '试图改码', code: unique('X') }, 'PATCH'),
  );
  await expectStatus(immutable, 422);
  expect((await jsonOf(immutable)).error?.reason).toBe('ITEM_CODE_IMMUTABLE');

  const empty = await admin.fetch(`/items/${id}`, write({}, 'PATCH'));
  await expectStatus(empty, 422);
  expect((await jsonOf(empty)).error?.reason).toBe('ITEM_EMPTY_PATCH');

  const after = await connection
    .repository<Row>('items')
    .findOne({ filter: { id } });
  expect(after?.name).toBe('新名称');
  expect(after?.code).toBe(item.code);
  // 被 422 拒的请求没有把编码写进库。
  expect(after?.code).not.toBe('HACKED');
});

test('R-019 验收4: 停用后不在在用列表，详情仍读得到；已停用物料先启用才能改', async ({
  testApp,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const unitCode = unique('U');
  await createUnit(admin, unitCode);
  const item = await createItem(admin, unitCode);
  const id = String(item.id);

  const deactivated = await admin.fetch(
    `/items/${id}`,
    write({ status: 'inactive' }, 'PATCH'),
  );
  await expectStatus(deactivated, 200);
  expect((await jsonOf(deactivated)).status).toBe('inactive');

  const activeList = await jsonOf(
    await admin.fetch('/items?status=active', get()),
  );
  expect(activeList.items?.map((row) => String(row.id))).not.toContain(id);
  const detail = await admin.fetch(`/items/${id}`, get());
  await expectStatus(detail, 200);
  expect((await jsonOf(detail)).status).toBe('inactive');

  const forbidden = await admin.fetch(
    `/items/${id}`,
    write({ name: '停用后改名' }, 'PATCH'),
  );
  await expectStatus(forbidden, 422);
  expect((await jsonOf(forbidden)).error?.reason).toBe('ITEM_INACTIVE');

  const reactivated = await admin.fetch(
    `/items/${id}`,
    write({ status: 'active' }, 'PATCH'),
  );
  await expectStatus(reactivated, 200);
  expect((await jsonOf(reactivated)).status).toBe('active');
});

test('R-019 验收5: 单位被物料引用时不能停用，改用别的单位后才停用成功', async ({
  testApp,
  connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const usedUnit = unique('U');
  const spareUnit = unique('U');
  await createUnit(admin, usedUnit);
  await createUnit(admin, spareUnit);
  const item = await createItem(admin, usedUnit);
  const id = String(item.id);

  const blocked = await admin.fetch(
    `/units/${usedUnit}`,
    write({ status: 'inactive' }, 'PATCH'),
  );
  await expectStatus(blocked, 422);
  expect((await jsonOf(blocked)).error?.reason).toBe('UNIT_IN_USE');
  const stillActive = await connection
    .repository<Row>('units')
    .findOne({ filter: { code: usedUnit } });
  expect(stillActive?.status).toBe('active');

  const moved = await admin.fetch(
    `/items/${id}`,
    write({ unitCode: spareUnit }, 'PATCH'),
  );
  await expectStatus(moved, 200);
  const released = await admin.fetch(
    `/units/${usedUnit}`,
    write({ status: 'inactive' }, 'PATCH'),
  );
  await expectStatus(released, 200);
  expect((await jsonOf(released)).status).toBe('inactive');

  // 停用单位不能再被新物料引用。
  const rejected = await admin.fetch('/items', write({
    name: '用停用单位',
    itemType: 'material',
    unitCode: usedUnit,
  }));
  await expectStatus(rejected, 422);
  expect((await jsonOf(rejected)).error?.reason).toBe('UNIT_INACTIVE');
});

test('R-019 验收1/接口契约: 单位与分类的建改、重复码、列表筛选与 404', async ({
  testApp,
  connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const unitCode = unique('U');
  const categoryCode = unique('C');
  const unit = await createUnit(admin, unitCode, 2);
  expect(unit).toMatchObject({ code: unitCode, decimals: 2, status: 'active' });
  const category = await createCategory(admin, categoryCode);
  expect(category).toMatchObject({ code: categoryCode, status: 'active' });

  const dupUnit = await admin.fetch('/units', write({
    code: unitCode,
    name: '重复',
  }));
  await expectStatus(dupUnit, 409);
  expect((await jsonOf(dupUnit)).error?.reason).toBe('UNIT_CODE_TAKEN');
  const dupCategory = await admin.fetch('/item-categories', write({
    id: randomUUID(),
    code: categoryCode,
    name: '重复',
  }));
  await expectStatus(dupCategory, 409);
  expect((await jsonOf(dupCategory)).error?.reason).toBe('CATEGORY_CODE_TAKEN');

  const renamed = await admin.fetch(
    `/units/${unitCode}`,
    write({ name: '新单位名' }, 'PATCH'),
  );
  await expectStatus(renamed, 200);
  expect((await jsonOf(renamed)).name).toBe('新单位名');
  const stored = await connection
    .repository<Row>('units')
    .findOne({ filter: { code: unitCode } });
  expect(stored?.name).toBe('新单位名');

  const selfParent = await admin.fetch(
    `/item-categories/${category.id}`,
    write({ parentId: category.id }, 'PATCH'),
  );
  await expectStatus(selfParent, 422);
  expect((await jsonOf(selfParent)).error?.reason).toBe('CATEGORY_INVALID_PARENT');

  const missing = await admin.fetch(`/items/${randomUUID()}`, get());
  await expectStatus(missing, 404);
  expect((await jsonOf(missing)).error?.reason).toBe('ITEM_NOT_FOUND');

  const unitList = await jsonOf(
    await admin.fetch(`/units?q=${encodeURIComponent('新单位名')}`, get()),
  );
  expect(unitList.items?.some((row) => row.code === unitCode)).toBe(true);
  const categoryList = await jsonOf(
    await admin.fetch(`/item-categories?status=active`, get()),
  );
  expect(categoryList.items?.some((row) => row.code === categoryCode)).toBe(true);
});

test('R-019 接口契约: 物料列表按类型、分类、状态与 q 筛选并分页', async ({
  testApp,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const unitCode = unique('U');
  const categoryCode = unique('C');
  await createUnit(admin, unitCode);
  const category = await createCategory(admin, categoryCode);
  const material = await createItem(admin, unitCode, 'material', {
    categoryCode,
    spec: 'UniqueSpec-42',
  });
  const product = await createItem(admin, unitCode, 'product');

  const byType = await jsonOf(
    await admin.fetch('/items?itemType=product', get()),
  );
  expect(byType.items?.map((row) => String(row.id))).toContain(String(product.id));
  expect(byType.items?.map((row) => String(row.id))).not.toContain(String(material.id));

  const byCategory = await jsonOf(
    await admin.fetch(`/items?categoryCode=${categoryCode}`, get()),
  );
  expect(byCategory.items?.map((row) => String(row.id))).toContain(String(material.id));
  expect(byCategory.items?.map((row) => String(row.id))).not.toContain(String(product.id));
  expect(String(category.code)).toBe(categoryCode);

  const byQuery = await jsonOf(
    await admin.fetch('/items?q=uniquespec-42', get()),
  );
  expect(byQuery.items?.map((row) => String(row.id))).toEqual([String(material.id)]);

  const paged = await jsonOf(
    await admin.fetch('/items?page=1&pageSize=1', get()),
  );
  expect(paged.items).toHaveLength(1);
  expect(paged).toMatchObject({ page: 1, pageSize: 1 });
  expect(paged.total).toBeGreaterThanOrEqual(2);
});
