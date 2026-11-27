/**
 * 工单详情对话框的内容外壳：加载占位与落定后的内容共用同一个类，
 * 首帧就用这个最小高度把对话框撑住，数据到了不把顶边推下去（与反馈单表单
 * 的 `FEEDBACK_FORM_SHELL_CLASS` 同一套做法）。
 */
export const TICKET_DETAIL_SHELL_CLASS = 'flex min-h-96 flex-col gap-4';
