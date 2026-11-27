import { ApiClientError } from '@nocobase/app-client';

import type { FieldErrors } from '#components/erp/form-dialog';
import { serverMessage, type Translate } from '#components/erp/messages';

import type {
  CreateOrderInput,
  MakeDocumentInput,
  Order,
  OrderLine,
} from './client.js';

/**
 * 订单页面的纯逻辑：表单的值、提交时才跑的校验、发给端点的形状、规则码落到哪一项下面。
 * 不碰 React，测试可以直接调。
 */

// ---------- 日期 ----------

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/u;

export interface YearMonthDay {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

const pad = (value: number): string => String(value).padStart(2, '0');

/** 「YYYY-MM-DD」→ 年月日；写得不合规或不是真实的日子（2 月 30 日）返回 `undefined`。 */
export function parseDate(text: string): YearMonthDay | undefined {
  const match = DATE.exec(text.trim());
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day);
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  )
    return undefined;
  return { year, month, day };
}

/** 今天的「YYYY-MM-DD」（本机时区）。 */
export function today(): string {
  const now = new Date();
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** 带时区的 ISO 时间串 → 本机时区的「YYYY-MM-DD」；地址栏里的创建时间筛选用它回填。 */
export function dateFromIso(iso: string): string | undefined {
  if (!iso) return undefined;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return undefined;
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

const localDay = ({ year, month, day }: YearMonthDay): Date =>
  new Date(year, month - 1, day);

/** 这一天零点，带时区的 ISO 时间串。 */
export function dayStart(day: YearMonthDay): string {
  return localDay(day).toISOString();
}

/** 这一天的最后一毫秒：端点的 `to` 含端点。 */
export function dayEnd(day: YearMonthDay): string {
  return new Date(localDay(day).getTime() + 86_400_000 - 1).toISOString();
}

// ---------- 数量与金额 ----------

/** 端点的数量与单价都是 `decimal(18,4)`：最多四位小数，不收负数、千分位与科学记数。 */
const DECIMAL = /^\d+(\.\d{1,4})?$/u;

/** 合规的十进制数 → 数值；否则 `undefined`。 */
export function parseDecimal(text: string): number | undefined {
  const value = text.trim();
  return DECIMAL.test(value) ? Number(value) : undefined;
}

/** 金额按四位小数取舍，页面上的行金额与合计才对得上。 */
export const round4 = (value: number): number =>
  Math.round(value * 10_000) / 10_000;

interface Priced {
  readonly qty: number;
  readonly price?: number | null;
}

/** 一行的金额 = 数量 × 单价；没填单价就是 `undefined`。 */
export function lineAmount(line: Priced): number | undefined {
  return line.price === null || line.price === undefined
    ? undefined
    : round4(line.qty * line.price);
}

/** 合计金额：每一行都填了单价才算得出来，否则 `undefined`（页面不画合计行）。 */
export function orderTotal(lines: readonly Priced[]): number | undefined {
  let total = 0;
  for (const line of lines) {
    const amount = lineAmount(line);
    if (amount === undefined) return undefined;
    total += amount;
  }
  return round4(total);
}

/** 数量与单价：最多四位小数，不带多余的四舍五入。 */
export function formatNumber(
  value: number,
  locale: string,
  minimumFractionDigits = 0,
): string {
  return new Intl.NumberFormat(locale, {
    minimumFractionDigits,
    maximumFractionDigits: 4,
  }).format(value);
}

/** 金额：至少两位小数。 */
export const formatAmount = (value: number, locale: string): string =>
  formatNumber(value, locale, 2);

export function formatDateTime(iso: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(iso));
}

// ---------- 新建与编辑的表单 ----------

/** 明细行在表单里的样子：数量与单价先留成文字，提交时才换算与校验。 */
export interface LineDraft {
  /** 页面自己发的键，不是明细的 id。 */
  readonly key: string;
  readonly itemId: string;
  readonly qty: string;
  /** 含税单价（端点上仍叫 `price`）。 */
  readonly price: string;
  readonly deliveryDate: string;
  readonly taxRate: string;
  readonly taxExcludedPrice: string;
  readonly note: string;
}

export interface OrderFormValues {
  readonly partnerId: string;
  readonly orderDate: string;
  readonly remark: string;
  readonly lines: readonly LineDraft[];
  // 波 0 加片：金额由服务端算，表单只录原始输入与回显服务端算出的值。
  readonly warehouseId: string;
  readonly contactName: string;
  readonly contactPhone: string;
  readonly deliveryAddress: string;
  readonly settlementCode: string;
  readonly projectCode: string;
  readonly customerOrderNo: string;
  readonly handlerUserId: string;
  readonly discountAmount: string;
  readonly fileIds: readonly string[];
  /** 端点回过加片的键才在编辑时送 null 清空；老单据不夹带新键，保持旧请求形状。 */
  readonly hasAddons: boolean;
}

export const emptyOrderForm = (): OrderFormValues => ({
  partnerId: '',
  orderDate: today(),
  remark: '',
  lines: [],
  warehouseId: '',
  contactName: '',
  contactPhone: '',
  deliveryAddress: '',
  settlementCode: '',
  projectCode: '',
  customerOrderNo: '',
  handlerUserId: '',
  discountAmount: '',
  fileIds: [],
  hasAddons: false,
});

export const newLine = (defaultTaxRate = ''): LineDraft => ({
  key: `new-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  itemId: '',
  qty: '',
  price: '',
  deliveryDate: '',
  taxRate: defaultTaxRate,
  taxExcludedPrice: '',
  note: '',
});

export const orderFormOf = (order: Order): OrderFormValues => ({
  partnerId: order.partnerId,
  orderDate: order.orderDate,
  remark: order.remark,
  lines: order.lines.map((line) => ({
    key: line.id,
    itemId: line.itemId,
    qty: String(line.qty),
    price: line.price === null || line.price === undefined ? '' : String(line.price),
    deliveryDate: line.deliveryDate ?? '',
    taxRate: line.taxRate === null || line.taxRate === undefined ? '' : String(line.taxRate),
    taxExcludedPrice:
      line.taxExcludedPrice === null || line.taxExcludedPrice === undefined
        ? ''
        : String(line.taxExcludedPrice),
    note: line.note ?? '',
  })),
  warehouseId: order.warehouseId ?? '',
  contactName: order.contactName ?? '',
  contactPhone: order.contactPhone ?? '',
  deliveryAddress: order.deliveryAddress ?? '',
  settlementCode: order.settlementCode ?? '',
  projectCode: order.projectCode ?? '',
  customerOrderNo: order.customerOrderNo ?? '',
  handlerUserId: order.handlerUserId ?? '',
  discountAmount:
    order.discountAmount === null || order.discountAmount === undefined
      ? ''
      : String(order.discountAmount),
  fileIds: (order.files ?? []).map((file) => file.id),
  hasAddons:
    order.warehouseId !== undefined ||
    order.contactName !== undefined ||
    order.settlementCode !== undefined ||
    order.projectCode !== undefined ||
    order.discountAmount !== undefined ||
    order.lines.some((line) => line.taxRate !== undefined) ||
    (order.files?.length ?? 0) > 0,
});

/** 提交时才跑：返回「字段名 → 提示」，键的顺序就是光标落下去的顺序。 */
export function validateOrderForm(
  values: OrderFormValues,
  partnerLabel: string,
  t: Translate,
): FieldErrors {
  const errors: Record<string, string | undefined> = {};
  if (!values.partnerId)
    errors.partnerId = t('orderDocs.errors.partnerRequired', {
      partner: partnerLabel,
    });
  if (!values.orderDate.trim())
    errors.orderDate = t('orderDocs.errors.dateRequired');
  else if (!parseDate(values.orderDate))
    errors.orderDate = t('orderDocs.errors.dateInvalid');
  if (values.lines.length === 0)
    errors.lines = t('orderDocs.errors.linesRequired');
  const uses = new Map<string, number>();
  for (const line of values.lines)
    uses.set(line.itemId, (uses.get(line.itemId) ?? 0) + 1);
  for (const line of values.lines) {
    if (!line.itemId)
      errors[`item-${line.key}`] = t('orderDocs.errors.itemRequired');
    else if ((uses.get(line.itemId) ?? 0) > 1)
      errors[`item-${line.key}`] = t('orderDocs.errors.itemDuplicated');
    if (!line.qty.trim())
      errors[`qty-${line.key}`] = t('orderDocs.errors.qtyRequired');
    else {
      const qty = parseDecimal(line.qty);
      if (qty === undefined || qty <= 0)
        errors[`qty-${line.key}`] = t('orderDocs.errors.qtyInvalid');
    }
    if (line.price.trim() && parseDecimal(line.price) === undefined)
      errors[`price-${line.key}`] = t('orderDocs.errors.priceInvalid');
    if ((line.deliveryDate ?? '').trim() && !parseDate(line.deliveryDate ?? ''))
      errors[`deliveryDate-${line.key}`] = t('orderDocs.errors.dateInvalid');
    if ((line.taxRate ?? '').trim()) {
      const rate = parseDecimal(line.taxRate ?? '');
      if (rate === undefined || rate < 0 || rate > 100)
        errors[`taxRate-${line.key}`] = t('orderDocs.errors.taxRateInvalid');
    }
    if (
      (line.taxExcludedPrice ?? '').trim() &&
      parseDecimal(line.taxExcludedPrice ?? '') === undefined
    )
      errors[`taxExcludedPrice-${line.key}`] = t('orderDocs.errors.priceInvalid');
    if ([...(line.note ?? '').trim()].length > 500)
      errors[`note-${line.key}`] = t('orderDocs.errors.noteTooLong');
  }
  if ((values.discountAmount ?? '').trim()) {
    const discount = parseDecimal(values.discountAmount ?? '');
    if (discount === undefined)
      errors.discountAmount = t('orderDocs.errors.priceInvalid');
  }
  return errors;
}

/** 空串在新建时不带这个键（端点存成 null），端点回过加片的编辑送 null 以便清空。 */
function text(value: string, clear: boolean): string | null | undefined {
  const trimmed = (value ?? '').trim();
  if (trimmed) return trimmed;
  return clear ? null : undefined;
}

/** 发给端点的形状；金额与合计一律不在这里算，交给服务端。 */
export function orderInputOf(values: OrderFormValues): CreateOrderInput {
  const clear = values.hasAddons;
  return {
    partnerId: values.partnerId,
    orderDate: values.orderDate.trim(),
    remark: values.remark.trim(),
    warehouseId: text(values.warehouseId ?? '', clear),
    contactName: text(values.contactName ?? '', clear),
    contactPhone: text(values.contactPhone ?? '', clear),
    deliveryAddress: text(values.deliveryAddress ?? '', clear),
    settlementCode: text(values.settlementCode ?? '', clear),
    projectCode: text(values.projectCode ?? '', clear),
    customerOrderNo: text(values.customerOrderNo ?? '', clear),
    handlerUserId: text(values.handlerUserId ?? '', clear),
    ...((values.discountAmount ?? '').trim()
      ? { discountAmount: Number(values.discountAmount) }
      : {}),
    ...(clear || (values.fileIds?.length ?? 0) > 0 ? { fileIds: values.fileIds ?? [] } : {}),
    lines: values.lines.map((line) => ({
      itemId: line.itemId,
      qty: Number(line.qty),
      ...(line.price.trim() ? { price: Number(line.price) } : {}),
      ...((line.deliveryDate ?? '').trim()
        ? { deliveryDate: (line.deliveryDate ?? '').trim() }
        : clear ? { deliveryDate: null } : {}),
      ...((line.taxRate ?? '').trim()
        ? { taxRate: Number(line.taxRate) }
        : clear ? { taxRate: null } : {}),
      ...((line.taxExcludedPrice ?? '').trim()
        ? { taxExcludedPrice: Number(line.taxExcludedPrice) }
        : clear ? { taxExcludedPrice: null } : {}),
      ...((line.note ?? '').trim() || clear ? { note: (line.note ?? '').trim() || null } : {}),
    })),
  };
}

/** 服务端的规则码落到哪一项下面；提示用服务端翻好的那句话。 */
export function orderFieldErrors(error: unknown): FieldErrors {
  if (!(error instanceof ApiClientError)) return {};
  const message = serverMessage(error);
  switch (error.reason) {
    case 'PARTNER_NOT_FOUND':
    case 'PARTNER_NOT_SUPPLIER':
    case 'PARTNER_NOT_CUSTOMER':
    case 'PARTNER_INACTIVE':
      return { partnerId: message };
    case 'WAREHOUSE_NOT_FOUND':
    case 'WAREHOUSE_INACTIVE':
      return { warehouseId: message };
    case 'ORDER_LINE_PRICE_INVALID':
    case 'ORDER_DISCOUNT_INVALID':
      return { lines: message };
    case 'ORDER_PERSON_INVALID':
      return { handlerUserId: message };
    case 'ORDER_DICT_CODE_INVALID':
      return { settlementCode: message, projectCode: message };
    case 'FILE_NOT_FOUND':
    case 'FILE_UNAVAILABLE':
    case 'FILE_TOO_MANY':
      return { fileIds: message };
    case 'ITEM_NOT_FOUND':
    case 'ITEM_INACTIVE':
    case 'ORDER_LINE_INVALID':
    case 'ORDER_LINE_DUPLICATED':
    case 'ORDER_LINES_ALREADY_ISSUED':
    case 'ORDER_QTY_EXCEEDS_REMAINING':
      // 端点不说错在哪一行，标在明细这一节下面。
      return { lines: message };
    default:
      return {};
  }
}

// ---------- 生成入库单 / 出库单 ----------

export interface ReceiptFormValues {
  readonly warehouseId: string;
  /** 明细 id → 本次数量的文字。 */
  readonly quantities: Readonly<Record<string, string>>;
}

/** 每一行的本次数量默认就是未到货（未发货）数量；已经生成完的行不列。 */
export function receiptFormOf(order: Order): ReceiptFormValues {
  return {
    warehouseId: '',
    quantities: Object.fromEntries(
      order.lines
        .filter((line) => line.remainingQty > 0)
        .map((line) => [line.id, String(line.remainingQty)]),
    ),
  };
}

export function validateReceipt(
  values: ReceiptFormValues,
  order: Order,
  doneWord: string,
  t: Translate,
): FieldErrors {
  const errors: Record<string, string | undefined> = {};
  if (!values.warehouseId)
    errors.warehouseId = t('orderDocs.errors.warehouseRequired');
  const remaining = new Map(
    order.lines.map((line) => [line.id, line.remainingQty] as const),
  );
  let any = false;
  for (const [lineId, text] of Object.entries(values.quantities)) {
    const qty = parseDecimal(text);
    if (qty === undefined)
      errors[`qty-${lineId}`] = t('orderDocs.errors.receiptInvalid');
    else {
      if (qty > (remaining.get(lineId) ?? 0))
        errors[`qty-${lineId}`] = t('orderDocs.errors.receiptExceeds', {
          done: doneWord,
        });
      if (qty > 0) any = true;
    }
  }
  if (!any) errors.receipt = t('orderDocs.errors.receiptRequired');
  return errors;
}

/** 留 0 的行不生成。 */
export function receiptInputOf(values: ReceiptFormValues): MakeDocumentInput {
  return {
    warehouseId: values.warehouseId,
    lines: Object.entries(values.quantities)
      .filter(([, text]) => (parseDecimal(text) ?? 0) > 0)
      .map(([lineId, text]) => ({ lineId, qty: Number(text) })),
  };
}

/**
 * `ORDER_QTY_EXCEEDS_REMAINING`：把服务端那句话标到超出的那一行的数量下面（设计第七节第 4 步）。
 * 端点不说错在哪一行：页面上先找填得比未到货数量大的那一行，找不到（是别人刚生成了）就标在第一行。
 */
export function receiptFieldErrors(
  error: unknown,
  values: ReceiptFormValues,
  order: Order,
): FieldErrors {
  if (!(error instanceof ApiClientError)) return {};
  const message = serverMessage(error);
  switch (error.reason) {
    case 'WAREHOUSE_NOT_FOUND':
    case 'WAREHOUSE_INACTIVE':
      return { warehouseId: message };
    case 'ORDER_QTY_EXCEEDS_REMAINING': {
      const over = order.lines.find((line) => {
        const typed = parseDecimal(values.quantities[line.id] ?? '');
        return typed !== undefined && typed > line.remainingQty;
      });
      const key = over?.id ?? order.lines[0]?.id;
      return key === undefined
        ? { receipt: message }
        : { [`qty-${key}`]: message };
    }
    case 'ORDER_LINES_ALREADY_ISSUED':
    case 'ORDER_NOT_ISSUABLE':
    case 'ORDER_LINE_INVALID':
      return { receipt: message };
    default:
      return {};
  }
}

/** 详情里明细的金额按这一行算。 */
export const amountOf = (line: OrderLine): number | undefined =>
  lineAmount(line);
