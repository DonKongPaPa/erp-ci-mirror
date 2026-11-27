import { defineCompositeResource } from '@nocobase/authorization/core';
import {
  defineDatabasePermission,
  type DatabaseCollectionDefinition,
} from '@nocobase/app-plugin-authorization/server';

/**
 * R-021/R-022 的业务资源声明（只声明，不查库、不赋权）。
 * 采购与销售各一份 composite，动作清单写全，不登记删除 —— 没有删除端点。
 * 生成单据的动作同时声明读仓库/物料与建库存单据；进度回写在库存过账的动作里完成。
 * 本片没有页面，所以不做 ui.place。
 */
const NAMESPACE = 'app-local';
const title = (key: string) => ({ key, ns: NAMESPACE }) as const;

const purchaseHeaderTitle = title('authorization.purchaseOrders.tables.orders');
const purchaseLineTitle = title('authorization.purchaseOrders.tables.lines');
const salesHeaderTitle = title('authorization.salesOrders.tables.orders');
const salesLineTitle = title('authorization.salesOrders.tables.lines');
const warehouseTitle = title('authorization.inventory.tables.warehouses');
const itemTitle = title('authorization.items.tables.items');
const docTitle = title('authorization.inventory.tables.stockDocs');
const docLineTitle = title('authorization.inventory.tables.stockDocLines');

const headerRead = (kind: 'purchase' | 'sales') => [
  'id', 'orderNo', kind === 'purchase' ? 'supplierId' : 'customerId',
  'orderDate', 'status', 'remark', 'submittedAt', 'createdAt', 'updatedAt',
] as const;
const headerWrite = (kind: 'purchase' | 'sales') => [
  ...headerRead(kind), 'createdById',
] as const;
const headerUpdate = (kind: 'purchase' | 'sales') => [
  kind === 'purchase' ? 'supplierId' : 'customerId',
  'orderDate', 'remark', 'status', 'submittedAt', 'updatedAt',
] as const;
const lineRead = (kind: 'purchase' | 'sales') => [
  'id', 'orderId', 'itemId', 'qty', 'price',
  kind === 'purchase' ? 'receivedQty' : 'shippedQty',
] as const;

const readHeader = (kind: 'purchase' | 'sales') =>
  defineDatabasePermission((permission) =>
    permission
      .collection(kind === 'purchase' ? 'purchaseOrders' : 'salesOrders')
      .title(kind === 'purchase' ? purchaseHeaderTitle : salesHeaderTitle)
      .read(headerRead(kind)),
  );
const readLines = (kind: 'purchase' | 'sales') =>
  defineDatabasePermission((permission) =>
    permission
      .collection(kind === 'purchase' ? 'purchaseOrderLines' : 'salesOrderLines')
      .title(kind === 'purchase' ? purchaseLineTitle : salesLineTitle)
      .read(lineRead(kind)),
  );

const createHeader = (kind: 'purchase' | 'sales') =>
  defineDatabasePermission((permission) =>
    permission
      .collection(kind === 'purchase' ? 'purchaseOrders' : 'salesOrders')
      .title(kind === 'purchase' ? purchaseHeaderTitle : salesHeaderTitle)
      .read(headerRead(kind))
      .create(headerWrite(kind)),
  );
const createLines = (kind: 'purchase' | 'sales') =>
  defineDatabasePermission((permission) =>
    permission
      .collection(kind === 'purchase' ? 'purchaseOrderLines' : 'salesOrderLines')
      .title(kind === 'purchase' ? purchaseLineTitle : salesLineTitle)
      .read(lineRead(kind))
      .create(lineRead(kind))
      .delete(),
  );
const updateHeader = (kind: 'purchase' | 'sales') =>
  defineDatabasePermission((permission) =>
    permission
      .collection(kind === 'purchase' ? 'purchaseOrders' : 'salesOrders')
      .title(kind === 'purchase' ? purchaseHeaderTitle : salesHeaderTitle)
      .read(headerRead(kind))
      .update(headerUpdate(kind)),
  );

const readWarehouses = defineDatabasePermission((permission) =>
  permission.collection('warehouses').title(warehouseTitle).read([
    'id', 'code', 'name', 'status', 'note', 'createdAt', 'updatedAt',
  ]),
);
const readItems = defineDatabasePermission((permission) =>
  permission.collection('items').title(itemTitle).read([
    'id', 'code', 'name', 'spec', 'itemType', 'categoryCode', 'unitCode',
    'status', 'legacyCode', 'note', 'createdById', 'createdAt', 'updatedAt',
  ]),
);
const createDoc = defineDatabasePermission((permission) =>
  permission
    .collection('stockDocs')
    .title(docTitle)
    .read(['id', 'docNo', 'docType', 'reason', 'status', 'sourceType', 'sourceId'])
    .create(['docType', 'reason', 'status', 'sourceType', 'sourceId', 'createdById']),
);
const createDocLines = defineDatabasePermission((permission) =>
  permission.collection('stockDocLines').title(docLineTitle).create([
    'id', 'docId', 'itemId', 'warehouseId', 'batchNo', 'qty',
  ]),
);

export const ORDER_COLLECTIONS: readonly DatabaseCollectionDefinition[] = [
  {
    name: 'purchaseOrders',
    title: purchaseHeaderTitle,
    actions: ['read', 'create', 'update'],
  },
  {
    name: 'purchaseOrderLines',
    title: purchaseLineTitle,
    actions: ['read', 'create', 'delete'],
  },
  {
    name: 'salesOrders',
    title: salesHeaderTitle,
    actions: ['read', 'create', 'update'],
  },
  {
    name: 'salesOrderLines',
    title: salesLineTitle,
    actions: ['read', 'create', 'delete'],
  },
];

/** 两个资源同形不同名，授权对象不同：销售即使直连采购订单也是 403。 */
const defineOrderResource = (kind: 'purchase' | 'sales') => {
  const id = kind === 'purchase' ? 'purchaseOrders' : 'salesOrders';
  const issueAction = kind === 'purchase' ? 'createReceipt' : 'createIssue';
  return defineCompositeResource(id, (resource) =>
    resource
      .title(title(`authorization.${id}.title`))
      .action('view', (action) =>
        action
          .title(title(`authorization.${id}.actions.view`))
          .grant(kind === 'purchase' ? 'purchaseOrders' : 'salesOrders', readHeader(kind))
          .grant(kind === 'purchase' ? 'purchaseOrderLines' : 'salesOrderLines', readLines(kind)),
      )
      .action('create', (action) =>
        action
          .title(title(`authorization.${id}.actions.create`))
          .grant(kind === 'purchase' ? 'purchaseOrders' : 'salesOrders', createHeader(kind))
          .grant(kind === 'purchase' ? 'purchaseOrderLines' : 'salesOrderLines', createLines(kind)),
      )
      .action('update', (action) =>
        action
          .title(title(`authorization.${id}.actions.update`))
          .grant(kind === 'purchase' ? 'purchaseOrders' : 'salesOrders', updateHeader(kind))
          .grant(kind === 'purchase' ? 'purchaseOrderLines' : 'salesOrderLines', createLines(kind)),
      )
      .action('submit', (action) =>
        action
          .title(title(`authorization.${id}.actions.submit`))
          .grant(kind === 'purchase' ? 'purchaseOrders' : 'salesOrders', updateHeader(kind)),
      )
      .action('cancel', (action) =>
        action
          .title(title(`authorization.${id}.actions.cancel`))
          .grant(kind === 'purchase' ? 'purchaseOrders' : 'salesOrders', updateHeader(kind)),
      )
      .action(issueAction, (action) =>
        action
          .title(title(`authorization.${id}.actions.${issueAction}`))
          .grant(kind === 'purchase' ? 'purchaseOrders' : 'salesOrders', readHeader(kind))
          .grant(kind === 'purchase' ? 'purchaseOrderLines' : 'salesOrderLines', readLines(kind))
          .grant('warehouses', readWarehouses)
          .grant('items', readItems)
          .grant('stockDocs', createDoc)
          .grant('stockDocLines', createDocLines),
      ),
  );
};

export const purchaseOrders = defineOrderResource('purchase');
export const salesOrders = defineOrderResource('sales');
