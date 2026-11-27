/** R-065 财务页面：页面授权 id 与业务资源 id。存量授权记的是 id，改名属于数据迁移。 */
export const EXPENSES_PAGE_ID = 'expenses' as const;
export const INVOICE_RECEIPTS_PAGE_ID = 'invoiceReceipts' as const;

export const EXPENSES_RESOURCE = { type: 'composite', id: 'expenses' } as const;
export const INVOICE_RECEIPTS_RESOURCE = {
  type: 'composite',
  id: 'invoiceReceipts',
} as const;
