import { defineCompositeResource } from '@nocobase/authorization/core';
import {
  defineDatabasePermission,
  type DatabaseCollectionDefinition,
} from '@nocobase/app-plugin-authorization/server';

/**
 * R-020 复刻波 2 加片二：退货单业务资源。两张单各有自己的动作；发起、过账、
 * 财务窄读分开授权。只声明、不查库、不赋权；没有页面，不进角色编辑器目录。
 */
const NAMESPACE = 'app-local';
const title = (key: string) => ({ key, ns: NAMESPACE }) as const;

const docTitle = title('authorization.returnDocs.tables.docs');
const lineTitle = title('authorization.returnDocs.tables.lines');

const DOC_READ = [
  'id', 'docNo', 'docType', 'sourceType', 'sourceId', 'partnerId',
  'handlerUserId', 'status', 'remark', 'createdById', 'postedAt',
  'postedById', 'createdAt', 'updatedAt',
] as const;
const DOC_WRITE = ['handlerUserId', 'status', 'remark', 'createdAt', 'updatedAt'] as const;
const LINE_READ = [
  'id', 'docId', 'sourceLineId', 'itemId', 'warehouseId', 'batchNo',
  'qty', 'returnQty', 'note',
] as const;
const LINE_WRITE = ['returnQty', 'note'] as const;

const readDocs = defineDatabasePermission((permission) =>
  permission.collection('returnDocs').title(docTitle).read(DOC_READ),
);
const writeDocs = defineDatabasePermission((permission) =>
  permission
    .collection('returnDocs')
    .title(docTitle)
    .read(DOC_READ)
    .create(DOC_WRITE)
    .update(DOC_WRITE),
);
const readLines = defineDatabasePermission((permission) =>
  permission.collection('returnDocLines').title(lineTitle).read(LINE_READ),
);
const writeLines = defineDatabasePermission((permission) =>
  permission
    .collection('returnDocLines')
    .title(lineTitle)
    .read(LINE_READ)
    .create(LINE_READ)
    .update(LINE_WRITE)
    .delete(),
);

/** 动作清单写全：框架默认会把删除也登记上；单据与明细都不提供删除。 */
export const RETURN_COLLECTIONS: readonly DatabaseCollectionDefinition[] = [
  { name: 'returnDocs', title: docTitle, actions: ['read', 'create', 'update'] },
  { name: 'returnDocLines', title: lineTitle, actions: ['read', 'create', 'update', 'delete'] },
];

export const purchaseReturns = defineCompositeResource('purchaseReturns', (resource) =>
  resource
    .title(title('authorization.purchaseReturns.title'))
    .action('view', (action) =>
      action.title(title('authorization.purchaseReturns.actions.view'))
        .grant('returnDocs', readDocs).grant('returnDocLines', readLines))
    .action('create', (action) =>
      action.title(title('authorization.purchaseReturns.actions.create'))
        .grant('returnDocs', writeDocs).grant('returnDocLines', writeLines))
    .action('update', (action) =>
      action.title(title('authorization.purchaseReturns.actions.update'))
        .grant('returnDocs', writeDocs).grant('returnDocLines', writeLines))
    .action('post', (action) =>
      action.title(title('authorization.purchaseReturns.actions.post'))
        .grant('returnDocs', writeDocs).grant('returnDocLines', writeLines))
    .action('void', (action) =>
      action.title(title('authorization.purchaseReturns.actions.void'))
        .grant('returnDocs', writeDocs))
    .action('postView', (action) =>
      action.title(title('authorization.purchaseReturns.actions.postView'))
        .grant('returnDocs', readDocs).grant('returnDocLines', readLines)),
);

export const salesReturns = defineCompositeResource('salesReturns', (resource) =>
  resource
    .title(title('authorization.salesReturns.title'))
    .action('view', (action) =>
      action.title(title('authorization.salesReturns.actions.view'))
        .grant('returnDocs', readDocs).grant('returnDocLines', readLines))
    .action('create', (action) =>
      action.title(title('authorization.salesReturns.actions.create'))
        .grant('returnDocs', writeDocs).grant('returnDocLines', writeLines))
    .action('update', (action) =>
      action.title(title('authorization.salesReturns.actions.update'))
        .grant('returnDocs', writeDocs).grant('returnDocLines', writeLines))
    .action('post', (action) =>
      action.title(title('authorization.salesReturns.actions.post'))
        .grant('returnDocs', writeDocs).grant('returnDocLines', writeLines))
    .action('void', (action) =>
      action.title(title('authorization.salesReturns.actions.void'))
        .grant('returnDocs', writeDocs))
    .action('financeView', (action) =>
      action.title(title('authorization.salesReturns.actions.financeView'))
        .grant('returnDocs', readDocs))
    .action('postView', (action) =>
      action.title(title('authorization.salesReturns.actions.postView'))
        .grant('returnDocs', readDocs).grant('returnDocLines', readLines)),
);
