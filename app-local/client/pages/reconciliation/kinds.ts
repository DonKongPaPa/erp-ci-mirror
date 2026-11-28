import {
  INCOME_RECORDS_PAGE_ID, INCOME_RECORDS_RESOURCE,
  SALE_INVOICE_RECORDS_PAGE_ID, SALE_INVOICE_RECORDS_RESOURCE,
  RECEIVABLE_RECONS_PAGE_ID, RECEIVABLE_RECONS_RESOURCE,
  PAYABLE_RECONS_PAGE_ID, PAYABLE_RECONS_RESOURCE,
} from './page-id.js';

/** 四张单共用一个表头、明细与状态骨架；差别集中在这四个定义里。 */
interface KindBase {
  readonly api: string;
  readonly base: string;
  readonly pageId: string;
  readonly resource: { readonly type: 'composite'; readonly id: string };
  readonly l: string;
  readonly param: string;
}

export interface DocKind extends KindBase {
  readonly group: 'doc';
  readonly id: 'income' | 'saleInvoice';
  readonly dateField: 'incomeDate' | 'invoiceDate';
  readonly typeField: 'incomeTypeCode' | 'invoiceTypeCode';
  readonly typeDict: 'income_type' | 'invoice_type';
  readonly reconBindMode: 'receivable_recon';
}

export interface ReconKind extends KindBase {
  readonly group: 'recon';
  readonly id: 'receivable' | 'payable';
  readonly partnerKey: 'customerId' | 'supplierId';
  readonly partnerKind: 'customer' | 'supplier';
  readonly sourceKind: 'out' | 'in';
  readonly sourceIdsKey: 'outStockDocIds' | 'purchaseStockDocIds';
  readonly amountOneKey: 'reconciledIncomeAmount' | 'reconciledPaidAmount';
  readonly amountOneLabel: string;
  readonly amountTwoKey: 'reconciledInvoiceAmount';
  readonly amountTwoLabel: string;
  readonly typeDict?: 'invoice_type';
}

export type ReconciliationKind = DocKind | ReconKind;

export const INCOME: DocKind = {
  group: 'doc', id: 'income', api: 'income-records', base: '/income-records',
  pageId: INCOME_RECORDS_PAGE_ID, resource: INCOME_RECORDS_RESOURCE,
  l: 'incomeRecords', param: 'incomeRecordId',
  dateField: 'incomeDate', typeField: 'incomeTypeCode',
  typeDict: 'income_type', reconBindMode: 'receivable_recon',
};

export const SALE_INVOICE: DocKind = {
  group: 'doc', id: 'saleInvoice', api: 'sale-invoice-records',
  base: '/sale-invoice-records', pageId: SALE_INVOICE_RECORDS_PAGE_ID,
  resource: SALE_INVOICE_RECORDS_RESOURCE, l: 'saleInvoiceRecords',
  param: 'saleInvoiceRecordId', dateField: 'invoiceDate',
  typeField: 'invoiceTypeCode', typeDict: 'invoice_type',
  reconBindMode: 'receivable_recon',
};

export const RECEIVABLE: ReconKind = {
  group: 'recon', id: 'receivable', api: 'receivable-recons',
  base: '/receivable-recons', pageId: RECEIVABLE_RECONS_PAGE_ID,
  resource: RECEIVABLE_RECONS_RESOURCE, l: 'receivableRecons',
  param: 'receivableReconId', partnerKey: 'customerId', partnerKind: 'customer',
  sourceKind: 'out', sourceIdsKey: 'outStockDocIds',
  amountOneKey: 'reconciledIncomeAmount', amountOneLabel: 'reconciliation.reconciledIncomeAmount',
  amountTwoKey: 'reconciledInvoiceAmount', amountTwoLabel: 'reconciliation.reconciledInvoiceAmount',
};

export const PAYABLE: ReconKind = {
  group: 'recon', id: 'payable', api: 'payable-recons', base: '/payable-recons',
  pageId: PAYABLE_RECONS_PAGE_ID, resource: PAYABLE_RECONS_RESOURCE,
  l: 'payableRecons', param: 'payableReconId', partnerKey: 'supplierId',
  partnerKind: 'supplier', sourceKind: 'in', sourceIdsKey: 'purchaseStockDocIds',
  amountOneKey: 'reconciledPaidAmount', amountOneLabel: 'reconciliation.reconciledPaidAmount',
  amountTwoKey: 'reconciledInvoiceAmount', amountTwoLabel: 'reconciliation.reconciledInvoiceAmount',
  typeDict: 'invoice_type',
};
