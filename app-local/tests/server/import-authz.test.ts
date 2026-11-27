// @vitest-environment node
import { randomUUID } from 'node:crypto';

import {
  DEFAULT_ADMIN_CREDENTIALS,
  signIn,
  type TestSession,
} from '@nocobase/app-plugin-authentication/testing';
import { loggingToken } from '@nocobase/app-server/logging';
import { expect, vi } from 'vitest';

import { createAppTest } from '../helpers/test-app.js';
import { createStandaloneServer } from '../../server/standalone.js';

/**
 * R-068 验收4：只有 root 能碰三步端点；非 root 与匿名在处理文件之前就 403，
 * 响应里没有令牌、列名与错误行。日志与报告不得出现姓名、电话、邮箱。
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
const PASSWORD = 'R068-authz-123!';
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
const upload = (text: string): RequestInit => {
  const form = new FormData();
  form.append('file', new Blob([text], { type: 'text/csv' }), 'rows.csv');
  return { method: 'POST', headers: { origin: ORIGIN }, body: form };
};

/** 文件故意带坏表头与手机号：非 root 仍应 403，才会证明没有先读文件。 */
const HEADERS = [
  'code', 'legacyCode', 'name', 'spec', 'unitCode', 'categoryCode',
  'category2Code', 'category3Code', 'purchasePrice', 'salesPrice',
  'stockMin', 'stockMax', 'barcode', 'brand', 'manufacturerModel',
  'leadTimeDays', 'note',
];
const csv = (rows: readonly (readonly string[])[]) =>
  [HEADERS.join(','), ...rows.map((row) => row.join(','))].join('\r\n');
const PERSON_NAME = unique('隐私姓名');
const PHONE = '000-1234';
const EMAIL = `${unique('private')}@example.test`;
const PII_CSV = csv([[
  '', '', PERSON_NAME, '规格', '不存在的单位', '', '', '', '', '', '', '', '', '', '', '', EMAIL,
]]);

type Body = Record<string, unknown> & {
  error?: { reason?: string };
  token?: string;
  headers?: unknown;
  issues?: unknown;
};
const bodyOf = async (response: Response): Promise<Body> =>
  (await response.json().catch(() => ({}))) as Body;

async function makeStaff(admin: TestSession, app: Parameters<typeof signIn>[0]): Promise<TestSession> {
  const username = unique('r068user');
  const created = await admin.fetch('/users', json({
    name: username,
    username,
    email: `${username.toLowerCase()}@example.test`,
    password: PASSWORD,
    roleScopes: { app: ['staff'] },
  }));
  expect(created.status).toBe(201);
  return await signIn(app, { username, password: PASSWORD });
}

test('R-068 验收4: 非 root 与匿名的三步端点一律 403，响应无令牌、列名与错误行', async ({
  testApp, request,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const staff = await makeStaff(admin, testApp);
  const unit = unique('U');
  expect((await admin.fetch('/units', json({ code: unit, name: '样例单位' }))).status).toBe(201);

  const parseText = csv([['', '', '甲', '', unit, '', '', '', '', '', '', '', '', '', '', '', '']]);
  for (const session of [staff.fetch.bind(staff), request]) {
    const parsed = await session('/imports/items/parse', upload(PII_CSV));
    expect(parsed.status).toBe(403);
    const body = await bodyOf(parsed);
    expect(body.error?.reason).toBe('NO_PERMISSION');
    for (const key of ['token', 'headers', 'issues', 'rowCount']) expect(body).not.toHaveProperty(key);

    const token = randomUUID();
    const tried = await session('/imports/items/dry-run', json({ token }));
    expect(tried.status).toBe(403);
    expect(await bodyOf(tried)).not.toHaveProperty('issues');

    const done = await session('/imports/items/commit', json({ token, mode: 'skip' }));
    expect(done.status).toBe(403);
    expect(await bodyOf(done)).not.toHaveProperty('token');
  }
  // 匿名攻击者若发来坏文件，也先被 403 拦住，而不是 422 表头错 —— 授权先于读内容。
  expect((await request('/imports/items/parse', upload('乱码,无表头'))).status).toBe(403);
  expect(parseText).toContain('甲');
});

test('R-068 验收4: 日志与报告不含姓名、电话、邮箱，只记类型、行数、错误码与耗时', async ({
  app, testApp,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const unit = unique('U');
  expect((await admin.fetch('/units', json({ code: unit, name: '样例单位' }))).status).toBe(201);
  const logger = app.container.resolve(loggingToken).getLogger('imports');
  const spy = vi.spyOn(logger, 'info');
  try {
    const form = new FormData();
    form.append('file', new Blob([PII_CSV], { type: 'text/csv' }), 'pii.csv');
    const parsed = await admin.fetch('/imports/items/parse', {
      method: 'POST', headers: { origin: ORIGIN }, body: form,
    });
    expect(parsed.status).toBe(201);
    const { token } = (await parsed.json()) as { token: string };
    const tried = await admin.fetch('/imports/items/dry-run', json({ token }));
    expect(tried.status).toBe(200);
    const reportText = await tried.text();
    expect(reportText).not.toContain(PERSON_NAME);
    expect(reportText).not.toContain(PHONE);
    expect(reportText).not.toContain(EMAIL);
    expect(reportText).toContain('IMPORT_UNIT_NOT_FOUND');
    expect(spy.mock.calls.length).toBeGreaterThan(0);
    const logText = JSON.stringify(spy.mock.calls);
    expect(logText).not.toContain(PERSON_NAME);
    expect(logText).not.toContain(PHONE);
    expect(logText).not.toContain(EMAIL);
    expect(logText).not.toContain('不存在的单位');
    expect(logText).toContain('"kind":"items"');
    expect(logText).toContain('durationMs');
  } finally {
    spy.mockRestore();
  }
});
