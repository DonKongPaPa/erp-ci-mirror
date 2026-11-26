import { useMemo } from 'react';

/**
 * 列表的列定义只此一份，模块级常量：每次渲染新建列数组会让表格把每一列都当成新列重挂。
 * `labelKey` 由渲染处的 `t()` 翻译，这里不存翻译后的文本，免得语言切换要重建列。
 */
export interface FeedbackColumn {
  readonly key: string;
  readonly labelKey: string;
}

export const FEEDBACK_COLUMNS: readonly FeedbackColumn[] = Object.freeze([
  { key: 'customerName', labelKey: 'feedbacks.list.customer' },
  { key: 'productName', labelKey: 'feedbacks.list.product' },
  { key: 'batchNo', labelKey: 'feedbacks.list.batch' },
  { key: 'status', labelKey: 'feedbacks.list.status' },
  { key: 'createdAt', labelKey: 'feedbacks.list.createdAt' },
]);

/** 供页面与测试使用的稳定引用；包一层 hook 是为了让「列定义稳定」这件事可被验证。 */
export function useFeedbackColumns(): readonly FeedbackColumn[] {
  // 真正的 hook：用 useMemo 把引用钉在模块常量上，语言切换也不会新建列数组。
  return useMemo(() => FEEDBACK_COLUMNS, []);
}
