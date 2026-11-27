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
import { BIZ_DICT_TYPES } from '../../server/providers/biz-dict.js';

/**
 * R-072 字典端点验收（真 Postgres）：九个类型、建/读/排序/默认唯一、逐条拒绝规则码，
 * 以及没有 DELETE（停用以 PATCH status 完成）。每条断言都从真库读回。
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
const jsonOf = async (response: Response): Promise<Row & { error?: { reason: string } }> =>
  (await response.json()) as Row & { error?: { reason: string } };

async function createEntry(session: TestSession, body: Row): Promise<Row> {
  const response = await session.fetch('/biz-dict/entries', write(body));
  expect(response.status, `建取值失败：${await response.clone().text()}`).toBe(201);
  return await jsonOf(response);
}

async function listEntries(
  session: TestSession,
  dictType: string,
  q?: string,
): Promise<Row> {
  const suffix = q === undefined ? '' : `&q=${encodeURIComponent(q)}`;
  const response = await session.fetch(
    `/biz-dict/entries?dictType=${dictType}${suffix}`,
    get(),
  );
  expect(response.status, `读字典失败：${await response.clone().text()}`).toBe(200);
  return await jsonOf(response);
}

test('九个类型可读，标签不是空', async ({ testApp }) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const response = await admin.fetch('/biz-dict/types', get());
  expect(response.status).toBe(200);
  const body = await jsonOf(response);
  expect(body.items?.map((row) => (row as Row).dictType)).toEqual([...BIZ_DICT_TYPES]);
  for (const row of body.items ?? []) {
    expect(String((row as Row).label).length).toBeGreaterThan(0);
  }
});

test('正向：建税率与项目各一条读回同样的值，按 sort 升序', async ({ testApp }) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const rateCode = unique('RATE');
  const projectCode = unique('PROJ');

  const rate = await createEntry(admin, {
    dictType: 'tax_rate', code: rateCode, name: '测试税率', rate: 13, sort: 2,
  });
  expect(rate).toMatchObject({
    dictType: 'tax_rate', code: rateCode, name: '测试税率', rate: 13, sort: 2,
    isDefault: false, status: 'active',
  });
  expect(Object.keys(rate)).not.toContain('createdById');

  const project = await createEntry(admin, {
    dictType: 'project', code: projectCode, name: '测试项目',
    startDate: '2026-01-01', endDate: '2026-12-31', description: '编造的项目说明', sort: 1,
  });
  expect(project).toMatchObject({
    dictType: 'project', code: projectCode, name: '测试项目',
    startDate: '2026-01-01', endDate: '2026-12-31', description: '编造的项目说明',
  });

  const rates = await listEntries(admin, 'tax_rate', rateCode);
  expect(rates.items).toHaveLength(1);
  expect((rates.items as Row[])[0]).toMatchObject({ code: rateCode, rate: 13 });
  const projects = await listEntries(admin, 'project', projectCode);
  expect((projects.items as Row[])[0]).toMatchObject({
    code: projectCode, startDate: '2026-01-01', endDate: '2026-12-31',
  });

  // 同一类型里 sort 小的在前；编码是第二排序键。
  const first = await createEntry(admin, {
    dictType: 'settlement', code: unique('ST'), name: '先', sort: 1,
  });
  const second = await createEntry(admin, {
    dictType: 'settlement', code: unique('ST'), name: '后', sort: 5,
  });
  const sorted = await listEntries(admin, 'settlement');
  const codes = (sorted.items as Row[]).map((row) => String(row.code));
  expect(codes.indexOf(String(first.code))).toBeLessThan(codes.indexOf(String(second.code)));
});

test('默认唯一：后设的把先设的清掉；reorder 按给定顺序重写 sort', async ({ testApp }) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const codeA = unique('RATE');
  const codeB = unique('RATE');
  const a = await createEntry(admin, {
    dictType: 'tax_rate', code: codeA, name: '甲', rate: 6, isDefault: true, sort: 1,
  });
  const b = await createEntry(admin, {
    dictType: 'tax_rate', code: codeB, name: '乙', rate: 9, isDefault: true, sort: 2,
  });
  expect(a.isDefault).toBe(true);
  expect(b.isDefault).toBe(true);

  const after = await listEntries(admin, 'tax_rate');
  const rows = (after.items as Row[]).filter((row) =>
    [codeA, codeB].includes(String(row.code)),
  );
  expect(rows.find((row) => row.code === codeA)?.isDefault).toBe(false);
  expect(rows.find((row) => row.code === codeB)?.isDefault).toBe(true);

  const reversed = await admin.fetch(
    '/biz-dict/entries/reorder',
    write({ dictType: 'tax_rate', ids: [b.id, a.id] }),
  );
  expect(reversed.status, `reorder 失败：${await reversed.clone().text()}`).toBe(200);
  const ordered = (await jsonOf(reversed)).items as Row[];
  expect(ordered.map((row) => row.code).indexOf(codeB)).toBeLessThan(
    ordered.map((row) => row.code).indexOf(codeA),
  );
  expect(ordered.every((row) => row.status === 'active')).toBe(true);
});

test('停用与启用都走 PATCH：状态值、默认列表与 status 筛选一起变', async ({
  testApp,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const code = unique('ST');
  const row = await createEntry(admin, {
    dictType: 'settlement', code, name: '测试启停',
  });
  const url = `/biz-dict/entries/${String(row.id)}`;

  const stopped = await admin.fetch(url, write({ status: 'inactive' }, 'PATCH'));
  expect(stopped.status).toBe(200);
  expect((await jsonOf(stopped)).status).toBe('inactive');
  expect((await listEntries(admin, 'settlement', code)).items).toHaveLength(0);
  const inactiveList = await jsonOf(
    await admin.fetch(
      `/biz-dict/entries?dictType=settlement&status=inactive&q=${encodeURIComponent(code)}`,
      get(),
    ),
  );
  expect(inactiveList.items).toHaveLength(1);

  const activated = await admin.fetch(url, write({ status: 'active' }, 'PATCH'));
  expect(activated.status).toBe(200);
  expect((await jsonOf(activated)).status).toBe('active');
  expect((await listEntries(admin, 'settlement', code)).items).toHaveLength(1);
});

test('status=all 同列在用与已停用，不带 status 仍只回在用', async ({ testApp }) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const activeCode = unique('ST');
  const inactiveCode = unique('ST');
  await createEntry(admin, {
    dictType: 'settlement', code: activeCode, name: '在用行',
  });
  const stopped = await createEntry(admin, {
    dictType: 'settlement', code: inactiveCode, name: '已停的行',
  });
  const stoppedResponse = await admin.fetch(
    `/biz-dict/entries/${String(stopped.id)}`,
    write({ status: 'inactive' }, 'PATCH'),
  );
  expect(stoppedResponse.status).toBe(200);

  const base = '/biz-dict/entries?dictType=settlement&pageSize=100';
  const codesOf = async (url: string): Promise<string[]> => {
    const body = await jsonOf(await admin.fetch(url, get()));
    return (body.items as Row[]).map((row) => String(row.code));
  };
  expect(await codesOf(base)).toContain(activeCode);
  expect(await codesOf(base)).not.toContain(inactiveCode);

  const both = await codesOf(`${base}&status=all`);
  expect(both).toContain(activeCode);
  expect(both).toContain(inactiveCode);
});

test('拒绝：字段不适用、码占用、码不可改、日期倒挂、空 PATCH、未知类型、找不到，且没有 DELETE', async ({
  testApp,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const reject = async (request: RequestInit, status: number, reason: string) => {
    const response = await admin.fetch('/biz-dict/entries', request);
    expect(response.status, `请求失败：${await response.clone().text()}`).toBe(status);
    expect((await jsonOf(response)).error?.reason).toBe(reason);
  };

  await reject(
    write({ dictType: 'settlement', code: unique('ST'), name: '不该有税率', rate: 13 }),
    422,
    'DICT_FIELD_NOT_APPLICABLE',
  );
  await reject(
    write({ dictType: 'unknown_type', code: unique('XX'), name: '未知类型' }),
    422,
    'DICT_TYPE_INVALID',
  );
  await reject(write({ dictType: 'tax_rate', code: '!!!', name: '坏码' }), 400, 'INVALID_INPUT');

  const code = unique('RATE');
  const entry = await createEntry(admin, {
    dictType: 'tax_rate', code, name: '原税率', rate: 13,
  });
  await reject(
    write({ dictType: 'tax_rate', code, name: '冒名' }),
    409,
    'DICT_CODE_TAKEN',
  );

  for (const [body, status, reason] of [
    [{ code: unique('RATE') }, 422, 'DICT_CODE_IMMUTABLE'],
    [{ dictType: 'project' }, 422, 'DICT_CODE_IMMUTABLE'],
    [{}, 422, 'DICT_EMPTY_PATCH'],
    [{ rate: 101 }, 422, 'DICT_VALUE_INVALID'],
  ] as const) {
    const response = await admin.fetch(
      `/biz-dict/entries/${String(entry.id)}`,
      write(body, 'PATCH'),
    );
    expect(response.status, `请求失败：${await response.clone().text()}`).toBe(status);
    expect((await jsonOf(response)).error?.reason).toBe(reason);
  }

  const project = await createEntry(admin, {
    dictType: 'project', code: unique('PROJ'), name: '改坏日期的项目',
    startDate: '2026-01-01', endDate: '2026-12-31',
  });
  const badDates = await admin.fetch(
    `/biz-dict/entries/${String(project.id)}`,
    write({ endDate: '2025-12-31' }, 'PATCH'),
  );
  expect(badDates.status).toBe(422);
  expect((await jsonOf(badDates)).error?.reason).toBe('DICT_VALUE_INVALID');

  const missing = await admin.fetch(
    '/biz-dict/entries/no-such-id', write({ name: '不存在' }, 'PATCH'),
  );
  expect(missing.status).toBe(404);
  expect((await jsonOf(missing)).error?.reason).toBe('DICT_NOT_FOUND');

  const removed = await admin.fetch(`/biz-dict/entries/${String(entry.id)}`, {
    method: 'DELETE', headers: { origin: ORIGIN },
  });
  expect([404, 405]).toContain(removed.status);
  expect((await listEntries(admin, 'tax_rate', code)).items).toHaveLength(1);

  // 停用只改状态，不删除。
  const stopped = await admin.fetch(
    `/biz-dict/entries/${String(entry.id)}`,
    write({ status: 'inactive' }, 'PATCH'),
  );
  expect(stopped.status).toBe(200);
  expect((await jsonOf(stopped)).status).toBe('inactive');
  expect((await listEntries(admin, 'tax_rate', code)).items).toHaveLength(0);
});
