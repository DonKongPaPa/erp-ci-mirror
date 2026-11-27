import { TABLE_URL_KEYS } from '#hooks/use-table-url-state';

/** 财务列表的查询条件记在地址栏里：从详情、编辑回来时不丢。 */
export const FINANCE_LIST_KEYS = [
  'q',
  'status',
  'supplierId',
  'type',
  'from',
  'to',
  ...TABLE_URL_KEYS,
] as const;
