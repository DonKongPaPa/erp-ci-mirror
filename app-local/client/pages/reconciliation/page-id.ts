import { TABLE_URL_KEYS } from '#hooks/use-table-url-state';

/** R-065 第二片：四张财务页面的授权 id 与业务资源 id。存量授权记的是 id，改名属于数据迁移。 */
export const INCOME_RECORDS_PAGE_ID = 'incomeRecords' as const;
export const SALE_INVOICE_RECORDS_PAGE_ID = 'saleInvoiceRecords' as const;
export const RECEIVABLE_RECONS_PAGE_ID = 'receivableRecons' as const;
export const PAYABLE_RECONS_PAGE_ID = 'payableRecons' as const;

export const INCOME_RECORDS_RESOURCE = { type: 'composite', id: 'incomeRecords' } as const;
export const SALE_INVOICE_RECORDS_RESOURCE = {
  type: 'composite', id: 'saleInvoiceRecords',
} as const;
export const RECEIVABLE_RECONS_RESOURCE = {
  type: 'composite', id: 'receivableRecons',
} as const;
export const PAYABLE_RECONS_RESOURCE = { type: 'composite', id: 'payableRecons' } as const;

/** 列表查询条件留在地址栏，详情、编辑回来时不丢。 */
export const RECON_LIST_KEYS = [
  'q', 'status', 'partnerId', 'type', 'from', 'to',
  ...TABLE_URL_KEYS,
] as const;
