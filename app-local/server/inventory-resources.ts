import { defineCompositeResource } from '@nocobase/authorization/core';
import {
  defineDatabasePermission,
  type DatabaseCollectionDefinition,
} from '@nocobase/app-plugin-authorization/server';

/**
 * R-020 的业务资源声明（只声明，不查库、不赋权）。注册在 providers/authorization-resources.ts；
 * 默认授权由 seed 与 `authz upgrade-r020` 写。
 *
 * 六个动作照任务书拆开：仓库读、仓库建改（只给 root）、单据读、单据写、过账、作废。
 * 仓管拿其中五个，不拿 warehouseManage。授权没有字段这一层，写权限只列端点会写的列。
 * 动作清单写全，不登记删除（单据与流水只追加、只改状态）。
 * 本片没有页面，所以不做 ui.place。
 */
const NAMESPACE = 'app-local';

const title = (key: string) => ({ key, ns: NAMESPACE }) as const;

const warehouseTitle = title('authorization.inventory.tables.warehouses');
const docTitle = title('authorization.inventory.tables.stockDocs');
const lineTitle = title('authorization.inventory.tables.stockDocLines');
const balanceTitle = title('authorization.inventory.tables.stockBalances');
const transactionTitle = title('authorization.inventory.tables.stockTransactions');

const WAREHOUSE_READ = [
  'id', 'code', 'name', 'status', 'note', 'createdAt', 'updatedAt',
] as const;
const WAREHOUSE_CREATE = ['code', 'name', 'status', 'note'] as const;
const WAREHOUSE_UPDATE = ['name', 'status', 'note'] as const;

const DOC_READ = [
  'id', 'docNo', 'docType', 'reason', 'status', 'remark', 'sourceType',
  'sourceId', 'createdById', 'postedAt', 'postedById', 'createdAt', 'updatedAt',
  'docDate', 'partnerId', 'contactName', 'contactPhone', 'deliveryAddress',
  'customerOrderNo', 'projectCode', 'handlerUserId', 'takerDepartmentId',
  'takerUserId', 'totalQty',
] as const;
const DOC_PRICE_READ = [
  'discountAmount', 'taxIncludedTotal', 'taxExcludedTotal', 'taxTotal', 'payableTotal',
] as const;
const DOC_WRITE = [
  'reason', 'remark', 'sourceType', 'sourceId', 'status', 'docDate', 'partnerId',
  'contactName', 'contactPhone', 'deliveryAddress', 'customerOrderNo', 'projectCode',
  'handlerUserId', 'takerDepartmentId', 'takerUserId', 'discountAmount',
  'totalQty', 'taxIncludedTotal', 'taxExcludedTotal', 'taxTotal', 'payableTotal',
] as const;
const LINE_READ = [
  'id', 'docId', 'itemId', 'warehouseId', 'batchNo', 'qty',
  'productionDate', 'expiryDate', 'note', 'taxRate',
] as const;
const LINE_PRICE_READ = [
  'taxIncludedPrice', 'taxExcludedPrice', 'taxExcludedAmount', 'taxAmount', 'taxIncludedAmount',
] as const;
const LINE_WRITE = [...LINE_READ, ...LINE_PRICE_READ] as const;
const BALANCE_READ = ['itemId', 'warehouseId', 'batchNo', 'qty'] as const;
const TRANSACTION_READ = [
  'id', 'docId', 'docLineId', 'docNo', 'itemId', 'warehouseId', 'batchNo',
  'qtyDelta', 'balanceAfter', 'at', 'byUserId',
] as const;

const readWarehouses = defineDatabasePermission((permission) =>
  permission.collection('warehouses').title(warehouseTitle).read(WAREHOUSE_READ),
);
const manageWarehouses = defineDatabasePermission((permission) =>
  permission
    .collection('warehouses')
    .title(warehouseTitle)
    .read(WAREHOUSE_READ)
    .create(WAREHOUSE_CREATE)
    .update(WAREHOUSE_UPDATE),
);
const readDocs = defineDatabasePermission((permission) =>
  permission.collection('stockDocs').title(docTitle).read(DOC_READ),
);
const readDocsWithPrice = defineDatabasePermission((permission) =>
  permission.collection('stockDocs').title(docTitle).read([...DOC_READ, ...DOC_PRICE_READ]),
);
const readLinesWithPrice = defineDatabasePermission((permission) =>
  permission.collection('stockDocLines').title(lineTitle).read([...LINE_READ, ...LINE_PRICE_READ]),
);
const writeDocs = defineDatabasePermission((permission) =>
  permission
    .collection('stockDocs')
    .title(docTitle)
    .read(DOC_READ)
    .create(DOC_WRITE)
    .update(DOC_WRITE),
);
const readLines = defineDatabasePermission((permission) =>
  permission.collection('stockDocLines').title(lineTitle).read(LINE_READ),
);
const writeLines = defineDatabasePermission((permission) =>
  permission
    .collection('stockDocLines')
    .title(lineTitle)
    .read(LINE_READ)
    .create(LINE_WRITE)
    .delete(),
);
const readBalances = defineDatabasePermission((permission) =>
  permission.collection('stockBalances').title(balanceTitle).read(BALANCE_READ),
);
const readTransactions = defineDatabasePermission((permission) =>
  permission.collection('stockTransactions').title(transactionTitle).read(TRANSACTION_READ),
);

/** 动作清单写全，否则框架默认把删除也登记上。 */
export const INVENTORY_COLLECTIONS: readonly DatabaseCollectionDefinition[] = [
  { name: 'warehouses', title: warehouseTitle, actions: ['read', 'create', 'update'] },
  { name: 'stockDocs', title: docTitle, actions: ['read', 'create', 'update'] },
  { name: 'stockDocLines', title: lineTitle, actions: ['read', 'create', 'delete'] },
  { name: 'stockBalances', title: balanceTitle, actions: ['read'] },
  { name: 'stockTransactions', title: transactionTitle, actions: ['read'] },
];

export const inventory = defineCompositeResource('inventory', (resource) =>
  resource
    .title(title('authorization.inventory.title'))
    .action('warehouseView', (action) =>
      action
        .title(title('authorization.inventory.actions.warehouseView'))
        .grant('warehouses', readWarehouses),
    )
    .action('warehouseManage', (action) =>
      action
        .title(title('authorization.inventory.actions.warehouseManage'))
        .grant('warehouses', manageWarehouses),
    )
    .action('stockView', (action) =>
      action
        .title(title('authorization.inventory.actions.stockView'))
        .grant('stockDocs', readDocs)
        .grant('stockDocLines', readLines)
        .grant('stockBalances', readBalances)
        .grant('stockTransactions', readTransactions),
    )
    .action('stockWrite', (action) =>
      action
        .title(title('authorization.inventory.actions.stockWrite'))
        .grant('stockDocs', writeDocs)
        .grant('stockDocLines', writeLines),
    )
    .action('stockPost', (action) =>
      action
        .title(title('authorization.inventory.actions.stockPost'))
        .grant('stockDocs', writeDocs)
        .grant('stockDocLines', readLines),
    )
    .action('stockVoid', (action) =>
      action
        .title(title('authorization.inventory.actions.stockVoid'))
        .grant('stockDocs', writeDocs),
    )
    .action('stockPriceView', (action) =>
      action
        .title(title('authorization.inventory.actions.stockPriceView'))
        .grant('stockDocs', readDocsWithPrice)
        .grant('stockDocLines', readLinesWithPrice),
    ),
);
