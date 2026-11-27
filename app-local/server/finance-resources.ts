import { defineCompositeResource } from '@nocobase/authorization/core';
import {
  defineDatabasePermission,
  type DatabaseCollectionDefinition,
} from '@nocobase/app-plugin-authorization/server';

/** R-065 第一片：支出与到票各一份业务资源，动作写全，不登记删除。 */
const NAMESPACE = 'app-local';
const title = (key: string) => ({ key, ns: NAMESPACE }) as const;

const expenseTitle = title('authorization.expenses.title');
const expenseTable = title('authorization.expenses.tables.records');
const expenseLines = title('authorization.expenses.tables.lines');
const invoiceTitle = title('authorization.invoiceReceipts.title');
const invoiceTable = title('authorization.invoiceReceipts.tables.records');
const invoiceLines = title('authorization.invoiceReceipts.tables.lines');
const orderTitle = title('authorization.purchaseOrders.tables.orders');

const ACTIONS = ['view', 'create', 'update', 'confirm', 'void'] as const;

const readExpense = defineDatabasePermission((permission) =>
  permission.collection('expenseRecords').title(expenseTable).read([
    'id', 'docNo', 'expenseDate', 'status', 'expenseTypeCode', 'fundAccountCode',
    'payeeName', 'supplierId', 'payeeAccountNo', 'payeeBankName', 'payeeBankCode',
    'bindMode', 'handlerUserId', 'projectCode', 'remark', 'totalAmount',
    'confirmedAt', 'voidedAt', 'createdAt', 'updatedAt',
  ]),
);
const writeExpense = defineDatabasePermission((permission) =>
  permission
    .collection('expenseRecords')
    .title(expenseTable)
    .read(['id', 'status', 'totalAmount'])
    .create([
      'docNo', 'expenseDate', 'status', 'expenseTypeCode', 'fundAccountCode',
      'payeeName', 'supplierId', 'payeeAccountNo', 'payeeBankName', 'payeeBankCode',
      'bindMode', 'handlerUserId', 'projectCode', 'remark', 'totalAmount',
      'createdById', 'createdAt', 'updatedAt',
    ])
    .update([
      'expenseDate', 'expenseTypeCode', 'fundAccountCode', 'payeeName',
      'payeeAccountNo', 'payeeBankName', 'payeeBankCode', 'handlerUserId',
      'projectCode', 'remark', 'totalAmount', 'status', 'confirmedAt', 'voidedAt',
    ]),
);
const readExpenseLines = defineDatabasePermission((permission) =>
  permission.collection('expenseRecordLines').title(expenseLines).read([
    'id', 'recordId', 'purchaseOrderId', 'orderPayableAmount', 'paidBefore', 'amount', 'note',
  ]),
);
const writeExpenseLines = defineDatabasePermission((permission) =>
  permission
    .collection('expenseRecordLines')
    .title(expenseLines)
    .read(['id', 'recordId'])
    .create(['id', 'recordId', 'purchaseOrderId', 'orderPayableAmount', 'paidBefore', 'amount', 'note'])
    .delete(),
);

const readInvoice = defineDatabasePermission((permission) =>
  permission.collection('invoiceReceiptRecords').title(invoiceTable).read([
    'id', 'docNo', 'invoiceDate', 'status', 'invoiceTypeCode', 'issuerName',
    'invoiceNo', 'supplierId', 'bindMode', 'handlerUserId', 'projectCode',
    'remark', 'totalAmount', 'confirmedAt', 'voidedAt', 'createdAt', 'updatedAt',
  ]),
);
const writeInvoice = defineDatabasePermission((permission) =>
  permission
    .collection('invoiceReceiptRecords')
    .title(invoiceTable)
    .read(['id', 'status', 'totalAmount'])
    .create([
      'docNo', 'invoiceDate', 'status', 'invoiceTypeCode', 'issuerName', 'invoiceNo',
      'supplierId', 'bindMode', 'handlerUserId', 'projectCode', 'remark',
      'totalAmount', 'createdById', 'createdAt', 'updatedAt',
    ])
    .update([
      'invoiceDate', 'invoiceTypeCode', 'issuerName', 'invoiceNo', 'handlerUserId',
      'projectCode', 'remark', 'totalAmount', 'status', 'confirmedAt', 'voidedAt',
    ]),
);
const readInvoiceLines = defineDatabasePermission((permission) =>
  permission.collection('invoiceReceiptRecordLines').title(invoiceLines).read([
    'id', 'recordId', 'purchaseOrderId', 'orderPayableAmount', 'invoicedBefore', 'amount', 'note',
  ]),
);
const writeInvoiceLines = defineDatabasePermission((permission) =>
  permission
    .collection('invoiceReceiptRecordLines')
    .title(invoiceLines)
    .read(['id', 'recordId'])
    .create(['id', 'recordId', 'purchaseOrderId', 'orderPayableAmount', 'invoicedBefore', 'amount', 'note'])
    .delete(),
);

/** 财务读采购订单只有八列，不含明细、价格、备注、经办人。 */
const financeViewOrders = defineDatabasePermission((permission) =>
  permission
    .collection('purchaseOrders')
    .title(orderTitle)
    .read([
      'id', 'orderNo', 'orderDate', 'status', 'supplierId',
      'payableTotal', 'paidAmount', 'invoicedAmount',
    ]),
);

export const FINANCE_COLLECTIONS: readonly DatabaseCollectionDefinition[] = [
  { name: 'expenseRecords', title: expenseTable, actions: ['read', 'create', 'update'] },
  { name: 'expenseRecordLines', title: expenseLines, actions: ['read', 'create', 'delete'] },
  { name: 'invoiceReceiptRecords', title: invoiceTable, actions: ['read', 'create', 'update'] },
  { name: 'invoiceReceiptRecordLines', title: invoiceLines, actions: ['read', 'create', 'delete'] },
];

const defineFinanceResource = (
  id: string,
  resourceTitle: ReturnType<typeof title>,
  readHeader: typeof readExpense,
  writeHeader: typeof writeExpense,
  readLines: typeof readExpenseLines,
  writeLines: typeof writeExpenseLines,
) =>
  defineCompositeResource(id, (resource) => {
    let result = resource.title(resourceTitle);
    for (const action of ACTIONS) {
      result = result.action(action, (definition) => definition
        .title(title(`authorization.${id}.actions.${action}`))
        .grant(id === 'expenses' ? 'expenseRecords' : 'invoiceReceiptRecords',
          action === 'view' ? readHeader : writeHeader)
        .grant(id === 'expenses' ? 'expenseRecordLines' : 'invoiceReceiptRecordLines',
          action === 'view' ? readLines : writeLines));
    }
    return result;
  });

export const expenses = defineFinanceResource(
  'expenses', expenseTitle, readExpense, writeExpense, readExpenseLines, writeExpenseLines,
);
export const invoiceReceipts = defineFinanceResource(
  'invoiceReceipts', invoiceTitle, readInvoice, writeInvoice, readInvoiceLines, writeInvoiceLines,
);

export const financeViewOrdersPermission = financeViewOrders;
