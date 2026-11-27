/** R-076：打印视图的路径段到资源 id 的映射，与服务端 `PRINT_DOC_TYPES` 一致。 */
export const DOC_PRINT_PATHS = {
  'internal-use': { resource: 'docPrintInternalIssue' },
  'sales-issue': { resource: 'docPrintSalesIssue' },
  'purchase-receipt': { resource: 'docPrintPurchaseReceipt' },
} as const;

export type DocPrintPath = keyof typeof DOC_PRINT_PATHS;

/** 单据 reason → 打印路径段；只有三种进打印第一版。 */
export const DOC_PRINT_REASON_PATHS = {
  internal_use: 'internal-use',
  sales_issue: 'sales-issue',
  purchase_receipt: 'purchase-receipt',
} as const;

export const DOC_PRINT_ROUTE_PATH = '/main/doc-print/:docType/:docNo';
