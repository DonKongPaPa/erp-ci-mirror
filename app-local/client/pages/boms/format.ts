/** 数量、用量、损耗率的统一显示：等宽数字，保留服务端给的小数位。 */
export function qtyText(value: number, locale: string): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 6 }).format(value);
}

/** 金额显示：服务端才算得出金额，页面只回显它给的键。 */
export function moneyText(value: number, locale: string): string {
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: 'CNY',
    minimumFractionDigits: 2,
  }).format(value);
}
