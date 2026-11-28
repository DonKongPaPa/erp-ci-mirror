import type { FieldErrors } from '#components/erp/form-dialog';

import { parseDecimal, today } from '../orders/model.js';
import type {
  CreateStocktakingInput,
  LineInput,
  Stocktaking,
  UpdateStocktakingInput,
} from './client.js';

/**
 * 盘点单表单的纯逻辑。系统数量是服务端加行时写的快照，表单只回显，不自己算；
 * 盈亏数量与结果也由服务端在结束盘点时算，这里只收原始输入。
 */

export interface LineDraft {
  readonly key: string;
  readonly itemId: string;
  readonly actualQty: string;
  readonly note: string;
}

export interface StocktakingFormValues {
  readonly warehouseId: string;
  readonly handlerUserId: string;
  readonly docDate: string;
  readonly remark: string;
  readonly fileIds: readonly string[];
  readonly lines: readonly LineDraft[];
}

export function emptyStocktakingForm(): StocktakingFormValues {
  return {
    warehouseId: '',
    handlerUserId: '',
    // 盘点日期由服务端填当天（Asia/Shanghai），表单里只做禁用回显。
    docDate: today(),
    remark: '',
    fileIds: [],
    lines: [],
  };
}

export function newStocktakingLine(): LineDraft {
  return {
    key: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    itemId: '',
    actualQty: '',
    note: '',
  };
}

export function stocktakingFormOf(record: Stocktaking): StocktakingFormValues {
  return {
    warehouseId: record.warehouse.id,
    handlerUserId: record.handler?.userId ?? '',
    docDate: record.docDate,
    remark: record.remark,
    fileIds: (record.files ?? []).map((file) => file.id),
    lines: (record.lines ?? []).map((line, index) => ({
      key: `line-${index}-${line.id}`,
      itemId: line.itemId,
      actualQty: line.actualQty === null ? '' : String(line.actualQty),
      note: line.note ?? '',
    })),
  };
}

export function validateStocktakingForm(
  values: StocktakingFormValues,
  t: (key: string) => string,
): FieldErrors {
  const errors: Record<string, string | undefined> = {};
  if (!values.warehouseId) errors.warehouseId = t('stocktaking.errors.warehouseRequired');
  if (values.lines.length === 0) errors.lines = t('stocktaking.errors.linesRequired');
  const uses = new Map<string, number>();
  for (const line of values.lines)
    uses.set(line.itemId, (uses.get(line.itemId) ?? 0) + 1);
  for (const line of values.lines) {
    if (!line.itemId)
      errors[`item-${line.key}`] = t('stocktaking.errors.itemRequired');
    else if ((uses.get(line.itemId) ?? 0) > 1)
      errors[`item-${line.key}`] = t('stocktaking.errors.itemDuplicated');
    if (line.actualQty.trim()) {
      const qty = parseDecimal(line.actualQty);
      if (qty === undefined || qty < 0)
        errors[`actual-${line.key}`] = t('stocktaking.errors.actualInvalid');
    }
  }
  return errors;
}

function optionalText(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

/** 发给端点的形状：建、改都是一份表头加整份明细；系统数量不送，由服务端快照。 */
export function stocktakingInputOf(
  values: StocktakingFormValues,
): CreateStocktakingInput | UpdateStocktakingInput {
  const header = {
    ...(optionalText(values.handlerUserId)
      ? { handlerUserId: values.handlerUserId }
      : {}),
    remark: values.remark.trim(),
    fileIds: [...values.fileIds],
  };
  const lines: LineInput[] = values.lines.map((line) => ({
    itemId: line.itemId,
    ...(line.actualQty.trim()
      ? { actualQty: Number(line.actualQty) }
      : { actualQty: null }),
    ...(optionalText(line.note) ? { note: line.note.trim() } : {}),
  }));
  return { ...header, lines };
}
