import { defineCompositeResource } from '@nocobase/authorization/core';
import {
  defineDatabasePermission,
  type DatabaseCollectionDefinition,
} from '@nocobase/app-plugin-authorization/server';

/**
 * R-070 IQC：只声明资源与动作，不查库、不赋权；本片没有页面，不进角色编辑器目录。
 * 六个动作按设计拆开：仓管只拿最窄的 receiveView，作废只给质量主管。
 */
const NAMESPACE = 'app-local';
const title = (key: string) => ({ key, ns: NAMESPACE }) as const;

const orderTitle = title('authorization.inspectionOrders.tables.orders');
const lineTitle = title('authorization.inspectionOrders.tables.lines');

const ORDER_READ = [
  'id', 'docNo', 'inspectionDate', 'inspectorUserId', 'purchaseOrderId',
  'supplierId', 'status', 'remark', 'createdById', 'completedAt', 'voidedAt',
  'createdAt', 'updatedAt',
] as const;
const ORDER_WRITE = [
  'inspectionDate', 'inspectorUserId', 'purchaseOrderId', 'supplierId',
  'status', 'remark', 'completedAt', 'voidedAt', 'createdAt', 'updatedAt',
] as const;
const LINE_READ = [
  'id', 'orderId', 'itemId', 'purchaseQty', 'inspectionTypeCode', 'receivedQty',
  'inspectionQty', 'qualifiedQty', 'unqualifiedQty', 'releasableQty', 'returnQty',
  'samplingQty', 'samplingQualifiedQty', 'lossQty', 'retainedQty', 'note',
] as const;

const readOrders = defineDatabasePermission((permission) =>
  permission.collection('inspectionOrders').title(orderTitle).read(ORDER_READ),
);
const writeOrders = defineDatabasePermission((permission) =>
  permission
    .collection('inspectionOrders')
    .title(orderTitle)
    .read(ORDER_READ)
    .create(ORDER_WRITE)
    .update(ORDER_WRITE),
);
const readLines = defineDatabasePermission((permission) =>
  permission.collection('inspectionLines').title(lineTitle).read(LINE_READ),
);
const writeLines = defineDatabasePermission((permission) =>
  permission
    .collection('inspectionLines')
    .title(lineTitle)
    .read(LINE_READ)
    .create(LINE_READ)
    .update(LINE_READ),
);

/** 动作清单写全，否则框架会把删除也登记上；检验单与明细只作废、不删除。 */
export const IQC_COLLECTIONS: readonly DatabaseCollectionDefinition[] = [
  { name: 'inspectionOrders', title: orderTitle, actions: ['read', 'create', 'update'] },
  { name: 'inspectionLines', title: lineTitle, actions: ['read', 'create', 'update'] },
];

export const inspectionOrders = defineCompositeResource('inspectionOrders', (resource) =>
  resource
    .title(title('authorization.inspectionOrders.title'))
    .action('view', (action) =>
      action
        .title(title('authorization.inspectionOrders.actions.view'))
        .grant('inspectionOrders', readOrders)
        .grant('inspectionLines', readLines),
    )
    .action('create', (action) =>
      action
        .title(title('authorization.inspectionOrders.actions.create'))
        .grant('inspectionOrders', writeOrders)
        .grant('inspectionLines', writeLines),
    )
    .action('update', (action) =>
      action
        .title(title('authorization.inspectionOrders.actions.update'))
        .grant('inspectionOrders', writeOrders)
        .grant('inspectionLines', writeLines),
    )
    .action('complete', (action) =>
      action
        .title(title('authorization.inspectionOrders.actions.complete'))
        .grant('inspectionOrders', writeOrders)
        .grant('inspectionLines', writeLines),
    )
    .action('void', (action) =>
      action
        .title(title('authorization.inspectionOrders.actions.void'))
        .grant('inspectionOrders', writeOrders),
    )
    // 仓管建采购入库单用的窄读：只回可入库列，不回备注、单价、检验人与联系方式。
    .action('receiveView', (action) =>
      action
        .title(title('authorization.inspectionOrders.actions.receiveView'))
        .grant('inspectionOrders', readOrders)
        .grant('inspectionLines', readLines),
    ),
);
