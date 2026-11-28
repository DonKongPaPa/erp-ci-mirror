// @vitest-environment node
import { expect, test } from 'vitest';

import enUS from '../../server/locales/en-US.js';
import zhCN from '../../server/locales/zh-CN.js';

/**
 * 缺陷 8：建审批单失败的内部原因码不能原样给用户。两种语言都要有专门的中文/英文句子，
 * 且不依赖 {{reason}} 插值 —— 原先服务端把 `department HQ` 塞进文案里。
 */
test('approval-failed 的 no-approver 原因码在两种语言里都有可读文案', () => {
  for (const [locale, copy] of [
    ['zh-CN', zhCN],
    ['en-US', enUS],
  ] as const) {
    for (const group of ['purchaseRequest', 'financeRequest'] as const) {
      const message = copy[group].errors.approvalFailedNoApprover;
      expect(typeof message, `${locale}/${group} 缺文案`).toBe('string');
      expect(message, `${locale}/${group} 不能留插值槽`).not.toContain('{{reason}}');
      expect(message).not.toMatch(/department\s+[A-Z0-9]{4,}/u);
      expect(message).not.toContain('no eligible');
    }
  }
  expect(zhCN.purchaseRequest.errors.approvalFailedNoApprover).toContain('找不到');
  expect(enUS.purchaseRequest.errors.approvalFailedNoApprover).toContain('No manager');
});
