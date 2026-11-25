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

it('leaves error codes, numbers, times and URL digits untouched', () => {
  for (const text of [
    '550 5.1.1',
    '550.5.1.1',
    'INV-2024-001',
    '138-1234-5678',
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
