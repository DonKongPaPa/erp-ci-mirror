import {
  EXPENSES_PAGE_ID,
  EXPENSES_RESOURCE,
  INVOICE_RECEIPTS_PAGE_ID,
  INVOICE_RECEIPTS_RESOURCE,
} from './page-id.js';

/** 支出记录与到票记录同构；差别收在这里，页面只写一份。 */
export interface FinanceKind {
  readonly id: 'expense' | 'invoice';
  readonly api: string;
  readonly base: '/expenses' | '/invoice-receipts';
  readonly pageId: string;
  readonly resource: { readonly type: 'composite'; readonly id: string };
  readonly l: 'expenses' | 'invoiceReceipts';
  readonly param: string;
  readonly dateField: 'expenseDate' | 'invoiceDate';
  readonly typeField: 'expenseTypeCode' | 'invoiceTypeCode';
  readonly typeDict: 'expense_type' | 'invoice_type';
  readonly docNoLabel: 'expenseDocNo' | 'invoiceDocNo';
  readonly extra: 'expense' | 'invoice';
}

export const EXPENSE: FinanceKind = {
  id: 'expense',
  api: 'expenses',
  base: '/expenses',
  pageId: EXPENSES_PAGE_ID,
  resource: EXPENSES_RESOURCE,
  l: 'expenses',
  param: 'expenseId',
  dateField: 'expenseDate',
  typeField: 'expenseTypeCode',
  typeDict: 'expense_type',
  docNoLabel: 'expenseDocNo',
  extra: 'expense',
};

export const INVOICE: FinanceKind = {
  id: 'invoice',
  api: 'invoice-receipts',
  base: '/invoice-receipts',
  pageId: INVOICE_RECEIPTS_PAGE_ID,
  resource: INVOICE_RECEIPTS_RESOURCE,
  l: 'invoiceReceipts',
  param: 'invoiceReceiptId',
  dateField: 'invoiceDate',
  typeField: 'invoiceTypeCode',
  typeDict: 'invoice_type',
  docNoLabel: 'invoiceDocNo',
  extra: 'invoice',
};

export const KINDS: readonly FinanceKind[] = [EXPENSE, INVOICE];
