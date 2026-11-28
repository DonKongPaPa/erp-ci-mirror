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
 * R-078 验收 6：留痕只追加、只存摘要与行数；失败不留痕；普通角色只看自己的。
 */
const test = createAppTest({
  createServer: createStandaloneServer,
  config: {
    app: { publicOrigin: 'http://localhost' },
    auth: { secret: 'test-auth-secret-at-least-32-characters' },
  },
});

const PASSWORD = 'R078-export-test-123!';
const unique = (prefix: string) => `${prefix}${randomUUID().replaceAll('-', '').slice(0, 10)}`;
const write = (body: unknown = {}): RequestInit => ({
  method: 'POST',
  headers: {
    'content-type': 'application/json', origin: 'http://localhost',
    'accept-language': 'zh-CN',
    'Idempotency-Key': `${Date.now()}.${randomUUID()}`,
  },
  body: JSON.stringify(body),
});
const get = (): RequestInit => ({ method: 'GET' });
type Row = Record<string, unknown> & { error?: { reason?: string } };
const jsonOf = async (response: Response): Promise<Row> => (await response.json()) as Row;

async function makeUser(
  admin: TestSession, app: Parameters<typeof signIn>[0], role: string,
): Promise<{ session: TestSession; id: string }> {
  const username = unique(`r078${role}`);
  const created = await admin.fetch('/users', write({
    name: username, username, email: `${username.toLowerCase()}@example.test`,
    password: PASSWORD, roleScopes: { app: [role] },
  }));
  expect(created.status).toBe(201);
  return {
    id: String(((await jsonOf(created)).data as Row | undefined)?.id ?? ''),
    session: await signIn(app, { username, password: PASSWORD }),
  };
}

test('导出一次：留痕各字段正确、CSV 中文表头，库里没有筛选值与客户名', async ({ testApp, connection }) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const finance = await makeUser(admin, testApp, 'finance');
  const created = await finance.session.fetch('/income-records', write({
    incomeDate: '2026-11-27', bindMode: 'none', amount: 77,
    payerName: 'SECRET_CUSTOMER_R078', confirm: true,
  }));
  expect(created.status).toBe(201);

  const secret = 'SECRET_CUSTOMER_R078';
  const response = await finance.session.fetch('/reports/income_record_detail/export', write({
    filters: { payer: secret }, dimensions: [], measures: ['incomeAmount'],
  }));
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('text/csv');
  expect(response.headers.get('content-disposition')).toContain('income_record_detail.csv');
  const csv = await response.text();
  expect(csv.split('\r\n')[0]).toContain('收入金额');
  expect(csv).toContain('77');

  const rows = await connection.query.selectFrom('reportExportTraces').selectAll().execute();
  expect(rows).toHaveLength(1);
  const trace = rows[0]!;
  expect(trace.userId).toBe(finance.id);
  expect(trace.reportKey).toBe('income_record_detail');
  expect(String(trace.format)).toBe('csv');
  expect(trace.filtersHash).toMatch(/^[0-9a-f]{64}$/u);
  expect(trace.rowCount).toBe(1);
  expect(Number.isNaN(Date.parse(String(trace.at)))).toBe(false);
  const stored = JSON.stringify(trace);
  expect(stored).not.toContain(secret);
  expect(stored).not.toContain('SECRET_CUSTOMER');
});

test('导出中途失败不留痕：把定义 source 改成未注册名，500 且不增加留痕', async ({ testApp, connection }) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const finance = await makeUser(admin, testApp, 'finance');
  const before = await connection.query.selectFrom('reportExportTraces')
    .select('id').execute();

  await connection.query.updateTable('reportDefinitions')
    .set({ source: 'not-registered-source' })
    .where('key', '=', 'income_record_detail').execute();
  try {
    const response = await finance.session.fetch('/reports/income_record_detail/export', write({
      filters: {}, dimensions: [], measures: ['incomeAmount'],
    }));
    expect(response.status).toBe(500);
    expect((await jsonOf(response)).error?.reason).toBe('REPORT_EXPORT_FAILED');
    const after = await connection.query.selectFrom('reportExportTraces').select('id').execute();
    expect(after).toHaveLength(before.length);
  } finally {
    await connection.query.updateTable('reportDefinitions')
      .set({ source: 'financeRecords' })
      .where('key', '=', 'income_record_detail').execute();
  }
});

test('留痕查询：普通角色传别人的 userId 仍只回自己，root 可按 userId 查', async ({ testApp }) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const first = await makeUser(admin, testApp, 'finance');
  const second = await makeUser(admin, testApp, 'finance');
  await first.session.fetch('/reports/income_record_detail/export', write({
    filters: {}, dimensions: [], measures: ['incomeAmount'],
  }));
  await second.session.fetch('/reports/income_expense_detail/export', write({
    filters: {}, dimensions: [], measures: ['receivedAmount'],
  }));

  const mine = await jsonOf(await first.session.fetch(
    `/reports/export-traces?userId=${encodeURIComponent(second.id)}`, get()));
  expect(mine.total).toBe(1);
  expect((mine.items as Row[]).map((row) => row.userId)).toEqual([first.id]);
  for (const row of mine.items as Row[]) {
    expect(Object.keys(row.user as Row).sort()).toEqual(['name', 'userId']);
    expect(JSON.stringify(row)).not.toContain('@example.test');
  }

  const all = await jsonOf(await admin.fetch('/reports/export-traces?pageSize=100', get()));
  expect(all.total).toBeGreaterThanOrEqual(2);
  const userIds = (all.items as Row[]).map((row) => row.userId);
  expect(userIds).toContain(first.id);
  expect(userIds).toContain(second.id);
  const filtered = await jsonOf(await admin.fetch(
    `/reports/export-traces?userId=${encodeURIComponent(second.id)}`, get()));
  expect(filtered.total).toBe(1);
  expect((filtered.items as Row[])[0]?.userId).toBe(second.id);
});
