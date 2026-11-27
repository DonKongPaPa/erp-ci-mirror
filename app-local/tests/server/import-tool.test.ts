// @vitest-environment node
import { randomUUID } from 'node:crypto';

import {
  DEFAULT_ADMIN_CREDENTIALS,
  signIn,
  type TestSession,
} from '@nocobase/app-plugin-authentication/testing';
import type { DatabaseConnection } from '@nocobase/db';
import type { Knex } from 'knex';
import { expect } from 'vitest';

import { createAppTest } from '../helpers/test-app.js';
import { createStandaloneServer } from '../../server/standalone.js';

/**
 * R-068 工具加片的验收：试运行不写库、一条错整批不退、按码幂等、期初只能导一次，
 * 以及五类各一条正向用例。数据全部编造，测试只连共享的测试库容器。
 */
const test = createAppTest({
  createServer: createStandaloneServer,
  config: {
    app: { publicOrigin: 'http://localhost' },
    auth: { secret: 'test-auth-secret-at-least-32-characters' },
  },
  scope: 'test',
});

const ORIGIN = 'http://localhost';
const unique = (prefix: string) =>
  `${prefix}${randomUUID().replaceAll('-', '').slice(0, 8).toUpperCase()}`;

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    origin: ORIGIN,
    'Idempotency-Key': `${Date.now()}.${randomUUID()}`,
  },
  body: JSON.stringify(body),
});
const upload = (text: string, name = 'rows.csv', type = 'text/csv'): RequestInit => {
  const form = new FormData();
  form.append('file', new Blob([text], { type }), name);
  return { method: 'POST', headers: { origin: ORIGIN }, body: form };
};

const csv = (
  headers: readonly string[],
  rows: readonly (readonly (string | number | null)[])[],
): string => {
  const cell = (value: string | number | null): string => {
    const text = value === null ? '' : String(value);
    return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  return [headers.map(cell).join(','), ...rows.map((row) => row.map(cell).join(','))].join('\r\n');
};

const ITEM_HEADERS = [
  'code', 'legacyCode', 'name', 'spec', 'unitCode', 'categoryCode',
  'category2Code', 'category3Code', 'purchasePrice', 'salesPrice',
  'stockMin', 'stockMax', 'barcode', 'brand', 'manufacturerModel',
  'leadTimeDays', 'note',
] as const;
const PARTNER_HEADERS = [
  'code', 'legacyCode', 'partnerType', 'name', 'groupCode',
  'contactName', 'contactPhone', 'contactEmail', 'note',
] as const;
const WAREHOUSE_HEADERS = ['code', 'name', 'status', 'note'] as const;
const DICT_HEADERS = ['dictType', 'code', 'name', 'rate', 'sort', 'status'] as const;
const OPENING_HEADERS = [
  'warehouseCode', 'itemCode', 'qty', 'batchNo', 'productionDate', 'expiryDate', 'note',
] as const;

type Report = {
  kind?: string;
  rowCount?: number;
  wouldCreate?: number;
  wouldSkip?: number;
  wouldUpdate?: number;
  errorCount?: number;
  issues?: readonly { row?: number; code?: string; message?: string }[];
  token?: string;
  headers?: readonly string[];
  error?: { reason?: string; metadata?: Record<string, unknown> };
};
const reportOf = async (response: Response): Promise<Report> =>
  (await response.json()) as Report;
const knexOf = async (connection: DatabaseConnection): Promise<Knex> =>
  await connection.client<Knex>();
const countOf = async (connection: DatabaseConnection, table: string): Promise<number> => {
  const knex = await knexOf(connection);
  const row = await knex(table).count<{ count: string | number }[]>('* as count').first();
  return Number(row?.count ?? 0);
};

interface Seed {
  unit: string;
  category: string;
  customerGroup: string;
  supplierGroup: string;
  warehouse: string;
  itemCode: string;
  itemLegacy: string;
}
async function seed(admin: TestSession): Promise<Seed> {
  const unit = unique('U');
  const category = unique('C');
  const customerGroup = unique('CG');
  const supplierGroup = unique('SG');
  const warehouse = unique('WH');
  const itemLegacy = unique('LG');
  expect((await admin.fetch('/units', json({ code: unit, name: '样例单位' }))).status).toBe(201);
  expect((await admin.fetch('/item-categories', json({
    id: randomUUID(), code: category, name: '样例分类',
  }))).status).toBe(201);
  expect((await admin.fetch('/biz-dict/entries', json({
    dictType: 'customer_group', code: customerGroup, name: '样例客户组',
  }))).status).toBe(201);
  expect((await admin.fetch('/biz-dict/entries', json({
    dictType: 'supplier_group', code: supplierGroup, name: '样例供应商组',
  }))).status).toBe(201);
  expect((await admin.fetch('/warehouses', json({ code: warehouse, name: '样例仓库' }))).status).toBe(201);
  const created = await admin.fetch('/items', json({
    name: '期初样例物料', itemType: 'material', unitCode: unit, legacyCode: itemLegacy,
  }));
  expect(created.status).toBe(201);
  const item = (await created.json()) as { code: string };
  return { unit, category, customerGroup, supplierGroup, warehouse, itemCode: item.code, itemLegacy };
}

function validFiles(seedData: Seed): Record<string, string> {
  const name = unique('导入物料');
  return {
    items: csv(ITEM_HEADERS, [[
      '', unique('LG'), name, '规格A', seedData.unit, seedData.category,
      '', '', '12.5', '20', '1', '99', 'BC-1', '样例牌', 'M-1', '7', '样例备注',
    ]]),
    partners: csv(PARTNER_HEADERS, [[
      unique('CU'), '', 'customer', unique('样例客户'), seedData.customerGroup,
      '联系人甲', '000-0009', 'buyer@example.test', '客户备注',
    ]]),
    warehouses: csv(WAREHOUSE_HEADERS, [
      [unique('WH'), '新建仓库', 'active', '仓库备注'],
    ]),
    bizDict: csv(DICT_HEADERS, [[
      'settlement', unique('ST'), '样例结算方式', '', '3', 'active',
    ]]),
    openingStock: csv(OPENING_HEADERS, [[
      seedData.warehouse, seedData.itemCode, '25', 'B-1', '2026-01-01', '2027-01-01', '期初备注',
    ]]),
  };
}

async function parse(admin: TestSession, kind: string, text: string, type = 'text/csv') {
  const response = await admin.fetch(`/imports/${kind}/parse`, upload(text, `${kind}.csv`, type));
  return { response, report: await reportOf(response) };
}
async function dry(admin: TestSession, kind: string, token: string) {
  const response = await admin.fetch(`/imports/${kind}/dry-run`, json({ token }));
  return { response, report: await reportOf(response) };
}
async function commit(admin: TestSession, kind: string, token: string, mode: 'skip' | 'update' = 'skip') {
  const response = await admin.fetch(`/imports/${kind}/commit`, json({ token, mode }));
  return { response, report: await reportOf(response) };
}

test('R-068 验收1: 五类试运行只出报告，不写库', async ({ testApp, connection }) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const seedData = await seed(admin);
  const files = validFiles(seedData);
  const tables = ['items', 'partners', 'warehouses', 'biz_dict_entries', 'stock_docs', 'stock_balances'];
  const before = Object.fromEntries(await Promise.all(
    tables.map(async (table) => [table, await countOf(connection, table)]),
  ));

  for (const kind of ['items', 'partners', 'warehouses', 'bizDict', 'openingStock']) {
    const parsed = await parse(admin, kind, files[kind]);
    expect(parsed.response.status, `${kind} parse: ${JSON.stringify(parsed.report)}`).toBe(201);
    expect(typeof parsed.report.token).toBe('string');
    expect(parsed.report.rowCount).toBe(1);
    const tried = await dry(admin, kind, String(parsed.report.token));
    expect(tried.response.status, `${kind} dry-run: ${JSON.stringify(tried.report)}`).toBe(200);
    expect(tried.report.wouldCreate).toBe(1);
    expect(tried.report.errorCount).toBe(0);
  }

  const after = Object.fromEntries(await Promise.all(
    tables.map(async (table) => [table, await countOf(connection, table)]),
  ));
  expect(after).toEqual(before);
});

test('R-068 验收2: 一行引用单位不存在，整批回 422 且一行不入', async ({ testApp, connection }) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const seedData = await seed(admin);
  const before = await countOf(connection, 'items');
  const text = csv(ITEM_HEADERS, [
    ['', unique('LG'), unique('好行'), '规格', seedData.unit, '', '', '', '', '', '', '', '', '', '', '', ''],
    ['', unique('LG'), unique('坏行'), '规格', unique('不存在单位'), '', '', '', '', '', '', '', '', '', '', '', ''],
  ]);
  const parsed = await parse(admin, 'items', text);
  expect(parsed.response.status).toBe(201);
  const tried = await dry(admin, 'items', String(parsed.report.token));
  expect(tried.response.status).toBe(200);
  expect(tried.report.errorCount).toBe(1);
  expect(tried.report.issues?.[0]?.code).toBe('IMPORT_UNIT_NOT_FOUND');
  expect(tried.report.issues?.[0]?.row).toBe(3);
  const done = await commit(admin, 'items', String(parsed.report.token));
  expect(done.response.status).toBe(422);
  expect(done.report.error?.reason).toBe('IMPORT_VALIDATION_FAILED');
  expect(JSON.stringify(done.report.error?.metadata?.issues)).toContain('IMPORT_UNIT_NOT_FOUND');
  expect(await countOf(connection, 'items')).toBe(before);
});

test('R-068 验收3: 重复导入按码幂等；期初第二次被拒', async ({ testApp, connection }) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const seedData = await seed(admin);
  const files = validFiles(seedData);

  for (const kind of ['items', 'partners', 'warehouses', 'bizDict']) {
    const table = kind === 'bizDict' ? 'biz_dict_entries' : kind === 'openingStock' ? 'stock_docs' : kind;
    const before = await countOf(connection, table);
    const first = await parse(admin, kind, files[kind]);
    expect((await dry(admin, kind, String(first.report.token))).response.status).toBe(200);
    expect((await commit(admin, kind, String(first.report.token))).response.status).toBe(201);
    expect(await countOf(connection, table)).toBe(before + 1);
    const second = await parse(admin, kind, files[kind]);
    const tried = await dry(admin, kind, String(second.report.token));
    expect(tried.report.wouldSkip, `${kind} wouldSkip`).toBe(1);
    const done = await commit(admin, kind, String(second.report.token));
    expect(done.response.status).toBe(201);
    expect(done.report.wouldSkip).toBe(1);
    expect(await countOf(connection, table)).toBe(before + 1);
  }

  const opening = await parse(admin, 'openingStock', files.openingStock);
  expect((await dry(admin, 'openingStock', String(opening.report.token))).response.status).toBe(200);
  expect((await commit(admin, 'openingStock', String(opening.report.token))).response.status).toBe(201);
  const secondOpening = await parse(admin, 'openingStock', files.openingStock);
  const secondDry = await dry(admin, 'openingStock', String(secondOpening.report.token));
  expect(secondDry.response.status).toBe(422);
  expect(secondDry.report.error?.reason).toBe('OPENING_ALREADY_IMPORTED');
  const refused = await commit(admin, 'openingStock', String(secondOpening.report.token));
  expect(refused.response.status).toBe(422);
  expect(refused.report.error?.reason).toBe('OPENING_ALREADY_IMPORTED');
});

test('R-068 验收5: 五类各一条导入成功的正向用例', async ({ testApp, connection }) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const seedData = await seed(admin);
  const files = validFiles(seedData);
  const expectations: Record<string, { table: string; before: number }> = {};
  for (const [kind, table] of [
    ['items', 'items'], ['partners', 'partners'], ['warehouses', 'warehouses'],
    ['bizDict', 'biz_dict_entries'], ['openingStock', 'stock_docs'],
  ] as const) {
    expectations[kind] = { table, before: await countOf(connection, table) };
  }

  for (const kind of ['items', 'partners', 'warehouses', 'bizDict', 'openingStock']) {
    const parsed = await parse(admin, kind, files[kind]);
    expect(parsed.response.status).toBe(201);
    expect((await dry(admin, kind, String(parsed.report.token))).response.status).toBe(200);
    const done = await commit(admin, kind, String(parsed.report.token));
    expect(done.response.status, `${kind} commit: ${JSON.stringify(done.report)}`).toBe(201);
    expect(done.report.wouldCreate).toBe(1);
    expect(done.report.errorCount).toBe(0);
    const target = expectations[kind];
    expect(await countOf(connection, target.table)).toBe(target.before + 1);
  }
  expect(await countOf(connection, 'stock_balances')).toBe(1);
  const knex = await knexOf(connection);
  const posted = await knex('stock_docs').select('doc_type', 'reason', 'remark', 'status').first();
  expect(posted).toMatchObject({ doc_type: 'in', reason: 'other_in', remark: '期初入库', status: 'posted' });
});

test('R-068 令牌与请求约束：非法类型、编码、表头、重复键、单次令牌', async ({ testApp }) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const seedData = await seed(admin);
  const files = validFiles(seedData);

  expect((await admin.fetch('/imports/nope/parse', upload(files.items))).status).toBe(404);
  expect((await parse(admin, 'items', '名称\n物料', 'text/csv; charset=gbk')).report.error?.reason)
    .toBe('IMPORT_ENCODING_INVALID');
  expect((await parse(admin, 'items', '名字,单位\n甲,PCS')).report.error?.reason)
    .toBe('IMPORT_HEADER_INVALID');
  const duplicate = csv(ITEM_HEADERS, [
    ['', 'DUP-1', '甲', '', seedData.unit, '', '', '', '', '', '', '', '', '', '', '', ''],
    ['', 'DUP-1', '乙', '', seedData.unit, '', '', '', '', '', '', '', '', '', '', '', ''],
  ]);
  expect((await parse(admin, 'items', duplicate)).report.error?.reason).toBe('IMPORT_DUPLICATE_KEY');

  const parsed = await parse(admin, 'items', files.items);
  const token = String(parsed.report.token);
  expect((await dry(admin, 'items', token)).response.status).toBe(200);
  expect((await dry(admin, 'items', token)).response.status).toBe(200);
  expect((await commit(admin, 'items', token)).response.status).toBe(201);
  expect((await dry(admin, 'items', token)).report.error?.reason).toBe('IMPORT_TOKEN_INVALID');

  const noDry = await parse(admin, 'warehouses', files.warehouses);
  expect((await commit(admin, 'warehouses', String(noDry.report.token))).report.error?.reason)
    .toBe('IMPORT_NOT_DRY_RUN');
  expect((await dry(admin, 'items', randomUUID())).report.error?.reason).toBe('IMPORT_TOKEN_INVALID');
});
