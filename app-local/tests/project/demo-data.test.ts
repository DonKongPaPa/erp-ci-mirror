import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import dataset from '../../../scripts/dev/demo-data/dataset.mjs';
import {
  extractPublicConfig,
  isDevelopmentApp,
} from '../../../scripts/dev/demo-data/inject.mjs';

const repoRoot = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../../..');
const readSource = (relative: string) =>
  readFileSync(path.join(repoRoot, relative), 'utf8');

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/u;
const MOBILE = /(?<!\d)1[3-9]\d{9}(?!\d)/u;
const LANDLINE = /(?<!\d)0\d{2,3}-\d{7,8}(?!\d)/u;

/** 每类至少要有这些键，且值是非空标量或数组。 */
const REQUIRED: Record<string, readonly string[]> = {
  units: ['code', 'name', 'decimals'],
  categories: ['id', 'code', 'name', 'parentCode'],
  items: ['legacyCode', 'name', 'itemType', 'unitCode', 'categoryCode'],
  dictEntries: ['dictType', 'code', 'name'],
  partners: ['name', 'isCustomer', 'isSupplier', 'contacts'],
  warehouses: ['code', 'name', 'status'],
  purchaseOrders: ['key', 'supplierName', 'orderDate', 'state', 'lines'],
  salesOrders: ['key', 'customerName', 'orderDate', 'state', 'lines'],
  stockDocs: ['key', 'docType', 'reason', 'remark', 'lines'],
  expenses: ['key', 'expenseDate', 'bindMode', 'remark'],
  invoiceReceipts: ['key', 'invoiceDate', 'bindMode', 'remark'],
};

/** 这些键有值就是空字符串也不允许（parentCode 这类可空的字段不在此列）。 */
const NONEMPTY = [
  'code', 'name', 'id', 'legacyCode', 'key', 'remark', 'supplierName',
  'customerName', 'unitCode', 'categoryCode', 'orderDate', 'expenseDate',
  'invoiceDate', 'dictType', 'docType', 'reason', 'bindMode', 'docDate',
] as const;

/** 每类用于回查的唯一键；字典是 dictType + code。 */
const KEY: Record<string, (row: Record<string, unknown>) => string> = {
  units: (row) => String(row.code),
  categories: (row) => String(row.code),
  items: (row) => String(row.legacyCode),
  dictEntries: (row) => `${String(row.dictType)}/${String(row.code)}`,
  partners: (row) => String(row.name),
  warehouses: (row) => String(row.code),
  purchaseOrders: (row) => String(row.key),
  salesOrders: (row) => String(row.key),
  stockDocs: (row) => String(row.key),
  expenses: (row) => String(row.key),
  invoiceReceipts: (row) => String(row.key),
};

function rowsOf(collection: string): Record<string, unknown>[] {
  return (dataset as unknown as Record<string, Record<string, unknown>[]>)[collection] ?? [];
}

function* strings(value: unknown): Generator<string> {
  if (typeof value === 'string') {
    yield value;
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) yield* strings(item);
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) yield* strings(item);
  }
}

function* keys(value: unknown): Generator<string> {
  if (Array.isArray(value)) {
    for (const item of value) yield* keys(item);
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      yield key;
      yield* keys(item);
    }
  }
}

describe('R-074 样例数据集', () => {
  it('十一类都有数据，且每行的必填字段齐全', () => {
    for (const [collection, fields] of Object.entries(REQUIRED)) {
      const rows = rowsOf(collection);
      expect(rows.length, `${collection} 必须非空`).toBeGreaterThan(0);
      for (const row of rows) {
        for (const field of fields) {
          expect(Object.prototype.hasOwnProperty.call(row, field),
            `${collection} 的 ${field} 必须在数据里`).toBe(true);
        }
        for (const field of NONEMPTY) {
          if (Object.prototype.hasOwnProperty.call(row, field)) {
            expect(String(row[field]).length, `${collection} 的 ${field} 不得为空`).toBeGreaterThan(0);
          }
        }
      }
    }
  });

  it('各类固定编码唯一', () => {
    for (const [collection, keyOf] of Object.entries(KEY)) {
      const rows = rowsOf(collection);
      const keys = rows.map(keyOf);
      expect(new Set(keys).size, `${collection} 的编码必须唯一`).toBe(rows.length);
    }
  });

  it('规模够演示：主数据几十条、单据十来张', () => {
    expect(rowsOf('units').length, '计量单位 5–8').toBeGreaterThanOrEqual(5);
    expect(rowsOf('units').length, '计量单位 5–8').toBeLessThanOrEqual(8);
    expect(rowsOf('categories').length, '物料分类 10–20').toBeGreaterThanOrEqual(10);
    expect(rowsOf('categories').length, '物料分类 10–20').toBeLessThanOrEqual(20);
    expect(rowsOf('items').length, '物料 25–35').toBeGreaterThanOrEqual(25);
    expect(rowsOf('items').length, '物料 25–35').toBeLessThanOrEqual(35);
    expect(rowsOf('partners').length, '往来单位 12–20').toBeGreaterThanOrEqual(12);
    expect(rowsOf('warehouses').length, '仓库 3').toBe(3);
    expect(rowsOf('dictEntries').length, '字典 36–54').toBeGreaterThanOrEqual(36);
    expect(rowsOf('dictEntries').length, '字典 36–54').toBeLessThanOrEqual(54);
    expect(
      rowsOf('purchaseOrders').length + rowsOf('salesOrders').length +
        rowsOf('stockDocs').length + rowsOf('expenses').length +
        rowsOf('invoiceReceipts').length,
      '单据至少 12 张',
    ).toBeGreaterThanOrEqual(12);
  });

  it('九个字典类型齐全，每类 4–8 条', () => {
    const types = [
      'project', 'settlement', 'supplier_group', 'customer_group', 'income_type',
      'expense_type', 'invoice_type', 'tax_rate', 'fund_account',
    ];
    const entries = rowsOf('dictEntries');
    for (const type of types) {
      const count = entries.filter((row) => row.dictType === type).length;
      expect(count, `${type} 应有 4–8 条`).toBeGreaterThanOrEqual(4);
      expect(count, `${type} 应有 4–8 条`).toBeLessThanOrEqual(8);
    }
    expect(new Set(entries.map((row) => row.dictType)).size, '九个类型').toBe(types.length);
  });

  it('内部领用不在数据集里写领用部门与领用人（现场从窄选项接口解析）', () => {
    const docs = rowsOf('stockDocs').filter((row) => row.reason === 'internal_use');
    expect(docs.length, '至少一张内部领用单').toBeGreaterThanOrEqual(1);
    expect(docs.some((row) => row.post === true), '至少一张已过账的内部领用单').toBe(true);
    for (const doc of docs) {
      expect(Object.prototype.hasOwnProperty.call(doc, 'takerDepartmentId'), '不写部门 id').toBe(false);
      expect(Object.prototype.hasOwnProperty.call(doc, 'takerUserId'), '不写人员 id').toBe(false);
    }
  });

  it('只有客户带交货地址（接口只认 customers.update）', () => {
    for (const row of rowsOf('partners')) {
      const hasAddresses = ((row.addresses as unknown[]) ?? []).length > 0;
      expect(hasAddresses, `${String(row.name)} 的地址`).toBe(row.isCustomer === true);
    }
  });

  it('没有电话、邮箱格式的值，也没有电话/邮箱字段', () => {
    const allKeys = [...keys(dataset)];
    expect(allKeys.includes('phone'), '数据集不建电话字段').toBe(false);
    expect(allKeys.includes('email'), '数据集不建邮箱字段').toBe(false);
    for (const value of strings(dataset)) {
      expect(EMAIL.test(value), `不得出现邮箱：${value}`).toBe(false);
      expect(MOBILE.test(value), `不得出现手机号：${value}`).toBe(false);
      expect(LANDLINE.test(value), `不得出现座机号：${value}`).toBe(false);
    }
  });

  it('备注统一标成样例数据，单据备注带可回查的固定标记', () => {
    for (const row of rowsOf('stockDocs')) {
      expect(String(row.remark).startsWith('样例数据 R074-'), `${row.key} 的备注`).toBe(true);
    }
    for (const row of [...rowsOf('expenses'), ...rowsOf('invoiceReceipts')]) {
      expect(String(row.remark).startsWith('样例数据 R074-'), `${row.key} 的备注`).toBe(true);
    }
  });
});

describe('R-074 开发态判定', () => {
  it('公开配置里有 devTools 节才是开发态（开关关着也算）', () => {
    expect(isDevelopmentApp({ devTools: { accountSwitcher: { enabled: true } } }), '有节且开着是开发态').toBe(true);
    expect(isDevelopmentApp({ devTools: { accountSwitcher: { enabled: false } } }), '有节但开关关着仍是开发态').toBe(true);
    expect(isDevelopmentApp({ devTools: {} }), '空节也是开发态').toBe(true);
    expect(isDevelopmentApp({}), '没有节不是').toBe(false);
    expect(isDevelopmentApp({ devTools: null }), '节为空值不是').toBe(false);
    expect(isDevelopmentApp({ devTools: 'x' }), '节形状不对不是').toBe(false);
    expect(isDevelopmentApp(null), '没有公开配置不是').toBe(false);
    expect(isDevelopmentApp(undefined), '取不到公开配置不是').toBe(false);
    expect(isDevelopmentApp('enabled'), '配置形状不对不是').toBe(false);
  });

  it('从页面内嵌的公开配置里读出标记， prod 页面读不到', () => {
    const devHtml = '<html><script id="nocobase-runtime-config" type="application/json">'
      + '{"version":1,"config":{},"public":{"devTools":{"accountSwitcher":{"enabled":true}},"app":{"version":"demo"}}}'
      + '</script></html>';
    const prodHtml = '<html><script id="nocobase-runtime-config" type="application/json">'
      + '{"version":1,"config":{},"public":{"app":{"version":"prod"}}}'
      + '</script></html>';
    const devPublic = extractPublicConfig(devHtml);
    expect(devPublic, '解析出公开配置').not.toBeNull();
    expect((devPublic as Record<string, unknown>).app, '取到的是 public 这一节').toEqual({ version: 'demo' });
    expect(isDevelopmentApp(devPublic), '开发页判为开发态').toBe(true);
    const liveHtml = '<html><script id="nocobase-runtime-config" type="application/json">'
      + '{"version":1,"config":{},"public":{"devTools":{"accountSwitcher":{"enabled":false}}}}'
      + '</script></html>';
    expect(isDevelopmentApp(extractPublicConfig(liveHtml)), '本机开关关着的开发页仍是开发态').toBe(true);
    expect(isDevelopmentApp(extractPublicConfig(prodHtml)), '生产页不是开发态').toBe(false);
    expect(extractPublicConfig('<html>没有内嵌配置</html>'), '没有脚本返回 null').toBeNull();
    expect(extractPublicConfig('<script id="nocobase-runtime-config" type="application/json">{坏 JSON</script>'),
      '坏 JSON 返回 null').toBeNull();
  });
});

describe('R-074 凭据处理', () => {
  it('数据集源码里没有口令、邮箱和电话', () => {
    const source = readSource('scripts/dev/demo-data/dataset.mjs');
    expect(/password|passwd|口令|secret/iu.test(source), '数据集不得含口令').toBe(false);
    expect(EMAIL.test(source), '数据集不得含邮箱').toBe(false);
    expect(MOBILE.test(source), '数据集不得含手机号').toBe(false);
  });

  it('注入脚本先给每类单据建好清单数组再写入', () => {
    const source = readSource('scripts/dev/demo-data/inject.mjs');
    expect(source.includes('DOCUMENT_KEYS.map((key) => [key, []])'),
      'manifest 必须先初始化各类数组，否则写编号时 push 会崩').toBe(true);
    for (const key of ['purchaseOrders', 'salesOrders', 'stockDocs']) {
      expect(source.includes(`manifest.${key}.push`), `${key} 的编号要写进清单`).toBe(true);
    }
    expect(source.includes('manifest[category].push'), '财务两类的编号要写进清单').toBe(true);
    expect(source.includes('order.lines === undefined'), '列表行不带明细，生成出入库单前要读详情').toBe(true);
    expect(source.includes("row.reason === 'internal_use'"), '内部领用要现场解析领用字段').toBe(true);
    expect(source.includes("['expenses', 'expenses', 'expenseDate', 'expenseTypeCode']"),
      '财务两类都在注入列表里').toBe(true);
  });

  it('注入脚本从环境变量取管理员凭据，且不打印口令', () => {
    const source = readSource('scripts/dev/demo-data/inject.mjs');
    expect(source.includes('process.env.DEMO_DATA_EMAIL'), '邮箱来自环境变量').toBe(true);
    expect(source.includes('process.env.DEMO_DATA_PASSWORD'), '口令来自环境变量').toBe(true);
    const logging = source.split('\n').filter((line) => line.includes('console.'));
    expect(logging.some((line) => /password/iu.test(line)), '日志里不出现口令').toBe(false);
  });
});
