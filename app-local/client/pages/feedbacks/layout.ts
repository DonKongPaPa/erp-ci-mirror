/**
 * 反馈单对话框的内容外壳。加载占位（权限判定中、详情读取中）与落定后的表单共用这一个类：
 * `min-h-dvh` 从首帧就把对话框撑到视口上限，落定后仍是同一个上限，顶边不动（R-026）。
 * 附件区与提示区本来就是定高的，所以每态的落定高度都是常数。
 */
export const FEEDBACK_FORM_SHELL_CLASS = 'flex min-h-dvh flex-col gap-4';
