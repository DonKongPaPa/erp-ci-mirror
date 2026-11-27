/**
 * R-021 加片：单据金额算法，订单与库存单据共用的一处纯函数（无数据库、无上下文）。
 *
 * 口径（照 R-021「金额算法」）：
 * - 没给税率的行不算金额，输入里的两个单价都不落新列；原有 price 列照旧由调用方写入。
 * - 两个单价都给时以含税单价为准，未税单价按含税重算；只给未税单价必须同时给税率。
 * - 单价 4 位、金额 2 位，四舍五入；税额是价税合计减未税金额。
 * - 头上的合计只累加算了金额的行；一行都没算时四个合计是 null，总数量照算。
 */

export type AmountRuleCode = 'line-price-invalid' | 'discount-invalid';

export class AmountRuleError extends Error {
  public constructor(
    readonly code: AmountRuleCode,
    readonly detail?: string,
  ) {
    super(detail === undefined ? `Amount rule violated: ${code}` : `Amount rule violated: ${code} (${detail})`);
    this.name = 'AmountRuleError';
  }
}

export interface AmountLineInput {
  readonly qty: number;
  /** 含税单价；库存单据行传 taxIncludedPrice。 */
  readonly price?: number | null;
  readonly taxExcludedPrice?: number | null;
  readonly taxRate?: number | null;
}

export interface AmountLineResult {
  readonly qty: number;
  readonly taxRate: number | null;
  readonly price: number | null;
  readonly taxExcludedPrice: number | null;
  readonly taxExcludedAmount: number | null;
  readonly taxAmount: number | null;
  readonly taxIncludedAmount: number | null;
}

export interface AmountHeaderResult {
  readonly totalQty: number;
  readonly taxIncludedTotal: number | null;
  readonly taxExcludedTotal: number | null;
  readonly taxTotal: number | null;
  readonly discountAmount: number;
  readonly payableTotal: number | null;
}

/** 先用 15 位有效数字抹掉二进制浮点尾差，再四舍五入；金额都是非负数。 */
export function roundAmount(value: number, digits: number): number {
  const factor = 10 ** digits;
  const scaled = Number((value * factor).toPrecision(15));
  return Math.round(scaled) / factor;
}

const validPrice = (value: unknown): boolean =>
  value === undefined || value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0);

/** 一行算完的金额；没给税率时新列全为 null。调用方仍要把 price 落到原有列。 */
export function computeLineAmounts(input: AmountLineInput): AmountLineResult {
  const { qty, price, taxRate } = input;
  const excluded = input.taxExcludedPrice;
  if (
    !Number.isFinite(qty) ||
    qty < 0 ||
    !validPrice(price) ||
    !validPrice(excluded) ||
    (taxRate !== undefined && taxRate !== null && (!Number.isFinite(taxRate) || taxRate < 0 || taxRate > 100))
  ) {
    throw new AmountRuleError('line-price-invalid');
  }
  if (taxRate === undefined || taxRate === null) {
    if (excluded !== undefined && excluded !== null) {
      throw new AmountRuleError('line-price-invalid', 'tax-excluded-price-without-rate');
    }
    return {
      qty,
      taxRate: null,
      price: price ?? null,
      taxExcludedPrice: null,
      taxExcludedAmount: null,
      taxAmount: null,
      taxIncludedAmount: null,
    };
  }
  const multiplier = 1 + taxRate / 100;
  let includedPrice: number;
  let excludedPrice: number;
  if (price !== undefined && price !== null) {
    includedPrice = price;
    excludedPrice = roundAmount(price / multiplier, 4);
  } else if (excluded !== undefined && excluded !== null) {
    includedPrice = roundAmount(excluded * multiplier, 4);
    excludedPrice = excluded;
  } else {
    // 只给税率不给任何单价：金额仍不算，避免把 0 当成有效价格。
    return {
      qty,
      taxRate,
      price: null,
      taxExcludedPrice: null,
      taxExcludedAmount: null,
      taxAmount: null,
      taxIncludedAmount: null,
    };
  }
  const taxIncludedAmount = roundAmount(includedPrice * qty, 2);
  const taxExcludedAmount = roundAmount(excludedPrice * qty, 2);
  return {
    qty,
    taxRate,
    price: includedPrice,
    taxExcludedPrice: excludedPrice,
    taxExcludedAmount,
    taxAmount: roundAmount(taxIncludedAmount - taxExcludedAmount, 2),
    taxIncludedAmount,
  };
}

/** 头上合计：只累加算了金额的行；优惠 0 到含税总金额，优惠后金额 = 含税总金额 − 优惠。 */
export function computeHeaderAmounts(
  lines: readonly AmountLineResult[],
  discount: number,
): AmountHeaderResult {
  if (!Number.isFinite(discount) || discount < 0) {
    throw new AmountRuleError('discount-invalid');
  }
  const totalQty = roundAmount(
    lines.reduce((sum, line) => sum + line.qty, 0),
    4,
  );
  const computed = lines.filter((line) => line.taxIncludedAmount !== null);
  if (computed.length === 0) {
    if (discount > 0) throw new AmountRuleError('discount-invalid');
    return {
      totalQty,
      taxIncludedTotal: null,
      taxExcludedTotal: null,
      taxTotal: null,
      discountAmount: 0,
      payableTotal: null,
    };
  }
  const sum = (pick: (line: AmountLineResult) => number | null): number =>
    roundAmount(computed.reduce((acc, line) => acc + (pick(line) ?? 0), 0), 2);
  const taxIncludedTotal = sum((line) => line.taxIncludedAmount);
  if (discount > taxIncludedTotal) throw new AmountRuleError('discount-invalid');
  return {
    totalQty,
    taxIncludedTotal,
    taxExcludedTotal: sum((line) => line.taxExcludedAmount),
    taxTotal: sum((line) => line.taxAmount),
    discountAmount: discount,
    payableTotal: roundAmount(taxIncludedTotal - discount, 2),
  };
}
