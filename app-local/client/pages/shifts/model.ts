import { ApiClientError } from '@nocobase/app-client';

import type { FieldErrors } from '#components/erp/form-dialog';
import { serverMessage, type Translate } from '#components/erp/messages';
import {
  formatMinute,
  formatRange,
  isCrossMidnight,
  parseInteger,
  parseTime,
} from '#components/erp/time';

import type { Shift, ShiftInput } from './client.js';

/**
 * 班次表单的值：时间按时分填（「08:30」），提交前换成零点起的分钟数；排序是整数的字符串。
 */
export interface ShiftFormValues {
  readonly id: string;
  readonly title: string;
  readonly start: string;
  readonly end: string;
  readonly breakStart: string;
  readonly breakEnd: string;
  readonly sortOrder: string;
}

/** 编码的写法（R-025）：1–32 位大写字母、数字、连字符、下划线，以字母或数字开头。 */
export const SHIFT_CODE = /^[A-Z0-9][A-Z0-9_-]{0,31}$/u;

export const EMPTY_SHIFT_FORM: ShiftFormValues = {
  id: '',
  title: '',
  start: '',
  end: '',
  breakStart: '',
  breakEnd: '',
  sortOrder: '0',
};

const minuteText = (minute: number | null): string =>
  minute === null ? '' : formatMinute(minute);

function formOf(shift: Shift, id = shift.id): ShiftFormValues {
  return {
    id,
    title: shift.title,
    start: minuteText(shift.startMinute),
    end: minuteText(shift.endMinute),
    breakStart: minuteText(shift.breakStartMinute),
    breakEnd: minuteText(shift.breakEndMinute),
    sortOrder: String(shift.sortOrder),
  };
}

/** 编辑：原样带出这一条。 */
export const editFormOf = (shift: Shift): ShiftFormValues => formOf(shift);

/** 复制新建：除了编码，其余都照旧的预填。 */
export const copyFormOf = (shift: Shift): ShiftFormValues =>
  formOf(shift, `${shift.id}-2`);

/** 时间段「08:00 – 17:00」。 */
export const timeRange = (shift: Shift): string =>
  formatRange(shift.startMinute, shift.endMinute);

/** 休息段「12:00 – 13:00」；没有休息段返回 `null`。 */
export const breakRange = (shift: Shift): string | null =>
  shift.breakStartMinute === null || shift.breakEndMinute === null
    ? null
    : formatRange(shift.breakStartMinute, shift.breakEndMinute);

export const isOvernight = (shift: Shift): boolean =>
  isCrossMidnight(shift.startMinute, shift.endMinute);

/** 表单的值 → 请求体。调用前一定先过 `validateShiftForm`。 */
export function inputOf(values: ShiftFormValues): ShiftInput {
  const breakStart = parseTime(values.breakStart);
  const breakEnd = parseTime(values.breakEnd);
  return {
    id: values.id.trim(),
    title: values.title.trim(),
    startMinute: parseTime(values.start) ?? 0,
    endMinute: parseTime(values.end) ?? 0,
    ...(breakStart === undefined || breakEnd === undefined
      ? {}
      : { breakStartMinute: breakStart, breakEndMinute: breakEnd }),
    sortOrder: parseInteger(values.sortOrder) ?? 0,
  };
}

/**
 * 提交时才校验，规则与 R-025 的三条一致：编码的写法、名称 1–64 个字符、起止合法且不相同、
 * 休息段同有同无且落在班次之内、排序是整数。错误标在对应的那一项下面。
 */
export function validateShiftForm(
  values: ShiftFormValues,
  t: Translate,
  withCode: boolean,
): FieldErrors {
  const errors: Record<string, string | undefined> = {};
  const required = t('erp.form.required');
  if (withCode) {
    const code = values.id.trim();
    if (!code) errors.id = required;
    else if (!SHIFT_CODE.test(code)) errors.id = t('shifts.errors.invalidCode');
  }
  const title = values.title.trim();
  if (!title) errors.title = required;
  else if ([...title].length > 64)
    errors.title = t('shifts.errors.invalidTitle');

  const invalidTime = t('shifts.errors.invalidTime');
  const start = parseTime(values.start);
  const end = parseTime(values.end);
  if (!values.start.trim()) errors.start = required;
  else if (start === undefined) errors.start = invalidTime;
  if (!values.end.trim()) errors.end = required;
  else if (end === undefined) errors.end = invalidTime;

  const breakStartText = values.breakStart.trim();
  const breakEndText = values.breakEnd.trim();
  const breakStart = parseTime(breakStartText);
  const breakEnd = parseTime(breakEndText);
  const both = (message: string): void => {
    errors.breakStart = message;
    errors.breakEnd = message;
  };
  if (Boolean(breakStartText) !== Boolean(breakEndText)) {
    // 休息段同有同无。
    both(t('shifts.errors.invalidBreak'));
  } else if (breakStartText && breakEndText) {
    if (breakStart === undefined || breakEnd === undefined) both(invalidTime);
    else if (breakStart >= breakEnd) both(t('shifts.errors.invalidBreakOrder'));
    else if (
      start !== undefined &&
      end !== undefined &&
      !breakInside(start, end, breakStart, breakEnd)
    ) {
      errors.breakStart = t('shifts.errors.breakOutOfRange');
    }
  }

  if (start !== undefined && end !== undefined && start === end)
    errors.end = t('shifts.errors.emptyRange');

  if (values.sortOrder.trim() && parseInteger(values.sortOrder) === undefined)
    errors.sortOrder = t('shifts.errors.invalidInteger');
  return errors;
}

/** 休息段必须在班次之内，且自己不跨天（R-025 规则 2）。 */
function breakInside(
  start: number,
  end: number,
  breakStart: number,
  breakEnd: number,
): boolean {
  if (!isCrossMidnight(start, end))
    return start <= breakStart && breakEnd <= end;
  return breakStart >= start || breakEnd <= end;
}

/** 服务端的规则码落到哪一项下面：编码重复就把光标放到编码上。提示用服务端翻好的那句话。 */
export function shiftFieldErrors(error: unknown): FieldErrors {
  if (!(error instanceof ApiClientError)) return {};
  const message = serverMessage(error);
  switch (error.reason) {
    case 'SHIFT_CODE_EXISTS':
      return { id: message };
    case 'SHIFT_EMPTY_RANGE':
      return { end: message };
    case 'SHIFT_BREAK_OUT_OF_RANGE':
      return { breakStart: message };
    default:
      return {};
  }
}
