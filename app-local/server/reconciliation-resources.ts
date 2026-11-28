import { defineCompositeResource } from '@nocobase/authorization/core';
import {
  defineDatabasePermission,
  type DatabaseCollectionDefinition,
} from '@nocobase/app-plugin-authorization/server';

/**
 * R-065 复刻波 2 加片：收入、开票、应收应付对账四份业务资源，动作写全，不登记删除。
 * 全部只给 finance 与 root：注册只声明能做什么，授权由 019 种子与升级命令给。
 */
const NAMESPACE = 'app-local';
const title = (key: string) => ({ key, ns: NAMESPACE }) as const;

const ACTIONS = ['view', 'create', 'update', 'confirm', 'void'] as const;
type Action = (typeof ACTIONS)[number];

const headerFields = [
  'id', 'docNo', 'status', 'customerId', 'supplierId', 'bindMode',
  'handlerUserId', 'projectCode', 'remark', 'totalAmount',
  'confirmedAt', 'voidedAt', 'createdAt', 'updatedAt',
] as const;
const lineFields = [
  'id', 'recordId', 'salesOrderId', 'receivableReconId',
  'orderPayableAmount', 'amount', 'note',
] as const;
const incomeLineFields = [...lineFields, 'receivedBefore'] as const;
const invoiceLineFields = [...lineFields, 'invoicedBefore'] as const;
const reconFields = [
  'id', 'docNo', 'reconDate', 'expectedPayDate', 'customerId', 'supplierId',
  'contactName', 'phone', 'periodAmount', 'invoiceTypeCode', 'status',
  'reconStatus', 'reconciledIncomeAmount', 'reconciledInvoiceAmount',
  'reconciledPaidAmount', 'handlerUserId', 'projectCode', 'remark',
  'confirmedAt', 'voidedAt', 'createdAt', 'updatedAt',
] as const;
const snapshotFields = [
  'id', 'reconId', 'side', 'sourceDocId', 'itemId', 'itemCode', 'itemName',
  'itemSpec', 'unitCode', 'qty', 'taxRate', 'taxIncludedPrice',
  'taxIncludedAmount', 'note',
] as const;

type CollectionName =
  | 'incomeRecords' | 'incomeRecordLines'
  | 'saleInvoiceRecords' | 'saleInvoiceRecordLines'
  | 'receivableRecons' | 'payableRecons' | 'reconSnapshotLines';

const FIELDS: Readonly<Record<CollectionName, readonly string[]>> = {
  incomeRecords: [
    ...headerFields.filter((field) => field !== 'supplierId'),
    'incomeDate', 'incomeTypeCode', 'fundAccountCode', 'payerName', 'createdById',
  ],
  incomeRecordLines: incomeLineFields,
  saleInvoiceRecords: [
    ...headerFields.filter((field) => field !== 'supplierId'),
    'invoiceDate', 'invoiceTypeCode', 'invoiceToName', 'invoiceNo', 'createdById',
  ],
  saleInvoiceRecordLines: invoiceLineFields,
  receivableRecons: [
    ...reconFields.filter((field) => !['supplierId', 'invoiceTypeCode', 'reconciledPaidAmount'].includes(field)),
    'createdById',
  ],
  payableRecons: [
    ...reconFields.filter((field) => !['customerId', 'reconciledIncomeAmount'].includes(field)),
    'createdById',
  ],
  reconSnapshotLines: snapshotFields,
};

/** 快照行与核销列由服务写，不通过数据库权限开放给写动作；只列真正可写的列。 */
const WRITE_FIELDS: Readonly<Record<CollectionName, readonly string[]>> = {
  incomeRecords: [...FIELDS.incomeRecords],
  incomeRecordLines: [...FIELDS.incomeRecordLines],
  saleInvoiceRecords: [...FIELDS.saleInvoiceRecords],
  saleInvoiceRecordLines: [...FIELDS.saleInvoiceRecordLines],
  receivableRecons: [...FIELDS.receivableRecons.filter((field) => field !== 'reconStatus')],
  payableRecons: [...FIELDS.payableRecons.filter((field) => field !== 'reconStatus')],
  reconSnapshotLines: [...snapshotFields],
};

const read = (collection: CollectionName) =>
  defineDatabasePermission((permission) =>
    permission.collection(collection).title(title(`authorization.${collection}.tables.records`))
      .read([...FIELDS[collection]]));

const write = (collection: CollectionName) =>
  defineDatabasePermission((permission) =>
    permission.collection(collection).title(title(`authorization.${collection}.tables.records`))
      .read(['id', 'status', 'totalAmount'])
      .create([...WRITE_FIELDS[collection]])
      .update([...WRITE_FIELDS[collection]])
      .delete());

/** 财务读销售订单只有八列头 + 客户三列摘要，没有明细、单价、备注、经办人。 */
export const financeViewSalesOrdersPermission = defineDatabasePermission((permission) =>
  permission.collection('salesOrders').title(title('authorization.salesOrders.tables.orders'))
    .read([
      'id', 'orderNo', 'orderDate', 'status', 'customerId',
      'payableTotal', 'receivedAmount', 'invoicedAmount',
    ]));

export const financeViewSalesCustomerPermission = defineDatabasePermission((permission) =>
  permission.collection('partners').title(title('authorization.partners.tables.partners'))
    .read(['id', 'code', 'name']));

export const RECONCILIATION_COLLECTIONS: readonly DatabaseCollectionDefinition[] = [
  { name: 'incomeRecords', title: title('authorization.incomeRecords.tables.records'), actions: ['read', 'create', 'update'] },
  { name: 'incomeRecordLines', title: title('authorization.incomeRecords.tables.lines'), actions: ['read', 'create', 'delete'] },
  { name: 'saleInvoiceRecords', title: title('authorization.saleInvoiceRecords.tables.records'), actions: ['read', 'create', 'update'] },
  { name: 'saleInvoiceRecordLines', title: title('authorization.saleInvoiceRecords.tables.lines'), actions: ['read', 'create', 'delete'] },
  { name: 'receivableRecons', title: title('authorization.receivableRecons.tables.records'), actions: ['read', 'create', 'update'] },
  { name: 'payableRecons', title: title('authorization.payableRecons.tables.records'), actions: ['read', 'create', 'update'] },
  { name: 'reconSnapshotLines', title: title('authorization.reconSnapshotLines.tables.lines'), actions: ['read', 'create', 'delete'] },
];

/** 四份资源同形不同名；grant 的键用字面量，授权对象彼此隔离。 */
const withActions = (
  id: string,
  header: CollectionName,
  lines?: CollectionName,
) =>
  defineCompositeResource(id, (resource) => {
    let result = resource.title(title(`authorization.${id}.title`));
    for (const action of ACTIONS) {
      result = result.action(action, (definition) => {
        const policy = definition.title(title(`authorization.${id}.actions.${action}`))
          .grant(header as 'incomeRecords', action === 'view' ? read(header) : write(header));
        return lines === undefined
          ? policy
          : policy.grant(lines as 'incomeRecordLines', action === 'view' ? read(lines) : write(lines));
      });
    }
    return result;
  });

export const incomeRecords = withActions('incomeRecords', 'incomeRecords', 'incomeRecordLines');
export const saleInvoiceRecords = withActions(
  'saleInvoiceRecords', 'saleInvoiceRecords', 'saleInvoiceRecordLines',
);
export const receivableRecons = withActions('receivableRecons', 'receivableRecons');
export const payableRecons = withActions('payableRecons', 'payableRecons');

export type ReconciliationAction = Action;
