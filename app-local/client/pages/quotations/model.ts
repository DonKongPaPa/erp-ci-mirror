import { ApiClientError } from '@nocobase/app-client';

import type { FieldErrors } from '#components/erp/form-dialog';
import { serverMessage, type Translate } from '#components/erp/messages';

import type { LineDraft } from '../orders/model.js';
import type { CreateQuotationInput, Quotation } from './client.js';

/**
 * 报价单页面的纯逻辑：表单值、提交时才跑的校验、发给端点的形状、规则码落到哪一项。
 * 日期、十进制与金额的写法复用订单那一套；金额与六个合计一律不算，交给服务端。
 */
export {
  today,
  parseDate,
  parseDecimal,
  formatNumber,
  formatAmount,
  formatDateTime,
} from '../orders/model.js';

import { parseDate, parseDecimal, today } from '../orders/model.js';

export interface QuotationFormValues {
  readonly customerId: string;
  readonly quoteDate: string;
  readonly validUntil: string;
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
  readonly lines: readonly LineDraft[];
  /** 端点回过加片的键才在编辑时送 null 清空；老单据不夹带新键。 */
  readonly hasAddons: boolean;
}

export const emptyQuotationForm = (handlerId = ''): QuotationFormValues => ({
  customerId: '',
  quoteDate: today(),
  validUntil: '',
  warehouseId: '',
  contactName: '',
  contactPhone: '',
  deliveryAddress: '',
  settlementCode: '',
  projectCode: '',
  customerOrderNo: '',
  handlerUserId: handlerId,
  discountAmount: '',
  fileIds: [],
  lines: [],
  hasAddons: false,
});

/** 响应里只有客户、仓库、经办人的摘要，没有裸 id 列；表单的 id 从摘要里取。 */
export const quotationFormOf = (quotation: Quotation): QuotationFormValues => ({
  customerId: quotation.customer?.id ?? '',
  quoteDate: quotation.quoteDate,
  validUntil: quotation.validUntil ?? '',
  warehouseId: quotation.warehouse?.id ?? '',
  contactName: quotation.contactName ?? '',
  contactPhone: quotation.contactPhone ?? '',
  deliveryAddress: quotation.deliveryAddress ?? '',
  settlementCode: quotation.settlementCode ?? '',
  projectCode: quotation.projectCode ?? '',
  customerOrderNo: quotation.customerOrderNo ?? '',
  handlerUserId: quotation.handler?.userId ?? '',
  discountAmount: String(quotation.discountAmount ?? 0),
  fileIds: (quotation.files ?? []).map((file) => file.id),
  lines: quotation.lines.map((line) => ({
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
  hasAddons:
    quotation.validUntil !== undefined ||
    quotation.warehouse !== undefined ||
    quotation.contactName !== undefined ||
    quotation.settlementCode !== undefined ||
    quotation.projectCode !== undefined ||
    quotation.lines.some((line) => line.taxRate !== undefined),
});

/** 提交时才跑：键的顺序就是光标落下去的顺序。客户可以不填，报价日期默认今天。 */
export function validateQuotationForm(
  values: QuotationFormValues,
  t: Translate,
): FieldErrors {
  const errors: Record<string, string | undefined> = {};
  if (!values.quoteDate.trim()) errors.quoteDate = t('quotations.errors.dateRequired');
  else if (!parseDate(values.quoteDate)) errors.quoteDate = t('quotations.errors.dateInvalid');
  if ((values.validUntil ?? '').trim()) {
    if (!parseDate(values.validUntil ?? ''))
      errors.validUntil = t('quotations.errors.dateInvalid');
    else if ((values.validUntil ?? '').trim() < values.quoteDate.trim())
      errors.validUntil = t('quotations.errors.validityInvalid');
  }
  if (values.lines.length === 0) errors.lines = t('quotations.errors.linesRequired');
  const uses = new Map<string, number>();
  for (const line of values.lines)
    uses.set(line.itemId, (uses.get(line.itemId) ?? 0) + 1);
  for (const line of values.lines) {
    if (!line.itemId)
      errors[`item-${line.key}`] = t('quotations.errors.itemRequired');
    else if ((uses.get(line.itemId) ?? 0) > 1)
      errors[`item-${line.key}`] = t('quotations.errors.itemDuplicated');
    if (!line.qty.trim()) errors[`qty-${line.key}`] = t('quotations.errors.qtyRequired');
    else {
      const qty = parseDecimal(line.qty);
      if (qty === undefined || qty <= 0)
        errors[`qty-${line.key}`] = t('quotations.errors.qtyInvalid');
    }
    if (line.price.trim() && parseDecimal(line.price) === undefined)
      errors[`price-${line.key}`] = t('quotations.errors.priceInvalid');
    if ((line.deliveryDate ?? '').trim() && !parseDate(line.deliveryDate ?? ''))
      errors[`deliveryDate-${line.key}`] = t('quotations.errors.dateInvalid');
    if ((line.taxRate ?? '').trim()) {
      const rate = parseDecimal(line.taxRate ?? '');
      if (rate === undefined || rate > 100)
        errors[`taxRate-${line.key}`] = t('quotations.errors.taxRateInvalid');
    }
    if (
      (line.taxExcludedPrice ?? '').trim() &&
      parseDecimal(line.taxExcludedPrice ?? '') === undefined
    )
      errors[`taxExcludedPrice-${line.key}`] = t('quotations.errors.priceInvalid');
    if ([...(line.note ?? '').trim()].length > 500)
      errors[`note-${line.key}`] = t('quotations.errors.noteTooLong');
  }
  if ((values.discountAmount ?? '').trim()) {
    const discount = parseDecimal(values.discountAmount ?? '');
    if (discount === undefined || discount < 0)
      errors.discountAmount = t('quotations.errors.priceInvalid');
  }
  return errors;
}

/** 空串在新建时不带这个键（端点存成 null），端点回过加片的编辑送 null 以便清空。 */
function text(value: string, clear: boolean): string | null | undefined {
  const trimmed = (value ?? '').trim();
  if (trimmed) return trimmed;
  return clear ? null : undefined;
}

/**
 * 发给端点的形状。六个合计一个都不在这里算、也不塞进请求体：
 * 服务端按 R-021 加片的同一处算法算完再回，页面只回显。
 */
export function quotationInputOf(values: QuotationFormValues): CreateQuotationInput {
  const clear = values.hasAddons;
  return {
    quoteDate: values.quoteDate.trim(),
    validUntil: text(values.validUntil ?? '', clear),
    customerId: text(values.customerId ?? '', clear),
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
    fileIds: [...(values.fileIds ?? [])],
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
export function quotationFieldErrors(error: unknown): FieldErrors {
  if (!(error instanceof ApiClientError)) return {};
  const message = serverMessage(error);
  switch (error.reason) {
    case 'QUOTATION_CUSTOMER_INVALID':
      return { customerId: message };
    case 'QUOTATION_DICT_CODE_INVALID':
      return { settlementCode: message, projectCode: message };
    case 'QUOTATION_PERSON_INVALID':
      return { handlerUserId: message };
    case 'QUOTATION_VALIDITY_INVALID':
      return { validUntil: message };
    case 'QUOTATION_DISCOUNT_INVALID':
      return { discountAmount: message };
    case 'QUOTATION_LINE_INVALID':
    case 'QUOTATION_EMPTY':
      return { lines: message };
    default:
      return {};
  }
}
