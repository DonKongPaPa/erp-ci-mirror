import { ApiClientError } from '@nocobase/app-client';

import type { FieldErrors } from '#components/erp/form-dialog';
import { type Translate } from '#components/erp/messages';
import { TABLE_URL_KEYS } from '#hooks/use-table-url-state';

import { parseDate, parseDecimal } from '../orders/model.js';
import type { DocReason, StockDoc, StockLineInput } from './client.js';

/** 列表记在地址栏里的键：从单据回到列表时原样带着（搜索、状态、创建时间、分页）。 */
export const STOCK_DOC_LIST_KEYS = [
  'q',
  'status',
  'from',
  'to',
  'reason',
  'partnerId',
  'projectCode',
  'dateField',
  ...TABLE_URL_KEYS,
] as const;

/** 明细一行的表单值：数量与单价是文本，提交前换成数。 */
export interface LineFormValues {
  /** 这一行的键：已保存的行用明细 id，新加的行现编一个。 */
  readonly key: string;
  readonly itemId: string;
  readonly warehouseId: string;
  readonly batchNo: string;
  readonly qty: string;
  readonly taxIncludedPrice: string;
  readonly taxExcludedPrice: string;
  readonly taxRate: string;
  readonly productionDate: string;
  readonly expiryDate: string;
  readonly note: string;
}

export interface DocFormValues {
  readonly reason: DocReason;
  readonly remark: string;
  readonly lines: readonly LineFormValues[];
  // R-020 加片：金额由服务端算，表单只录原始输入。
  readonly docDate: string;
  readonly partnerId: string;
  readonly contactName: string;
  readonly contactPhone: string;
  readonly deliveryAddress: string;
  readonly customerOrderNo: string;
  readonly projectCode: string;
  readonly handlerUserId: string;
  readonly takerDepartmentId: string;
  readonly takerUserId: string;
  readonly discountAmount: string;
  readonly fileIds: readonly string[];
  /** 带来源的单：从订单选择时带入，与明细一起保存；端点据此校验行与数量。 */
  readonly sourceType: 'purchase_order' | 'sales_order' | null;
  readonly sourceId: string | null;
  /** 端点回过加片的键才在编辑时送 null 清空；老单据不夹带新键。 */
  readonly hasAddons: boolean;
}

let sequence = 0;

export const emptyLine = (): LineFormValues => ({
  key: `new-${(sequence += 1)}`,
  itemId: '',
  warehouseId: '',
  batchNo: '',
  qty: '',
  taxIncludedPrice: '',
  taxExcludedPrice: '',
  taxRate: '',
  productionDate: '',
  expiryDate: '',
  note: '',
});

const blank = {
  docDate: '',
  partnerId: '',
  contactName: '',
  contactPhone: '',
  deliveryAddress: '',
  customerOrderNo: '',
  projectCode: '',
  handlerUserId: '',
  takerDepartmentId: '',
  takerUserId: '',
  discountAmount: '',
  fileIds: [],
  sourceType: null,
  sourceId: null,
  hasAddons: false,
} as const;

/** 手工新建：一行空明细，类型默认是不带来源的那一种。 */
export const emptyForm = (reason: DocReason): DocFormValues => ({
  reason,
  remark: '',
  lines: [emptyLine()],
  ...blank,
});

/** 编辑：原样带出这一张。 */
export const formOf = (doc: StockDoc): DocFormValues => ({
  reason: doc.reason,
  remark: doc.remark,
  lines: doc.lines.map((line) => ({
    key: line.id,
    itemId: line.itemId,
    warehouseId: line.warehouseId,
    batchNo: line.batchNo,
    qty: String(line.qty),
    taxIncludedPrice:
      line.taxIncludedPrice === null || line.taxIncludedPrice === undefined
        ? ''
        : String(line.taxIncludedPrice),
    taxExcludedPrice:
      line.taxExcludedPrice === null || line.taxExcludedPrice === undefined
        ? ''
        : String(line.taxExcludedPrice),
    taxRate: line.taxRate === null || line.taxRate === undefined ? '' : String(line.taxRate),
    productionDate: line.productionDate ?? '',
    expiryDate: line.expiryDate ?? '',
    note: line.note ?? '',
  })),
  docDate: doc.docDate ?? '',
  partnerId: doc.partnerId ?? '',
  contactName: doc.contactName ?? '',
  contactPhone: doc.contactPhone ?? '',
  deliveryAddress: doc.deliveryAddress ?? '',
  customerOrderNo: doc.customerOrderNo ?? '',
  projectCode: doc.projectCode ?? '',
  handlerUserId: doc.handlerUserId ?? '',
  takerDepartmentId: doc.takerDepartmentId ?? '',
  takerUserId: doc.takerUserId ?? '',
  discountAmount:
    doc.discountAmount === null || doc.discountAmount === undefined
      ? ''
      : String(doc.discountAmount),
  fileIds: (doc.files ?? []).map((file) => file.id),
  sourceType: doc.sourceType ?? null,
  sourceId: doc.sourceId ?? null,
  hasAddons:
    doc.docDate !== undefined ||
    doc.partnerId !== undefined ||
    doc.projectCode !== undefined ||
    doc.discountAmount !== undefined ||
    doc.lines.some(
      (line) => line.taxIncludedPrice !== undefined || line.taxRate !== undefined,
    ) ||
    (doc.files?.length ?? 0) > 0,
});

/** 数量的写法：大于 0，小数最多四位；写得不合规返回 `undefined`。 */
export function parseQty(text: string): number | undefined {
  const value = text.trim();
  if (!/^\d+(\.\d{1,4})?$/u.test(value)) return undefined;
  const number = Number(value);
  return number > 0 ? number : undefined;
}

/** 空串在新建时不带这个键，端点回过加片的编辑送 null 以便清空。 */
function text(value: string | undefined, clear: boolean): string | null | undefined {
  const trimmed = (value ?? '').trim();
  if (trimmed) return trimmed;
  return clear ? null : undefined;
}

/** 建单与改草稿共用的那几项：类型、备注、来源、整份明细。 */
export interface DocInput {
  readonly reason: DocReason;
  readonly remark: string;
  readonly sourceType?: 'purchase_order' | 'sales_order' | null;
  readonly sourceId?: string | null;
  readonly docDate?: string | null;
  readonly partnerId?: string | null;
  readonly contactName?: string | null;
  readonly contactPhone?: string | null;
  readonly deliveryAddress?: string | null;
  readonly customerOrderNo?: string | null;
  readonly projectCode?: string | null;
  readonly handlerUserId?: string | null;
  readonly takerDepartmentId?: string | null;
  readonly takerUserId?: string | null;
  readonly discountAmount?: number | null;
  readonly fileIds?: readonly string[];
  readonly lines: readonly StockLineInput[];
}

/**
 * 当前选得到的人员/部门标识。编辑老单据时详情页会带出建单时写进去的标识；
 * 建单端点在没传经办人时直接写当前登录人，并没有校验他是不是在职员工，
 * 把这种标识原样回送给改草稿端点会撞 `STOCK_PERSON_INVALID`，改数量也存不了。
 * 不在下拉里的标识一律不回送：用户没改这一项，服务端原有的值保持不变；
 * 真要换人只能从选项里选，选出来的必然在集合里。
 */
export interface SelectableRefs {
  readonly people: ReadonlySet<string>;
  readonly departments: ReadonlySet<string>;
}

/** 表单的值 → 请求体里改得了的那几项。调用前一定先过 `validateDocForm`。 */
export function inputOf(values: DocFormValues, selectable?: SelectableRefs): DocInput {
  const clear = values.hasAddons;
  const kept = (
    value: string,
    choices: ReadonlySet<string> | undefined,
  ): string | null | undefined => {
    // 主动清空照旧发 null；只有「表单里有一个当前选不到的非空标识」才不回送。
    if (value.trim() === '') return text(value, clear);
    return choices === undefined || choices.has(value.trim()) ? value.trim() : undefined;
  };
  const person = (value: string): string | null | undefined =>
    kept(value, selectable?.people);
  const department = (value: string): string | null | undefined =>
    kept(value, selectable?.departments);
  return {
    reason: values.reason,
    remark: values.remark.trim(),
    sourceType: values.sourceType,
    sourceId: values.sourceId,
    docDate: text(values.docDate, clear),
    partnerId: text(values.partnerId, clear),
    contactName: text(values.contactName, clear),
    contactPhone: text(values.contactPhone, clear),
    deliveryAddress: text(values.deliveryAddress, clear),
    customerOrderNo: text(values.customerOrderNo, clear),
    projectCode: text(values.projectCode, clear),
    handlerUserId: person(values.handlerUserId),
    takerDepartmentId: department(values.takerDepartmentId),
    takerUserId: person(values.takerUserId),
    ...((values.discountAmount ?? '').trim()
      ? { discountAmount: Number(values.discountAmount) }
      : {}),
    ...(clear || (values.fileIds?.length ?? 0) > 0
      ? { fileIds: values.fileIds ?? [] }
      : {}),
    lines: values.lines.map(
      (line): StockLineInput => ({
        itemId: line.itemId,
        warehouseId: line.warehouseId,
        batchNo: line.batchNo.trim(),
        qty: parseQty(line.qty) ?? 0,
        ...((line.taxIncludedPrice ?? '').trim()
          ? { taxIncludedPrice: Number(line.taxIncludedPrice) }
          : clear ? { taxIncludedPrice: null } : {}),
        ...((line.taxExcludedPrice ?? '').trim()
          ? { taxExcludedPrice: Number(line.taxExcludedPrice) }
          : clear ? { taxExcludedPrice: null } : {}),
        ...((line.taxRate ?? '').trim()
          ? { taxRate: Number(line.taxRate) }
          : clear ? { taxRate: null } : {}),
        ...((line.productionDate ?? '').trim()
          ? { productionDate: line.productionDate.trim() }
          : clear ? { productionDate: null } : {}),
        ...((line.expiryDate ?? '').trim()
          ? { expiryDate: line.expiryDate.trim() }
          : clear ? { expiryDate: null } : {}),
        ...((line.note ?? '').trim() || clear
          ? { note: (line.note ?? '').trim() || null }
          : {}),
      }),
    ),
  };
}

const MAX = {
  remark: 1000,
  batchNo: 64,
  note: 500,
} as const;

/**
 * 提交时才校验：至少一行明细；每行物料、仓库、数量必填，数量大于 0 且小数最多四位，
 * 批号最多 64 个字符，备注最多 1000 个字符。内部领用建草稿就要有领用部门与领用人。
 * 金额由服务端算，页面只核输入的范围。
 */
export function validateDocForm(values: DocFormValues, t: Translate): FieldErrors {
  const errors: Record<string, string | undefined> = {};
  const required = t('erp.form.required');
  if ([...values.remark.trim()].length > MAX.remark)
    errors.remark = t('stockDocs.errors.remarkTooLong');
  if (values.lines.length === 0) errors.lines = t('stockDocs.errors.requiredLine');
  if (values.reason === 'internal_use') {
    if (!values.takerDepartmentId)
      errors.takerDepartmentId = required;
    if (!values.takerUserId) errors.takerUserId = required;
  }
  if ((values.discountAmount ?? '').trim() && parseDecimal(values.discountAmount) === undefined)
    errors.discountAmount = t('orderDocs.errors.priceInvalid');
  values.lines.forEach((line, index) => {
    const prefix = `line.${index}.`;
    if (!line.itemId) errors[`${prefix}itemId`] = required;
    if (!line.warehouseId) errors[`${prefix}warehouseId`] = required;
    if (!line.qty.trim()) errors[`${prefix}qty`] = required;
    else if (parseQty(line.qty) === undefined)
      errors[`${prefix}qty`] = t('stockDocs.errors.invalidQty');
    if ([...line.batchNo.trim()].length > MAX.batchNo)
      errors[`${prefix}batchNo`] = t('stockDocs.errors.batchTooLong');
    if ((line.taxRate ?? '').trim()) {
      const rate = parseDecimal(line.taxRate);
      if (rate === undefined || rate < 0 || rate > 100)
        errors[`${prefix}taxRate`] = t('orderDocs.errors.taxRateInvalid');
    }
    for (const price of ['taxIncludedPrice', 'taxExcludedPrice'] as const) {
      if ((line[price] ?? '').trim() && parseDecimal(line[price]) === undefined)
        errors[`${prefix}${price}`] = t('orderDocs.errors.priceInvalid');
    }
    if ((line.productionDate ?? '').trim() && !parseDate(line.productionDate))
      errors[`${prefix}productionDate`] = t('stockDocs.errors.invalidDate');
    if ((line.expiryDate ?? '').trim() && !parseDate(line.expiryDate))
      errors[`${prefix}expiryDate`] = t('stockDocs.errors.invalidDate');
    if (
      line.productionDate && line.expiryDate &&
      line.expiryDate < line.productionDate
    )
      errors[`${prefix}expiryDate`] = t('stockDocs.errors.expiryBeforeProduction');
    if ([...(line.note ?? '').trim()].length > MAX.note)
      errors[`${prefix}note`] = t('orderDocs.errors.noteTooLong');
  });
  return errors;
}

/** 这张单是不是已经不是草稿（别处刚过账或作废）：这时把这一页重新读一遍。 */
export const isNotDraft = (error: unknown): boolean =>
  error instanceof ApiClientError && error.reason === 'STOCK_DOC_NOT_DRAFT';

/** 销售出库过账必须带来源销售订单（R1）。 */
export const needsSource = (doc: StockDoc): boolean =>
  doc.reason === 'sales_issue' &&
  !(doc.sourceType === 'sales_order' && Boolean(doc.sourceId));
