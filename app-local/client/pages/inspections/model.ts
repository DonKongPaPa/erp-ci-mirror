import { ApiClientError } from '@nocobase/app-client';

import type { FieldErrors } from '#components/erp/form-dialog';
import { serverMessage, type Translate } from '#components/erp/messages';

import {
  parseDate,
  parseDecimal,
  today,
} from '../orders/model.js';
import type {
  CreateInspectionInput,
  InspectionLineInput,
  InspectionOrder,
  InspectionTypeCode,
} from './client.js';

/**
 * 检验单表单的纯逻辑。不合格、可入库、退货三个算列与采购数量只回显、不发请求；
 * 这里只收原始输入、校验必填与数量上限，不替服务端算数。
 */

export interface LineDraft {
  readonly key: string;
  readonly itemId: string;
  readonly itemLabel: string;
  readonly purchaseQty: string;
  readonly inspectionTypeCode: InspectionTypeCode;
  readonly receivedQty: string;
  readonly inspectionQty: string;
  readonly qualifiedQty: string;
  readonly samplingQty: string;
  readonly samplingQualifiedQty: string;
  readonly lossQty: string;
  readonly retainedQty: string;
  readonly note: string;
}

export interface InspectionFormValues {
  readonly inspectionDate: string;
  readonly purchaseOrderId: string;
  readonly purchaseOrderLabel: string;
  readonly inspectorUserId: string;
  readonly remark: string;
  readonly fileIds: readonly string[];
  readonly lines: readonly LineDraft[];
}

export function emptyInspectionForm(): InspectionFormValues {
  return {
    inspectionDate: today(),
    purchaseOrderId: '',
    purchaseOrderLabel: '',
    inspectorUserId: '',
    remark: '',
    fileIds: [],
    lines: [],
  };
}

/** 从选来的采购订单行建草稿：收货默认填尚可收货数量，检验与合格跟着填满。 */
export function lineFromOrder(
  orderId: string,
  line: {
    readonly itemId: string;
    readonly item: { readonly code: string; readonly name: string };
    readonly purchaseQty: number;
    readonly receivedRemainQty: number;
  },
): LineDraft {
  const remain = String(line.receivedRemainQty);
  return {
    key: `${orderId}-${line.itemId}`,
    itemId: line.itemId,
    itemLabel: `${line.item.code} ${line.item.name}`,
    purchaseQty: String(line.purchaseQty),
    inspectionTypeCode: 'full',
    receivedQty: remain,
    inspectionQty: remain,
    qualifiedQty: remain,
    samplingQty: '0',
    samplingQualifiedQty: '0',
    lossQty: '0',
    retainedQty: '0',
    note: '',
  };
}

export function inspectionFormOf(
  inspection: InspectionOrder,
): InspectionFormValues {
  return {
    inspectionDate: inspection.inspectionDate,
    purchaseOrderId: inspection.purchaseOrder.id,
    purchaseOrderLabel: inspection.purchaseOrder.orderNo,
    inspectorUserId: inspection.inspector?.userId ?? '',
    remark: inspection.remark,
    fileIds: inspection.files.map((file) => file.id),
    lines: inspection.lines.map((line, index) => ({
      key: `line-${index}-${line.id}`,
      itemId: line.itemId,
      itemLabel: `${line.item.code} ${line.item.name}`,
      purchaseQty: String(line.purchaseQty),
      inspectionTypeCode: line.inspectionTypeCode,
      receivedQty: String(line.receivedQty),
      inspectionQty: String(line.inspectionQty),
      qualifiedQty: String(line.qualifiedQty),
      samplingQty: String(line.samplingQty),
      samplingQualifiedQty: String(line.samplingQualifiedQty),
      lossQty: String(line.lossQty),
      retainedQty: String(line.retainedQty),
      note: line.note ?? '',
    })),
  };
}

/** 只用于回显：公式与服务端 derivedQuantities 相同，页面不把它写回请求。 */
export function derivedOf(line: LineDraft): {
  readonly unqualified: number;
  readonly releasable: number;
  readonly return: number;
} {
  const number = (value: string): number => parseDecimal(value) ?? 0;
  return {
    unqualified: number(line.inspectionQty) - number(line.qualifiedQty),
    releasable: number(line.qualifiedQty),
    return: number(line.receivedQty) - number(line.qualifiedQty),
  };
}

export function validateInspectionForm(
  values: InspectionFormValues,
  t: Translate,
): FieldErrors {
  const errors: Record<string, string | undefined> = {};
  if (!values.purchaseOrderId)
    errors.purchaseOrderId = t('inspections.errors.orderRequired');
  if (!values.inspectionDate.trim())
    errors.inspectionDate = t('inspections.errors.dateRequired');
  else if (!parseDate(values.inspectionDate))
    errors.inspectionDate = t('inspections.errors.dateInvalid');
  if (values.lines.length === 0)
    errors.lines = t('inspections.errors.linesRequired');

  const used = new Set<string>();
  for (const line of values.lines) {
    const at = (suffix: string) => `${suffix}-${line.key}`;
    if (!line.itemId) errors[at('itemId')] = t('inspections.errors.itemRequired');
    if (used.has(line.itemId))
      errors[at('itemId')] = t('inspections.errors.itemDuplicated');
    used.add(line.itemId);

    const amounts: Record<string, number> = {};
    for (const key of [
      'receivedQty', 'inspectionQty', 'qualifiedQty',
      'samplingQty', 'samplingQualifiedQty', 'lossQty', 'retainedQty',
    ] as const) {
      const value = parseDecimal(line[key] ?? '');
      if (value === undefined || value < 0) {
        errors[at(key)] = t('inspections.errors.qtyInvalid');
        continue;
      }
      amounts[key] = value;
    }
    if (!(amounts.receivedQty > 0) || !(amounts.inspectionQty > 0))
      errors[at('receivedQty')] = t('inspections.errors.qtyPositive');
    if (amounts.inspectionQty > amounts.receivedQty)
      errors[at('inspectionQty')] = t('inspections.errors.inspectionExceed');
    if (amounts.qualifiedQty > amounts.inspectionQty)
      errors[at('qualifiedQty')] = t('inspections.errors.qualifiedExceed');
    if (amounts.samplingQty > amounts.inspectionQty)
      errors[at('samplingQty')] = t('inspections.errors.samplingExceed');
    if (amounts.samplingQualifiedQty > amounts.samplingQty)
      errors[at('samplingQualifiedQty')] = t('inspections.errors.samplingQualifiedExceed');
    if (line.inspectionTypeCode === 'sampling' && !(amounts.samplingQty > 0))
      errors[at('samplingQty')] = t('inspections.errors.samplingRequired');
    if ([...(line.note ?? '')].length > 500)
      errors[at('note')] = t('inspections.errors.noteTooLong');
  }
  return errors;
}

function optionalNumber(value: string): number | undefined {
  const trimmed = (value ?? '').trim();
  return trimmed === '' ? undefined : Number(trimmed);
}

/** 发给端点的明细只含原始输入；四个算列与采购数量一律不带。 */
export function lineInputsOf(
  values: InspectionFormValues,
): readonly InspectionLineInput[] {
  return values.lines.map((line) => ({
    itemId: line.itemId,
    inspectionTypeCode: line.inspectionTypeCode,
    receivedQty: Number(line.receivedQty),
    inspectionQty: Number(line.inspectionQty),
    qualifiedQty: Number(line.qualifiedQty),
    samplingQty: Number(line.samplingQty),
    samplingQualifiedQty: Number(line.samplingQualifiedQty),
    ...(optionalNumber(line.lossQty) === undefined
      ? {}
      : { lossQty: optionalNumber(line.lossQty)! }),
    ...(optionalNumber(line.retainedQty) === undefined
      ? {}
      : { retainedQty: optionalNumber(line.retainedQty)! }),
    ...((line.note ?? '').trim() ? { note: line.note.trim() } : {}),
  }));
}

/** 发给端点的表头：空串不发明键，详情回显的采购单号只用于展示。 */
export function createInputOf(
  values: InspectionFormValues,
): CreateInspectionInput {
  return {
    inspectionDate: values.inspectionDate.trim(),
    purchaseOrderId: values.purchaseOrderId.trim(),
    ...(values.inspectorUserId.trim()
      ? { inspectorUserId: values.inspectorUserId.trim() }
      : {}),
    ...(values.remark.trim() ? { remark: values.remark.trim() } : {}),
    fileIds: [...values.fileIds],
    lines: lineInputsOf(values),
  };
}

/** 服务端的规则码落到哪一项下面；提示用服务端翻好的那句话。 */
export function inspectionFieldErrors(error: unknown): FieldErrors {
  if (!(error instanceof ApiClientError)) return {};
  const message = serverMessage(error);
  switch (error.reason) {
    case 'IQC_ORDER_INVALID':
      return { purchaseOrderId: message };
    case 'IQC_PERSON_INVALID':
      return { inspectorUserId: message };
    case 'IQC_DUPLICATE_ITEM':
    case 'IQC_QTY_INVALID':
    case 'IQC_RECEIVED_EXCEED':
    case 'ITEM_NOT_FOUND':
    case 'ITEM_INACTIVE':
      return { lines: message };
    case 'FILE_NOT_FOUND':
    case 'FILE_UNAVAILABLE':
    case 'FILE_TOO_MANY':
      return { fileIds: message };
    default:
      return {};
  }
}
