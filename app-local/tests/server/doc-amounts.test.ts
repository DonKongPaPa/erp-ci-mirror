// @vitest-environment node
import { describe, expect, it } from 'vitest';

import {
  AmountRuleError,
  computeHeaderAmounts,
  computeLineAmounts,
  roundAmount,
} from '../../server/providers/doc-amounts.js';

/**
 * R-021 加片：金额纯函数的口径逐个数核对。这里不连库，调用方（订单、库存单据、
 * 财务）共用这同一处算法，改坏这里三片的金额都会跟着红。
 */
describe('doc-amounts', () => {
  it('税率 13、含税单价 113、数量 10：未税单价 100，金额 1000 / 130 / 1130', () => {
    const line = computeLineAmounts({ qty: 10, price: 113, taxRate: 13 });
    expect(line).toEqual({
      qty: 10,
      taxRate: 13,
      price: 113,
      taxExcludedPrice: 100,
      taxExcludedAmount: 1000,
      taxAmount: 130,
      taxIncludedAmount: 1130,
    });
    expect(computeHeaderAmounts([line], 30)).toEqual({
      totalQty: 10,
      taxIncludedTotal: 1130,
      taxExcludedTotal: 1000,
      taxTotal: 130,
      discountAmount: 30,
      payableTotal: 1100,
    });
  });

  it('税率 13、含税单价 226、数量 5：未税单价 200，合计 1000 / 130 / 1130', () => {
    const line = computeLineAmounts({ qty: 5, price: 226, taxRate: 13 });
    expect(line.taxExcludedPrice).toBe(200);
    expect(line.taxExcludedAmount).toBe(1000);
    expect(line.taxAmount).toBe(130);
    expect(line.taxIncludedAmount).toBe(1130);
  });

  it('两个单价都给以含税为准，请求里的未税单价被忽略', () => {
    const line = computeLineAmounts({
      qty: 10, price: 113, taxExcludedPrice: 999, taxRate: 13,
    });
    expect(line.taxExcludedPrice).toBe(100);
    expect(line.taxExcludedAmount).toBe(1000);
  });

  it('只给未税单价与税率时反推含税单价', () => {
    const line = computeLineAmounts({ qty: 5, taxExcludedPrice: 200, taxRate: 13 });
    expect(line.price).toBe(226);
    expect(line.taxIncludedAmount).toBe(1130);
  });

  it('四舍五入边界：单价 4 位、金额 2 位', () => {
    const line = computeLineAmounts({ qty: 3, price: 10.01, taxRate: 13 });
    expect(line.taxExcludedPrice).toBe(8.8584);
    expect(line.taxIncludedAmount).toBe(30.03);
    expect(line.taxExcludedAmount).toBe(26.58);
    expect(line.taxAmount).toBe(3.45);
    expect(roundAmount(1.005, 2)).toBe(1.01);
    expect(roundAmount(2.675, 2)).toBe(2.68);
  });

  it('没给税率的行不算金额：新列全空，price 保留，合计按算过的行累加', () => {
    const plain = computeLineAmounts({ qty: 7, price: 3.25 });
    expect(plain).toEqual({
      qty: 7, taxRate: null, price: 3.25, taxExcludedPrice: null,
      taxExcludedAmount: null, taxAmount: null, taxIncludedAmount: null,
    });
    const priced = computeLineAmounts({ qty: 10, price: 113, taxRate: 13 });
    const header = computeHeaderAmounts([plain, priced], 0);
    expect(header.totalQty).toBe(17);
    expect(header.taxIncludedTotal).toBe(1130);
    expect(header.payableTotal).toBe(1130);
  });

  it('一行都没算金额时四个合计是 null，不是 0；总数量照算', () => {
    const line = computeLineAmounts({ qty: 4, price: 9 });
    expect(computeHeaderAmounts([line], 0)).toEqual({
      totalQty: 4, taxIncludedTotal: null, taxExcludedTotal: null,
      taxTotal: null, discountAmount: 0, payableTotal: null,
    });
  });

  it('拒绝：只给未税单价不给税率、税率越界、单价为负、优惠越界', () => {
    expect(() => computeLineAmounts({ qty: 1, taxExcludedPrice: 10 }))
      .toThrowError(AmountRuleError);
    expect(() => computeLineAmounts({ qty: 1, price: 10, taxRate: 101 }))
      .toThrowError(AmountRuleError);
    expect(() => computeLineAmounts({ qty: 1, price: -1, taxRate: 13 }))
      .toThrowError(AmountRuleError);
    const line = computeLineAmounts({ qty: 10, price: 113, taxRate: 13 });
    expect(() => computeHeaderAmounts([line], 1130.01)).toThrowError(AmountRuleError);
    expect(() => computeHeaderAmounts([line], -1)).toThrowError(AmountRuleError);
    expect(() => computeHeaderAmounts([computeLineAmounts({ qty: 1, price: 2 })], 1))
      .toThrowError(AmountRuleError);
  });
});
