import { defineCompositeResource } from '@nocobase/authorization/core';
import { defineDatabasePermission } from '@nocobase/app-plugin-authorization/server';

/**
 * R-076 的业务资源声明（只声明，不查库、不赋权）。三类单据 × 两个动作，取最窄粒度：
 * `print` 只读单据与明细的非价格列，`printPrice` 才叠加价格列。注册在
 * providers/authorization-resources.ts；默认授权由新种子与 upgrade-r076 写。
 *
 * stockDocs / stockDocLines 两张表已由 inventory 资源登记，这里只声明读列，不重复登记表；
 * 六个动作清单写全，不登记任何写或删除动作。本片有打印页面，但页面不登记页面授权，
 * 进入时按 docType 检查这些动作，所以这里也不做 ui.place。
 */
const NAMESPACE = 'app-local';
const title = (key: string) => ({ key, ns: NAMESPACE }) as const;

const docTitle = title('authorization.inventory.tables.stockDocs');
const lineTitle = title('authorization.inventory.tables.stockDocLines');

/** createdById 只用于 preparedBy 的账号标识；不回邮箱、手机号、部门。 */
const DOC_PRINT_READ = [
  'id', 'docNo', 'docType', 'reason', 'status', 'remark', 'docDate',
  'partnerId', 'contactName', 'contactPhone', 'deliveryAddress',
  'customerOrderNo', 'projectCode', 'handlerUserId', 'takerDepartmentId',
  'takerUserId', 'totalQty', 'createdById', 'printCount', 'lastPrintedAt',
  'lastPrintedBy',
] as const;
const DOC_PRICE_READ = [
  'discountAmount', 'taxIncludedTotal', 'taxExcludedTotal', 'taxTotal', 'payableTotal',
] as const;
const LINE_PRINT_READ = [
  'id', 'docId', 'itemId', 'warehouseId', 'batchNo', 'qty',
  'productionDate', 'expiryDate', 'note',
] as const;
const LINE_PRICE_READ = [
  'taxIncludedPrice', 'taxExcludedPrice', 'taxRate',
  'taxExcludedAmount', 'taxAmount', 'taxIncludedAmount',
] as const;

const readDoc = defineDatabasePermission((permission) =>
  permission.collection('stockDocs').title(docTitle).read(DOC_PRINT_READ),
);
const readDocWithPrice = defineDatabasePermission((permission) =>
  permission.collection('stockDocs').title(docTitle).read([...DOC_PRINT_READ, ...DOC_PRICE_READ]),
);
const readLine = defineDatabasePermission((permission) =>
  permission.collection('stockDocLines').title(lineTitle).read(LINE_PRINT_READ),
);
const readLineWithPrice = defineDatabasePermission((permission) =>
  permission.collection('stockDocLines').title(lineTitle).read([...LINE_PRINT_READ, ...LINE_PRICE_READ]),
);

function definePrintResource(
  name: 'docPrintInternalIssue' | 'docPrintSalesIssue' | 'docPrintPurchaseReceipt',
) {
  return defineCompositeResource(name, (resource) =>
    resource
      .title(title(`authorization.${name}.title`))
      .action('print', (action) =>
        action
          .title(title(`authorization.${name}.actions.print`))
          .grant('stockDocs', readDoc)
          .grant('stockDocLines', readLine),
      )
      .action('printPrice', (action) =>
        action
          .title(title(`authorization.${name}.actions.printPrice`))
          .grant('stockDocs', readDocWithPrice)
          .grant('stockDocLines', readLineWithPrice),
      ),
  );
}

export const docPrintInternalIssue = definePrintResource('docPrintInternalIssue');
export const docPrintSalesIssue = definePrintResource('docPrintSalesIssue');
export const docPrintPurchaseReceipt = definePrintResource('docPrintPurchaseReceipt');

export const DOC_PRINT_RESOURCES = [
  docPrintInternalIssue,
  docPrintSalesIssue,
  docPrintPurchaseReceipt,
] as const;

/** 端点路径段 → 资源 id / reason，一处定义，路由与种子各自引用。 */
export const PRINT_DOC_TYPES = {
  'internal-use': { resource: 'docPrintInternalIssue', reason: 'internal_use' },
  'sales-issue': { resource: 'docPrintSalesIssue', reason: 'sales_issue' },
  'purchase-receipt': { resource: 'docPrintPurchaseReceipt', reason: 'purchase_receipt' },
} as const;
export type PrintDocTypePath = keyof typeof PRINT_DOC_TYPES;
