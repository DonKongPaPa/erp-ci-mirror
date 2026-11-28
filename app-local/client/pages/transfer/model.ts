import type { FieldErrors } from '#components/erp/form-dialog';

import { parseDate, parseDecimal } from '../orders/model.js';
import type {
  CreateTransferInput,
  LineInput,
  Transfer,
  UpdateTransferInput,
} from './client.js';

/**
 * 调拨单表单的纯逻辑。qty 是申请数、transferQty 是实调数：录申请数时实调默认相同，
 * 可以再改；过账用后者。校验只挡本地明显错误，业务规则由服务端裁决。
 */

export interface LineDraft {
  readonly key: string;
  readonly itemId: string;
  readonly qty: string;
  readonly transferQty: string;
  readonly note: string;
}

export interface TransferFormValues {
  readonly transferInWarehouseId: string;
  readonly transferOutWarehouseId: string;
  readonly docDate: string;
  readonly handlerUserId: string;
  readonly remark: string;
  readonly fileIds: readonly string[];
  readonly lines: readonly LineDraft[];
}

let lineSeed = 0;

export function newTransferLine(): LineDraft {
  lineSeed += 1;
  return {
    key: `line-${Date.now()}-${lineSeed}`,
    itemId: '',
    qty: '',
    transferQty: '',
    note: '',
  };
}

/** 新建默认三行，照旧系统调拨单新建页。 */
export function emptyTransferForm(todayText: string): TransferFormValues {
  return {
    transferInWarehouseId: '',
    transferOutWarehouseId: '',
    docDate: todayText,
    handlerUserId: '',
    remark: '',
    fileIds: [],
    lines: [newTransferLine(), newTransferLine(), newTransferLine()],
  };
}

export function transferFormOf(record: Transfer): TransferFormValues {
  return {
    transferInWarehouseId: record.warehouseIn.id,
    transferOutWarehouseId: record.warehouseOut?.id ?? '',
    docDate: record.docDate ?? '',
    handlerUserId: record.handler?.userId ?? '',
    remark: record.remark,
    fileIds: (record.files ?? []).map((file) => file.id),
    lines: (record.lines ?? []).map((line, index) => ({
      key: `line-${index}-${line.id}`,
      itemId: line.itemId,
      qty: String(line.qty),
      transferQty: line.transferQty === null ? '' : String(line.transferQty),
      note: line.note ?? '',
    })),
  };
}

export function validateTransferForm(
  values: TransferFormValues,
  t: (key: string) => string,
): FieldErrors {
  const errors: Record<string, string | undefined> = {};
  if (!values.transferInWarehouseId)
    errors.transferInWarehouseId = t('transfer.errors.inRequired');
  if (
    values.transferOutWarehouseId &&
    values.transferOutWarehouseId === values.transferInWarehouseId
  )
    errors.transferOutWarehouseId = t('transfer.errors.sameWarehouse');
  if (values.docDate.trim() && !parseDate(values.docDate))
    errors.docDate = t('transfer.errors.dateInvalid');
  const filled = values.lines.filter((line) => !isBlank(line));
  if (filled.length === 0) errors.lines = t('transfer.errors.linesRequired');
  for (const line of filled) {
    if (!line.itemId)
      errors[`item-${line.key}`] = t('transfer.errors.itemRequired');
    const qty = parseDecimal(line.qty);
    if (qty === undefined || qty <= 0)
      errors[`qty-${line.key}`] = t('transfer.errors.qtyInvalid');
    const actual = parseDecimal(line.transferQty);
    if (actual === undefined || actual <= 0)
      errors[`transferQty-${line.key}`] = t('transfer.errors.transferQtyInvalid');
    else if (qty !== undefined && actual > qty)
      errors[`transferQty-${line.key}`] = t('transfer.errors.transferQtyExceeds');
  }
  return errors;
}

/** 新建默认的三行里没填的那几行不算明细，不校验也不发给端点。 */
function isBlank(line: LineDraft): boolean {
  return (
    !line.itemId &&
    !line.qty.trim() &&
    !line.transferQty.trim() &&
    !line.note.trim()
  );
}

function optionalText(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

/** 发给端点的形状：只送原始输入；实调没有单独填时按申请数送。 */
export function transferInputOf(
  values: TransferFormValues,
): CreateTransferInput | UpdateTransferInput {
  const header = {
    transferOutWarehouseId: optionalText(values.transferOutWarehouseId) ?? null,
    ...(optionalText(values.docDate) ? { docDate: values.docDate.trim() } : {}),
    ...(optionalText(values.handlerUserId)
      ? { handlerUserId: values.handlerUserId }
      : {}),
    remark: values.remark.trim(),
    fileIds: [...values.fileIds],
  };
  const lines: LineInput[] = values.lines.filter((line) => !isBlank(line)).map((line) => {
    const qty = Number(line.qty);
    const actual = line.transferQty.trim() ? Number(line.transferQty) : qty;
    return {
      itemId: line.itemId,
      qty,
      transferQty: actual,
      ...(optionalText(line.note) ? { note: line.note.trim() } : {}),
    };
  });
  return { ...header, lines };
}
