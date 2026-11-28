import { ApiClientError } from '@nocobase/app-client';
import { describe, expect, it } from 'vitest';

import { errorText } from '../../client/components/erp/messages.js';
import zhCN from '../../client/locales/zh-CN.js';

/** 直接读语言包，不另写一份期望文案，改文案时测试跟着走。 */
const t = (key: string, options?: Record<string, unknown>): string => {
  const found = key.split('.').reduce<unknown>(
    (value, part) =>
      value !== null && typeof value === 'object'
        ? (value as Record<string, unknown>)[part]
        : undefined,
    zhCN,
  );
  if (typeof found !== 'string') return key;
  return options === undefined ? found : found.replace(/\{\{(\w+)\}\}/gu, (_, name: string) => String(options[name] ?? ''));
};

const raw = (status: number, message: string): ApiClientError =>
  new ApiClientError(message, {
    status,
    payload: { error: { reason: 'RAW', message } },
    method: 'GET',
    url: '/api/customers/c1',
  });

describe('错误文案不端出英文原码', () => {
  it('403 显示没有权限的中文提示', () => {
    expect(errorText(raw(403, 'No grant allows customers.view'), t)).toBe(
      '你没有这项操作的权限。',
    );
  });

  it('404 显示记录不存在的中文提示', () => {
    expect(errorText(raw(404, 'The requested record was not found.'), t)).toBe(
      '这条记录不存在，请刷新后重试。',
    );
  });

  it('服务端翻好的句子优先', () => {
    const localized = new ApiClientError('Finance rule violated: partner-invalid', {
      status: 422,
      payload: {
        error: {
          reason: 'FINANCE_PARTNER_INVALID',
          message: 'Finance rule violated: partner-invalid',
          localizedMessage: { locale: 'zh-CN', message: '请换一张订单。' },
        },
      },
      method: 'POST',
      url: '/api/expenses/f1/confirm',
    });
    expect(errorText(localized, t)).toBe('请换一张订单。');
  });
});
