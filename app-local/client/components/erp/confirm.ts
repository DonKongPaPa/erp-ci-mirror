/**
 * 不可逆的操作（停用、作废、取消订单、过账）都先弹这个确认框：标题写明是哪一条记录，
 * 说明写清楚之后会怎样，确认按钮用危险样式。它就是应用外壳那一个 `ConfirmAction`，
 * 从这里出去，模块的页面不必进 `pages/settings` 取。
 */
export { ConfirmAction as ConfirmDialog } from '../../pages/settings/shared.js';
