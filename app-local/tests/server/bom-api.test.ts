// @vitest-environment node
import { randomUUID } from 'node:crypto';

import {
  DEFAULT_ADMIN_CREDENTIALS,
  signIn,
  type TestSession,
} from '@nocobase/app-plugin-authentication/testing';
import { databaseManagerToken } from '@nocobase/db';
import { expect } from 'vitest';

import { docFilesToken } from '../../server/providers/doc-files.js';
import {
  bomsReaderToken,
  DatabaseBomsMutations,
} from '../../server/providers/boms.js';
import type { CodeService } from '../../server/providers/codes.js';
import { createAppTest } from '../helpers/test-app.js';
import { createStandaloneServer } from '../../server/standalone.js';

/**
 * R-019 波 2 验收 2–5 的正向路径：真 Postgres 上建两版 BOM、按生效日期选版，
 * 单层与多层展开的形状、用量累乘、按物料汇总、默认位与唯一、环检测。
 * 全部经 root 会话走真端点；没有替接口回答。
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

async function createItem(
  session: TestSession,
  unitCode: string,
  itemType: 'material' | 'product',
  extra: Row = {},
): Promise<Row> {
  const response = await session.fetch('/items', write({
    name: unique('物料'),
    itemType,
    unitCode,
    ...extra,
  }));
  await expectStatus(response, 201);
  return await jsonOf(response);
}

async function createBom(session: TestSession, body: Row): Promise<Row> {
  const response = await session.fetch('/boms', write(body));
  await expectStatus(response, 201);
  return await jsonOf(response);
}

async function explode(
  session: TestSession,
  query: string,
): Promise<{ status: number; body: Row }> {
  const response = await session.fetch(`/boms/explode?${query}`, get());
  return { status: response.status, body: await jsonOf(response) };
}

const nodesOf = (body: Row): Row[] =>
  Array.isArray(body.nodes) ? (body.nodes as Row[]) : [];
const totalsOf = (body: Row): Row[] =>
  Array.isArray(body.totals) ? (body.totals as Row[]) : [];
const totalOf = (body: Row, itemId: string): Row | undefined =>
  totalsOf(body).find((row) => row.itemId === itemId);
const nodeOf = (body: Row, itemId: string): Row | undefined =>
  nodesOf(body).find((row) => row.itemId === itemId);

test('R-019 波2 验收2/3: 两版按生效日期取，单层与多层展开形状、用量累乘与汇总正确', async ({
  testApp,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const unit = unique('U');
  await expectStatus(
    await admin.fetch('/units', write({ code: unit, name: '单位' })),
    201,
  );
  const product = await createItem(admin, unit, 'product');
  const childProduct = await createItem(admin, unit, 'product');
  const materialA = await createItem(admin, unit, 'material', { basePurchasePrice: 11.5 });
  const materialB = await createItem(admin, unit, 'material');
  const materialC = await createItem(admin, unit, 'material', { basePurchasePrice: 7 });
  const shared = await createItem(admin, unit, 'material', { basePurchasePrice: 3 });
  const productId = String(product.id);
  const aId = String(materialA.id);
  const bId = String(materialB.id);
  const cId = String(materialC.id);
  const sharedId = String(shared.id);

  // 子件两版按日期生效：3 月取 A，8 月取 B。
  const childA = await createBom(admin, {
    version: 'A',
    productId: String(childProduct.id),
    effectiveFrom: '2026-01-01',
    effectiveTo: '2026-05-31',
    lines: [
      { itemId: cId, qty: 4, lossRate: 0.25 },
      { itemId: sharedId, qty: 2, lossRate: 0 },
    ],
  });
  await createBom(admin, {
    version: 'B',
    productId: String(childProduct.id),
    effectiveFrom: '2026-06-01',
    effectiveTo: '2026-12-31',
    lines: [{ itemId: cId, qty: 2, lossRate: 0 }],
  });

  const main = await createBom(admin, {
    version: '1',
    productId,
    effectiveFrom: '2026-01-01',
    lines: [
      { itemId: aId, qty: 2, lossRate: 0.1 },
      { itemId: bId, qty: 3 },
      { itemId: sharedId, qty: 1, lossRate: 0, childBomId: childA.id },
    ],
  });

  // 另一个成品两版、区间不重叠：按 asOf 各取一版。
  const other = await createItem(admin, unit, 'product');
  const otherId = String(other.id);
  const first = await createBom(admin, {
    version: 'FIRST',
    productId: otherId,
    effectiveFrom: '2026-01-01',
    effectiveTo: '2026-04-30',
    lines: [{ itemId: aId, qty: 1 }],
  });
  const second = await createBom(admin, {
    version: 'SECOND',
    productId: otherId,
    effectiveFrom: '2026-09-01',
    effectiveTo: '2026-12-31',
    lines: [{ itemId: bId, qty: 1 }],
  });

  for (const [asOf, expected] of [['2026-03-15', first], ['2026-10-01', second]] as const) {
    const response = await admin.fetch(
      `/boms/effective?productId=${otherId}&asOf=${asOf}`,
      get(),
    );
    await expectStatus(response, 200);
    const body = await jsonOf(response);
    const bom = body.bom as Row;
    expect(String(bom.bomId)).toBe(String(expected.id));
    expect(bom.version).toBe(expected.version);
  }

  const march = await explode(admin, `productId=${productId}&asOf=2026-03-15`);
  expect(march.status).toBe(200);
  expect(String((march.body.root as Row).bomId)).toBe(String(main.id));
  expect(march.body.cycles).toEqual([]);
  expect(march.body.levels).toBeGreaterThanOrEqual(2);
  const marchNodes = nodesOf(march.body);
  // 三个直系行 + 子 BOM 的两行（子 BOM 建了两行配件）。
  expect(marchNodes).toHaveLength(5);
  expect(nodeOf(march.body, aId)?.effectiveQty).toBe(2.2);
  expect(nodeOf(march.body, bId)?.effectiveQty).toBe(3);
  expect(nodeOf(march.body, sharedId)?.depth).toBe(1);
  const childNode = marchNodes.find((row) => String(row.itemId) === cId);
  expect(childNode, '3 月应展开子 BOM 的配件').toBeDefined();
  expect(childNode?.depth).toBe(2);
  expect(childNode?.effectiveQty).toBe(5);
  expect(childNode?.parentNodeId).toBe(
    nodeOf(march.body, sharedId)?.nodeId,
  );
  expect((childNode?.bomId as string | undefined) ?? '').toBe(String(childA.id));
  expect((childNode?.version as string | undefined) ?? '').toBe('A');
  // 跨层同名物料相加：1 层 1 个 + 子层 2 个（沿 shared 那一行的用量）= 3。
  expect(Number(totalOf(march.body, sharedId)?.qty)).toBe(3);
  expect(Number(totalOf(march.body, cId)?.qty)).toBe(5);

  const august = await explode(admin, `productId=${productId}&asOf=2026-08-15`);
  expect(august.status).toBe(200);
  const augustChild = nodesOf(august.body).find((row) => row.itemId === cId);
  expect(augustChild?.version).toBe('B');
  expect(augustChild?.effectiveQty).toBe(2);
  expect(Number(totalOf(august.body, sharedId)?.qty)).toBe(1);

  const one = await explode(
    admin,
    `productId=${productId}&asOf=2026-03-15&levels=1`,
  );
  expect(one.status).toBe(200);
  expect(one.body.levels).toBe(1);
  expect(nodesOf(one.body)).toHaveLength(3);
  expect(
    nodesOf(one.body).some((row) => row.itemId === cId),
    '单层不该展开子层',
  ).toBe(false);
}, TIMEOUT);

test('R-019 波2 验收2/6: 展开按成本动作出金额键；详情不回建单人与两个基准价', async ({
  testApp,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const unit = unique('U');
  await expectStatus(
    await admin.fetch('/units', write({ code: unit, name: '单位' })),
    201,
  );
  const product = await createItem(admin, unit, 'product');
  const material = await createItem(admin, unit, 'material', {
    basePurchasePrice: 11.5,
    baseSalesPrice: 99.75,
    brand: '品牌甲',
    manufacturerModel: '型号乙',
  });
  const bom = await createBom(admin, {
    version: '1',
    productId: String(product.id),
    effectiveFrom: '2026-01-01',
    lines: [{ itemId: String(material.id), qty: 2 }],
  });

  const detailed = await jsonOf(
    await admin.fetch(`/boms/${String(bom.id)}`, get()),
  );
  expect(has(detailed, 'createdById')).toBe(false);
  const line = (detailed.lines as Row[])[0];
  const item = line.item as Row;
  expect(Object.keys(item).sort()).toEqual([
    'brand', 'code', 'id', 'manufacturerModel', 'name', 'spec', 'unitCode',
  ]);
  expect(has(item, 'basePurchasePrice')).toBe(false);
  expect(has(item, 'baseSalesPrice')).toBe(false);
  const productBrief = detailed.product as Row;
  expect(has(productBrief, 'basePurchasePrice')).toBe(false);
  expect(has(productBrief, 'baseSalesPrice')).toBe(false);

  const cost = await explode(
    admin,
    `productId=${String(product.id)}&asOf=2026-03-15&includeCost=1`,
  );
  expect(cost.status).toBe(200);
  const total = totalOf(cost.body, String(material.id));
  expect(total?.basePurchasePrice).toBe(11.5);
  expect(total?.estimatedCost).toBe(23);

  // 不带 includeCost 时即使持有价格动作也不出金额键。
  const plain = await explode(
    admin,
    `productId=${String(product.id)}&asOf=2026-03-15`,
  );
  expect(has(totalOf(plain.body, String(material.id)), 'basePurchasePrice')).toBe(false);
  expect(has(totalOf(plain.body, String(material.id)), 'estimatedCost')).toBe(false);
}, TIMEOUT);

test('R-019 波2 验收4: 默认位互斥、同 docNo 版本唯一、无生效版本 422', async ({
  app,
  testApp,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const unit = unique('U');
  await expectStatus(
    await admin.fetch('/units', write({ code: unit, name: '单位' })),
    201,
  );
  const product = await createItem(admin, unit, 'product');
  const material = await createItem(admin, unit, 'material');
  const productId = String(product.id);
  const line = [{ itemId: String(material.id), qty: 1 }];

  const first = await createBom(admin, {
    version: 'A',
    productId,
    effectiveFrom: '2026-01-01',
    isDefault: true,
    lines: line,
  });
  const second = await createBom(admin, {
    version: 'B',
    productId,
    effectiveFrom: '2026-06-01',
    isDefault: true,
    lines: line,
  });
  const after = await jsonOf(
    await admin.fetch(`/boms/${String(first.id)}`, get()),
  );
  expect(after.isDefault).toBe(false);
  const secondAfter = await jsonOf(
    await admin.fetch(`/boms/${String(second.id)}`, get()),
  );
  expect(secondAfter.isDefault).toBe(true);

  // 发号器在正常情况下每次给新 docNo，HTTP 路径撞不到「同 docNo 同版本」。
  // 用返回既有 docNo 的假发号器调真写服务，钉住 409 的规则码映射；
  // 数据库唯一约束本身由迁移测试钉住。
  const stubCodes = {
    nextCode: async () => String(second.docNo),
  } as unknown as CodeService;
  const mutations = new DatabaseBomsMutations(
    app.container.resolve(databaseManagerToken),
    stubCodes,
    app.container.resolve(docFilesToken),
    app.container.resolve(bomsReaderToken),
  );
  await expect(mutations.create({
    version: 'B',
    productId,
    effectiveFrom: '2026-07-01',
    lines: line,
  }, 'root')).rejects.toMatchObject({ code: 'version-taken' });
  const unchanged = await jsonOf(
    await admin.fetch(`/boms/${String(second.id)}`, get()),
  );
  expect(unchanged.version).toBe('B');

  const gap = await admin.fetch(
    `/boms/effective?productId=${productId}&asOf=2020-01-01`,
    get(),
  );
  expect(gap.status).toBe(422);
  expect((await jsonOf(gap)).error?.reason).toBe('BOM_NOT_EFFECTIVE');
}, TIMEOUT);

test('R-019 波2 验收5: PATCH 造成环被 422 拒；库内已有环时展开整次失败', async ({
  testApp,
  connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const unit = unique('U');
  await expectStatus(
    await admin.fetch('/units', write({ code: unit, name: '单位' })),
    201,
  );
  const productA = await createItem(admin, unit, 'product');
  const productB = await createItem(admin, unit, 'product');
  const material = await createItem(admin, unit, 'material');
  const a = await createBom(admin, {
    version: 'A1',
    productId: String(productA.id),
    effectiveFrom: '2026-01-01',
    lines: [{ itemId: String(material.id), qty: 1 }],
  });
  const b = await createBom(admin, {
    version: 'B1',
    productId: String(productB.id),
    effectiveFrom: '2026-01-01',
    lines: [{ itemId: String(material.id), qty: 1 }],
  });

  // B -> A 先落库；再让 A -> B，PATCH 必须拒绝（否则就成环）。
  const towardA = await admin.fetch(`/boms/${String(b.id)}`, write({
    lines: [{ itemId: String(material.id), qty: 1, childBomId: a.id }],
  }, 'PATCH'));
  await expectStatus(towardA, 200);
  const towardB = await admin.fetch(`/boms/${String(a.id)}`, write({
    lines: [{ itemId: String(material.id), qty: 1, childBomId: b.id }],
  }, 'PATCH'));
  expect(towardB.status).toBe(422);
  expect((await jsonOf(towardB)).error?.reason).toBe('BOM_CYCLE');
  const selfLoop = await admin.fetch(`/boms/${String(a.id)}`, write({
    lines: [{ itemId: String(material.id), qty: 1, childBomId: a.id }],
  }, 'PATCH'));
  expect(selfLoop.status).toBe(422);
  expect((await jsonOf(selfLoop)).error?.reason).toBe('BOM_CYCLE');

  // 绕过服务写成 A -> B，展开必须在递归处整次失败，不返回半棵树。
  await connection.query
    .insertInto('bomLines')
    .values({
      id: randomUUID(),
      bomId: String(a.id),
      lineNo: 2,
      itemId: String(material.id),
      qty: 1,
      childBomId: String(b.id),
    })
    .execute();
  const result = await explode(
    admin,
    `productId=${String(productA.id)}&asOf=2026-03-15`,
  );
  expect(result.status).toBe(422);
  expect(result.body.error?.reason).toBe('BOM_CYCLE');
  expect(result.body.nodes).toBeUndefined();
}, TIMEOUT);

test('R-019 波2: 没有 DELETE，停用后不参与展开', async ({ testApp }) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const unit = unique('U');
  await expectStatus(
    await admin.fetch('/units', write({ code: unit, name: '单位' })),
    201,
  );
  const product = await createItem(admin, unit, 'product');
  const material = await createItem(admin, unit, 'material');
  const bom = await createBom(admin, {
    version: '1',
    productId: String(product.id),
    effectiveFrom: '2026-01-01',
    lines: [{ itemId: String(material.id), qty: 1 }],
  });

  const removed = await admin.fetch(`/boms/${String(bom.id)}`, {
    method: 'DELETE',
    headers: { origin: ORIGIN },
  });
  expect([404, 405]).toContain(removed.status);
  const voided = await admin.fetch(`/boms/${String(bom.id)}/void`, write());
  await expectStatus(voided, 200);
  expect((await jsonOf(voided)).status).toBe('inactive');
  const result = await explode(
    admin,
    `productId=${String(product.id)}&asOf=2026-03-15`,
  );
  expect(result.status).toBe(422);
  expect(result.body.error?.reason).toBe('BOM_NOT_EFFECTIVE');
}, TIMEOUT);

/** 主会话审读：B 的多条子链接里，指向 A 的那行排在第二行也必须查到。 */
async function cycleFixture(admin: TestSession) {
  const unit = unique('U');
  await expectStatus(
    await admin.fetch('/units', write({ code: unit, name: '单位' })),
    201,
  );
  const aProduct = await createItem(admin, unit, 'product');
  const bProduct = await createItem(admin, unit, 'product');
  const cProduct = await createItem(admin, unit, 'product');
  const dProduct = await createItem(admin, unit, 'product');
  const first = await createItem(admin, unit, 'material');
  const second = await createItem(admin, unit, 'material');
  const third = await createItem(admin, unit, 'material');
  const make = (product: Row, item: Row) => createBom(admin, {
    version: '1',
    productId: String(product.id),
    effectiveFrom: '2026-01-01',
    lines: [{ itemId: String(item.id), qty: 1 }],
  });
  const a = await make(aProduct, third);
  const b = await make(bProduct, first);
  const c = await make(cProduct, second);
  const d = await make(dProduct, third);
  return {
    aId: String(a.id),
    bId: String(b.id),
    cId: String(c.id),
    dId: String(d.id),
    firstId: String(first.id),
    secondId: String(second.id),
    thirdId: String(third.id),
  };
}

test('R-019 波2 审读修正: 第二条子链接成环时 PATCH 422 且库里没写入', async ({
  testApp,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const f = await cycleFixture(admin);
  // B 的第一条子链接走 C（不成环），第二条才指向 A。
  const setup = await admin.fetch(`/boms/${f.bId}`, write({
    lines: [
      { itemId: f.firstId, qty: 1, childBomId: f.cId },
      { itemId: f.secondId, qty: 1, childBomId: f.aId },
    ],
  }, 'PATCH'));
  await expectStatus(setup, 200);

  const denied = await admin.fetch(`/boms/${f.aId}`, write({
    lines: [{ itemId: f.thirdId, qty: 1, childBomId: f.bId }],
  }, 'PATCH'));
  expect(denied.status).toBe(422);
  expect((await jsonOf(denied)).error?.reason).toBe('BOM_CYCLE');

  const stored = await jsonOf(await admin.fetch(`/boms/${f.aId}`, get()));
  expect(stored.lines).toHaveLength(1);
  expect((stored.lines as Row[])[0]?.childBomId).toBeNull();
}, TIMEOUT);

test('R-019 波2 审读修正: 两条子链接都不回指 A 时同样的 PATCH 成功', async ({
  testApp,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const f = await cycleFixture(admin);
  const setup = await admin.fetch(`/boms/${f.bId}`, write({
    lines: [
      { itemId: f.firstId, qty: 1, childBomId: f.cId },
      { itemId: f.secondId, qty: 1, childBomId: f.dId },
    ],
  }, 'PATCH'));
  await expectStatus(setup, 200);

  const saved = await admin.fetch(`/boms/${f.aId}`, write({
    lines: [{ itemId: f.thirdId, qty: 1, childBomId: f.bId }],
  }, 'PATCH'));
  await expectStatus(saved, 200);
  const stored = await jsonOf(await admin.fetch(`/boms/${f.aId}`, get()));
  expect((stored.lines as Row[])[0]?.childBomId).toBe(f.bId);
}, TIMEOUT);

/**
 * BOM 页面片的最小服务端追加：列表端点的 z.object 原本只透传 productId / effectiveOn，
 * 页面按状态筛时 status 被剥掉。这里钉住 status 逐项透传，授权范围不变（仍要 boms.view）。
 */
test('BOM 页面片: 列表按 status 筛选，页面拿得到停用单', async ({ testApp }) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const unit = unique('U');
  await expectStatus(
    await admin.fetch('/units', write({ code: unit, name: '单位' })),
    201,
  );
  const product = await createItem(admin, unit, 'product');
  const material = await createItem(admin, unit, 'material');
  await createBom(admin, {
    version: '1',
    productId: String(product.id),
    effectiveFrom: '2026-01-01',
    lines: [{ itemId: String(material.id), qty: 1 }],
  });

  const active = await jsonOf(await admin.fetch('/boms?status=active', get()));
  expect(active.total).toBeGreaterThanOrEqual(0);
  const inactive = await jsonOf(
    await admin.fetch(`/boms?status=inactive&productId=${String(product.id)}`, get()),
  );
  expect(inactive.total).toBe(0);

  const list = await jsonOf(await admin.fetch('/boms', get()));
  const found = (list.items as Row[]).find(
    (row) => row.product?.id === product.id,
  );
  expect(found).toBeDefined();
  const voided = await admin.fetch(
    `/boms/${String(found!.id)}/void`,
    write(),
  );
  await expectStatus(voided, 200);

  const afterActive = await jsonOf(
    await admin.fetch(`/boms?status=active&productId=${String(product.id)}`, get()),
  );
  expect(afterActive.total).toBe(0);
  const afterInactive = await jsonOf(
    await admin.fetch(`/boms?status=inactive&productId=${String(product.id)}`, get()),
  );
  expect(afterInactive.total).toBe(1);
}, TIMEOUT);
