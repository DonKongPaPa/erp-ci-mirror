// @vitest-environment node
import { expect, it } from 'vitest';

import { IssueApplicationApiKeyBody } from '../../server/routes/schemas.js';

/**
 * R-032 第 7 条的补强：只打签发请求体的 Zod schema。
 * 端点上插件 `keys.check` 还会再校验一次过期天数，所以只靠端点测试时放宽 schema 区间仍然绿；
 * 这里独立钉住契约本身：1 到 365 的整数，必填。
 */

const body = (expiresInDays?: unknown) => ({
  name: 'R032 schema-only key',
  ...(expiresInDays === undefined ? {} : { expiresInDays }),
});

it('R-032 7: the issue schema accepts both ends of the 1..365 day range', () => {
  // 行为：边界 1 天与 365 天都合法，不能被误收窄。
  for (const days of [1, 365]) {
    expect(
      IssueApplicationApiKeyBody.safeParse(body(days)).success,
      `${days} 天应当合法`,
    ).toBe(true);
  }
});

it('R-032 7: the issue schema alone rejects missing, zero, 366 and fractional expiry', () => {
  // 行为：过期必填且只能是 1..365 的整数 —— 这一层不依赖插件的二次校验。
  for (const candidate of [
    body(),
    body(0),
    body(366),
    body(1.5),
    body('30'),
  ]) {
    expect(
      IssueApplicationApiKeyBody.safeParse(candidate).success,
      `${JSON.stringify(candidate)} 不该通过 schema`,
    ).toBe(false);
  }
});
