import { defineCompositeResource } from '@nocobase/authorization/core';
import {
  defineDatabasePermission,
  recordAccess,
  type DatabaseCollectionDefinition,
} from '@nocobase/app-plugin-authorization/server';

import { PURCHASE_REQUEST_SCOPE_REFERENCES } from './purchase-request-record-access.js';

/**
 * R-021 波 1 加片：请购单业务资源声明（只声明，不查库、不赋权）。
 *
 * 六个动作，不登记删除 —— 作废进终态。createdById 是审计列，任何读授权里都没有它。
 * `view` / `create` / `update` / `submit` / `void` 允许「仅本人」范围（staff 用），
 * `convert` 不带范围（只有 purchase 与 root）；不新增角色，默认授权由新种子与
 * `upgrade-r021-purchase-request` 写。本片没有页面，所以不做 ui.place。
 */
const NAMESPACE = 'app-local';
const title = (key: string) => ({ key, ns: NAMESPACE }) as const;

const requestTitle = title('authorization.purchaseRequests.tables.requests');
const lineTitle = title('authorization.purchaseRequests.tables.lines');
const orderTitle = title('authorization.purchaseOrders.tables.orders');
const orderLineTitle = title('authorization.purchaseOrders.tables.lines');

/** 与接口契约的 PurchaseRequest 窄列一致；不含 createdById、电话、邮箱。 */
const REQUEST_READ = [
  'id', 'docNo', 'requestDate', 'departmentId', 'requesterUserId',
  'projectCode', 'customText1', 'customText2', 'description', 'status',
  'approvalId', 'convertedOrderId', 'totalQty', 'estimatedTotal',
  'createdAt', 'updatedAt',
] as const;
const REQUEST_CREATE = [...REQUEST_READ, 'createdById'] as const;
const REQUEST_UPDATE = [
  'requestDate', 'departmentId', 'requesterUserId', 'projectCode',
  'customText1', 'customText2', 'description', 'status', 'approvalId',
  'convertedOrderId', 'totalQty', 'estimatedTotal', 'updatedAt',
] as const;
const LINE_READ = [
  'id', 'requestId', 'itemId', 'qty', 'expectedPrice', 'expectedAmount',
] as const;
const LINE_CREATE = ['requestId', 'itemId', 'qty', 'expectedPrice', 'expectedAmount'] as const;

/** 转出来的订单草稿：采购随后按既有流程补供应商与价格。 */
const CONVERT_ORDER_CREATE = [
  'id', 'orderNo', 'supplierId', 'orderDate', 'status', 'remark',
  'projectCode', 'purchaseRequestId', 'createdById', 'createdAt', 'updatedAt',
] as const;
const CONVERT_LINE_CREATE = [
  'id', 'orderId', 'itemId', 'qty', 'receivedQty',
] as const;

export const PURCHASE_REQUEST_COLLECTIONS: readonly DatabaseCollectionDefinition[] = [
  { name: 'purchaseRequests', title: requestTitle, actions: ['read', 'create', 'update'] },
  {
    name: 'purchaseRequestLines',
    title: lineTitle,
    actions: ['read', 'create', 'delete'],
  },
];

const readRequests = defineDatabasePermission((permission) =>
  permission
    .collection('purchaseRequests')
    .title(requestTitle)
    .read(REQUEST_READ)
    .options(PURCHASE_REQUEST_SCOPE_REFERENCES.purchaseRequests, recordAccess.allRecords)
    .default(recordAccess.allRecords),
);
const createRequests = defineDatabasePermission((permission) =>
  permission
    .collection('purchaseRequests')
    .title(requestTitle)
    .read(REQUEST_READ)
    .create(REQUEST_CREATE)
    .options(PURCHASE_REQUEST_SCOPE_REFERENCES.purchaseRequests, recordAccess.allRecords)
    .default(recordAccess.allRecords),
);
const updateRequests = defineDatabasePermission((permission) =>
  permission
    .collection('purchaseRequests')
    .title(requestTitle)
    .read(REQUEST_READ)
    .update(REQUEST_UPDATE)
    .options(PURCHASE_REQUEST_SCOPE_REFERENCES.purchaseRequests, recordAccess.allRecords)
    .default(recordAccess.allRecords),
);
const readLines = defineDatabasePermission((permission) =>
  permission.collection('purchaseRequestLines').title(lineTitle).read(LINE_READ),
);
const writeLines = defineDatabasePermission((permission) =>
  permission
    .collection('purchaseRequestLines')
    .title(lineTitle)
    .read(LINE_READ)
    .create(LINE_CREATE)
    .delete(),
);
const createOrder = defineDatabasePermission((permission) =>
  permission
    .collection('purchaseOrders')
    .title(orderTitle)
    .read(CONVERT_ORDER_CREATE)
    .create(CONVERT_ORDER_CREATE),
);
const createOrderLines = defineDatabasePermission((permission) =>
  permission
    .collection('purchaseOrderLines')
    .title(orderLineTitle)
    .read(CONVERT_LINE_CREATE)
    .create(CONVERT_LINE_CREATE),
);

export const purchaseRequests = defineCompositeResource(
  'purchaseRequests',
  (resource) =>
    resource
      .title(title('authorization.purchaseRequests.title'))
      .action('view', (action) =>
        action
          .title(title('authorization.purchaseRequests.actions.view'))
          .grant('purchaseRequests', readRequests)
          .grant('purchaseRequestLines', readLines),
      )
      .action('create', (action) =>
        action
          .title(title('authorization.purchaseRequests.actions.create'))
          .grant('purchaseRequests', createRequests)
          .grant('purchaseRequestLines', writeLines),
      )
      .action('update', (action) =>
        action
          .title(title('authorization.purchaseRequests.actions.update'))
          .grant('purchaseRequests', updateRequests)
          .grant('purchaseRequestLines', writeLines),
      )
      .action('submit', (action) =>
        action
          .title(title('authorization.purchaseRequests.actions.submit'))
          .grant('purchaseRequests', updateRequests)
          .grant('purchaseRequestLines', readLines),
      )
      .action('void', (action) =>
        action
          .title(title('authorization.purchaseRequests.actions.void'))
          .grant('purchaseRequests', updateRequests)
          .grant('purchaseRequestLines', readLines),
      )
      .action('convert', (action) =>
        action
          .title(title('authorization.purchaseRequests.actions.convert'))
          .grant('purchaseRequests', readRequests)
          .grant('purchaseOrders', createOrder)
          .grant('purchaseOrderLines', createOrderLines),
      ),
);
