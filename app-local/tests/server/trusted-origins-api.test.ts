import { createAppTest } from '../helpers/test-app.js';
import { createStandaloneServer } from '../../server/standalone.js';
import { describe, expect } from 'vitest';

/**
 * 写请求的可信来源：环境变量里列出的来源放行，其余仍按框架的来源校验拒绝。
 * 带假 Cookie 的请求过了来源校验后没有会话，所以得到的是 401 而不是 403。
 */
const test = createAppTest({
  createServer: createStandaloneServer,
  config: {
    app: { publicOrigin: 'http://localhost' },
    auth: { secret: 'test-auth-secret-at-least-32-characters' },
  },
  server: {
    env: { APP_TRUSTED_ORIGINS: 'https://a.example:13000' },
  },
});

const TIMEOUT = { timeout: 30_000 };

interface ApiErrorBody {
  error: { reason: string };
}

/** A write request carrying a browser-style cookie but no valid session. */
const writeWithOrigin = (
  request: (path: string, init?: RequestInit) => Promise<Response>,
  origin: string,
) =>
  request('/departments', {
    method: 'POST',
    headers: {
      cookie: 'nocobase_session_x=1',
      'content-type': 'application/json',
      origin,
    },
    body: JSON.stringify({ title: '来源校验', code: `ORIGIN-${Date.now()}` }),
  });

describe('APP_TRUSTED_ORIGINS on write requests', () => {
  test('accepts a listed origin: the fake cookie reaches session lookup and gets 401', TIMEOUT, async ({
    request,
  }) => {
    const response = await writeWithOrigin(request, 'https://a.example:13000');
    expect(response.status).toBe(401);
  });

  test('refuses an unlisted origin with INVALID_CSRF_ORIGIN', TIMEOUT, async ({
    request,
  }) => {
    const response = await writeWithOrigin(request, 'https://evil.example:13000');
    expect(response.status).toBe(403);
    expect(((await response.json()) as ApiErrorBody).error.reason).toBe(
      'INVALID_CSRF_ORIGIN',
    );
  });

  test('does not let the same host over http borrow an https-only listing', TIMEOUT, async ({
    request,
  }) => {
    const response = await writeWithOrigin(request, 'http://a.example:13000');
    expect(response.status).toBe(403);
    expect(((await response.json()) as ApiErrorBody).error.reason).toBe(
      'INVALID_CSRF_ORIGIN',
    );
  });

  test('still trusts the local publicOrigin when the list holds another origin', TIMEOUT, async ({
    request,
  }) => {
    const response = await writeWithOrigin(request, 'http://localhost');
    expect(response.status).toBe(401);
  });
});
