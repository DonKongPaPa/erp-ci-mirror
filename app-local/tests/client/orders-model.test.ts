import { ApiClientError } from '@nocobase/app-client';
import { describe, expect, it } from 'vitest';

import type { Translate } from '#components/erp/messages';
import {
  toOrder,
  type OrderResponse,
} from '../../client/pages/orders/client.js';
import { PURCHASE, SALES } from '../../client/pages/orders/kinds.js';
import {
  dayEnd,
  dayStart,
  emptyOrderForm,
  orderInputOf,
  orderTotal,
  parseDate,
  parseDecimal,
  receiptFieldErrors,
  receiptInputOf,
  receiptFormOf,
  validateOrderForm,
  validateReceipt,
  type LineDraft,
} from '../../client/pages/orders/model.js';

/** 只看键：提示文字本身在语言包里，由页面测试覆盖。 */
const t = ((key: string) => key) as Translate;
type Errors = Record<string, string | undefined>;
const keys = (errors: Errors): string[] =>
  Object.keys(errors).filter((key) => errors[key]);
const line = (patch: Partial<LineDraft>): LineDraft => ({
  key: 'k',
  itemId: 'i1',
  qty: '10',
  price: '2.5',
  ...patch,
});

describe('order pages: the model behind the forms', () => {
  it('reads a day written as YYYY-MM-DD and refuses anything that is not a real day', () => {
    expect(parseDate('2026-11-27')).toEqual({
      year: 2026,
      month: 11,
      day: 27,
    });
    expect(parseDate(' 2026-11-27 ')).toEqual(parseDate('2026-11-27'));
    for (const text of [
      '',
      '2026-2-3',
      '2026/11/27',
      '2026-13-01',
      '2026-02-30',
      'abcd-ef-gh',
    ]) {
      expect(parseDate(text), `「${text}」不是合规的日期`).toBeUndefined();
    }

    // 端点按带时区的 ISO 时间串筛创建时间：从这一天零点到最后一毫秒。
    const day = { year: 2026, month: 11, day: 27 };
    expect(dayStart(day)).toBe(new Date(2026, 10, 27).toISOString());
    expect(new Date(dayEnd(day)).getTime()).toBe(
      new Date(2026, 10, 28).getTime() - 1,
    );
  });

  it('accepts quantities and prices with at most four decimals and nothing else', () => {
    expect(parseDecimal('10')).toBe(10);
    expect(parseDecimal(' 2.5 ')).toBe(2.5);
    expect(parseDecimal('0.0001')).toBe(0.0001);
    for (const text of ['', '-1', '1,000', '1e3', '1.00001', 'abc', '1.']) {
      expect(parseDecimal(text), `「${text}」不该被当成数量`).toBeUndefined();
    }
  });

  it('adds up amounts to four decimals, and only when every line has a price', () => {
    expect(
      orderTotal([
        { qty: 10, price: 2.5 },
        { qty: 3, price: 0.1 },
      ]),
    ).toBe(25.3);
    expect(
      orderTotal([
        { qty: 10, price: 2.5 },
        { qty: 4, price: null },
      ]),
    ).toBeUndefined();
    expect(orderTotal([])).toBe(0);
  });

  it('validates the order form only where it is wrong, in the order the cursor follows', () => {
    // 新建时单据日期默认是今天，所以空表单只差往来单位与明细；清掉日期才报日期。
    expect(keys(validateOrderForm(emptyOrderForm(), 'Supplier', t))).toEqual([
      'partnerId',
      'lines',
    ]);
    expect(
      keys(
        validateOrderForm(
          { ...emptyOrderForm(), orderDate: '' },
          'Supplier',
          t,
        ),
      ),
    ).toEqual(['partnerId', 'orderDate', 'lines']);

    const wrong = {
      partnerId: 'p1',
      orderDate: '2026-11-27',
      remark: ' note ',
      lines: [
        line({ key: 'a' }),
        line({ key: 'b', itemId: '' }),
        line({ key: 'c', itemId: 'i2', qty: '0', price: '-1' }),
      ],
    };
    expect(keys(validateOrderForm(wrong, 'Supplier', t))).toEqual([
      'item-b',
      'qty-c',
      'price-c',
    ]);
    // 同一个物料出现两行：两行都标出来。
    const twice = {
      ...wrong,
      lines: [line({ key: 'a' }), line({ key: 'b' })],
    };
    expect(keys(validateOrderForm(twice, 'Supplier', t))).toEqual([
      'item-a',
      'item-b',
    ]);
    expect(
      keys(
        validateOrderForm({ ...wrong, orderDate: '2026-02-30' }, 'Supplier', t),
      ),
    ).toContain('orderDate');
  });

  it('sends the contract shape and leaves the price out when it was not filled in', () => {
    expect(
      orderInputOf({
        partnerId: 'p1',
        orderDate: ' 2026-11-27 ',
        remark: ' note ',
        lines: [line({ key: 'a' }), line({ key: 'b', qty: '4', price: '' })],
      }),
    ).toEqual({
      partnerId: 'p1',
      orderDate: '2026-11-27',
      remark: 'note',
      lines: [
        { itemId: 'i1', qty: 10, price: 2.5 },
        { itemId: 'i1', qty: 4 },
      ],
    });
  });

  it('validates the stock-document dialog against what is left on each line', () => {
    const order = toOrder(PURCHASE, {
      id: 'o1',
      orderNo: 'PO-1',
      status: 'ordered',
      orderDate: '2026-11-27',
      remark: '',
      submittedAt: null,
      createdAt: '',
      updatedAt: '',
      supplierId: 'p1',
      lines: [
        {
          id: 'l1',
          itemId: 'i1',
          qty: 10,
          price: null,
          receivedQty: 4,
          remainingQty: 6,
        },
        {
          id: 'l2',
          itemId: 'i2',
          qty: 5,
          price: null,
          receivedQty: 5,
          remainingQty: 0,
        },
      ],
    });
    // 已经生成完的行不列；其余行的本次数量默认就是未到货数量。
    expect(receiptFormOf(order)).toEqual({
      warehouseId: '',
      quantities: { l1: '6' },
    });
    expect(
      keys(
        validateReceipt(
          { warehouseId: '', quantities: { l1: '6' } },
          order,
          'received',
          t,
        ),
      ),
    ).toEqual(['warehouseId']);
    // 超过未到货数量：只说这一处，不再多说一句「至少要有一行大于 0」。
    expect(
      keys(
        validateReceipt(
          { warehouseId: 'w1', quantities: { l1: '7' } },
          order,
          'received',
          t,
        ),
      ),
    ).toEqual(['qty-l1']);
    expect(
      keys(
        validateReceipt(
          { warehouseId: 'w1', quantities: { l1: '0' } },
          order,
          'received',
          t,
        ),
      ),
    ).toEqual(['receipt']);
    expect(
      keys(
        validateReceipt(
          { warehouseId: 'w1', quantities: { l1: 'x' } },
          order,
          'received',
          t,
        ),
      ),
    ).toEqual(['qty-l1', 'receipt']);
    // 留 0 的行不生成。
    expect(
      receiptInputOf({ warehouseId: 'w1', quantities: { l1: '0', l2: '2.5' } }),
    ).toEqual({ warehouseId: 'w1', lines: [{ lineId: 'l2', qty: 2.5 }] });

    // 服务端说超过剩余：那句话标在填得比未到货数量大的那一行下面；找不到就标在第一行。
    const exceeds = new ApiClientError('raw', {
      status: 422,
      reason: 'ORDER_QTY_EXCEEDS_REMAINING',
      method: 'POST',
      url: 'x',
    });
    expect(
      keys(
        receiptFieldErrors(
          exceeds,
          { warehouseId: 'w1', quantities: { l1: '8' } },
          order,
        ),
      ),
    ).toEqual(['qty-l1']);
    expect(
      receiptFieldErrors(
        exceeds,
        { warehouseId: 'w1', quantities: { l1: '6' } },
        order,
      ),
    ).toEqual({ 'qty-l1': 'raw' });
  });

  it('turns both order endpoints into one shape, and an unregistered status into no status', () => {
    const raw: OrderResponse = {
      id: 'o1',
      orderNo: 'PO-1',
      status: 'partially_received',
      orderDate: '2026-11-27',
      remark: '',
      submittedAt: null,
      createdAt: '',
      updatedAt: '',
      supplierId: 'p1',
      supplier: {
        id: 'p1',
        code: 'SU1',
        name: 'Sample Vendor',
        status: 'active',
      },
      lines: [
        {
          id: 'l1',
          itemId: 'i1',
          qty: 10,
          price: null,
          receivedQty: 4,
          remainingQty: 6,
        },
      ],
    };
    const purchase = toOrder(PURCHASE, raw);
    expect(purchase).toMatchObject({
      partnerId: 'p1',
      status: 'partial',
      apiStatus: 'partially_received',
    });
    expect(purchase.partner?.name).toBe('Sample Vendor');
    expect(purchase.lines[0]).toMatchObject({
      doneQty: 4,
      remainingQty: 6,
      price: null,
    });

    const sales = toOrder(SALES, {
      ...raw,
      status: 'partially_shipped',
      customerId: 'c9',
      customer: null,
      lines: [
        {
          id: 'l1',
          itemId: 'i1',
          qty: 10,
          price: 2,
          shippedQty: 1,
          remainingQty: 9,
        },
      ],
    });
    expect(sales).toMatchObject({
      partnerId: 'c9',
      status: 'partial',
      partner: null,
    });
    expect(sales.lines[0]).toMatchObject({ doneQty: 1, price: 2 });

    // 没登记的状态不当作草稿：页面只显示、不给任何操作。列表的行没有明细。
    const unknown = toOrder(PURCHASE, {
      ...raw,
      status: 'something_new',
      lines: undefined,
    });
    expect(unknown.status).toBe('unknown');
    expect(unknown.apiStatus).toBe('something_new');
    expect(unknown.lines).toEqual([]);
  });
});
