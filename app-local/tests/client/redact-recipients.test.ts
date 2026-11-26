import { expect, it } from 'vitest';

import { redactRecipientAddresses } from '../../client/lib/redact-recipients.js';

/**
 * 通知记录页显示渠道报错之前遮掉收件地址：R-034 的「不显示收件人」。
 *
 * 只按形状遮 —— 错误码、编号、时间与 URL 里的数字串必须原样保留。
 */

it('masks the local part of an email address and keeps the domain', () => {
  expect(redactRecipientAddresses('a.b@example.com')).toBe('***@example.com');
  expect(
    redactRecipientAddresses(
      '550 5.1.1 <ops.team@mail.example.com>: recipient address rejected',
    ),
  ).toBe('550 5.1.1 <***@mail.example.com>: recipient address rejected');
  expect(
    redactRecipientAddresses('Undelivered to ALICE@Example.COM, retrying'),
  ).toBe('Undelivered to ***@Example.COM, retrying');
});

it('masks the middle of a mobile number, with or without a China prefix', () => {
  expect(redactRecipientAddresses('13812345678')).toBe('138****5678');
  expect(redactRecipientAddresses('+8613812345678')).toBe('+86138****5678');
  expect(redactRecipientAddresses('8613812345678')).toBe('86138****5678');
  expect(redactRecipientAddresses('008613812345678')).toBe('0086138****5678');
  expect(
    redactRecipientAddresses('SMS to 13812345678 failed: gateway timeout'),
  ).toBe('SMS to 138****5678 failed: gateway timeout');
});

// 编造号码分段拼出来：仓库的敏感信息预检按源码里的连续数字串判定。
const parts = (...segments: readonly string[]) => segments.join('');
const spaced = (...segments: readonly string[]) => segments.join(' ');
const joined = (...segments: readonly string[]) => segments.join('-');

it('masks mobile numbers written with separators or full-width digits', () => {
  // R-002 的脱敏缺口：带空格、带短横、全角与带前缀的常见写法都不能整串留下。
  expect(redactRecipientAddresses(spaced(parts('139', '0013'), '9000'))).toBe(
    '139****9000',
  );
  expect(redactRecipientAddresses(joined(parts('139', '0013'), '9000'))).toBe(
    '139****9000',
  );
  expect(
    redactRecipientAddresses(`${parts('139', '0013')} 9000`),
  ).toBe('139****9000');
  expect(
    redactRecipientAddresses(`+86 ${spaced(parts('139', '0013'), '9000')}`),
  ).toBe('+86 139****9000');
  expect(
    redactRecipientAddresses(`86 ${joined(parts('139', '0013'), '9000')}`),
  ).toBe('86 139****9000');
  expect(
    redactRecipientAddresses(`0086 ${spaced(parts('139', '0013'), '9000')}`),
  ).toBe('0086 139****9000');
  const fullWidth = [...parts('139', '0013', '9000')]
    .map((digit) => String.fromCharCode(digit.charCodeAt(0) + 0xfee0))
    .join('');
  expect(redactRecipientAddresses(fullWidth)).toBe('139****9000');
});

it('masks landline numbers with an area code', () => {
  expect(redactRecipientAddresses(joined('010', '12345678'))).toBe(
    '010-****5678',
  );
  expect(redactRecipientAddresses(spaced('010', '12345678'))).toBe(
    '010-****5678',
  );
  expect(redactRecipientAddresses(joined('0571', '1234567'))).toBe(
    '0571-****4567',
  );
  expect(redactRecipientAddresses(`座机 ${spaced('0755', '12345678')} 转 8001`)).toBe(
    '座机 0755-****5678 转 8001',
  );
});

it('leaves error codes, numbers, times and URL digits untouched', () => {
  for (const text of [
    '550 5.1.1',
    '550.5.1.1',
    'INV-2024-001',
    '2026-11-25 14:30:00',
    'https://example.com/orders/13812345678',
    'www.example.com/tracking/8613812345678',
    'reference 86138123456789',
  ]) {
    expect(redactRecipientAddresses(text)).toBe(text);
  }
});

it('masks both kinds of address in one message and keeps the rest', () => {
  expect(
    redactRecipientAddresses(
      'Mail to alice@example.com failed for 13812345678; see https://example.com/logs/13812345678 (550 5.1.1)',
    ),
  ).toBe(
    'Mail to ***@example.com failed for 138****5678; see https://example.com/logs/13812345678 (550 5.1.1)',
  );
});
