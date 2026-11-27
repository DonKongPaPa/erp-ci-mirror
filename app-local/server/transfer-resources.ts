import { defineCompositeResource } from '@nocobase/authorization/core';
import {
  defineDatabasePermission,
  type DatabaseCollectionDefinition,
} from '@nocobase/app-plugin-authorization/server';

/** R-020 波 1：调拨单业务资源。只声明，不查库、不赋权；没有页面，不进角色编辑器目录。 */
const NAMESPACE = 'app-local';
const title = (key: string) => ({ key, ns: NAMESPACE }) as const;

const docTitle = title('authorization.transfers.tables.docs');
const lineTitle = title('authorization.transfers.tables.lines');

const DOC_READ = [
  'id', 'docNo', 'docDate', 'transferInWarehouseId', 'transferOutWarehouseId',
  'handlerUserId', 'status', 'remark', 'createdById', 'createdAt', 'updatedAt',
] as const;
const DOC_WRITE = [
  'transferInWarehouseId', 'transferOutWarehouseId', 'docDate', 'handlerUserId',
  'status', 'remark', 'createdAt', 'updatedAt',
] as const;
const LINE_READ = ['id', 'docId', 'itemId', 'qty', 'transferQty', 'note'] as const;
const LINE_WRITE = ['transferQty', 'note'] as const;

const readDocs = defineDatabasePermission((permission) =>
  permission.collection('transferDocs').title(docTitle).read(DOC_READ),
);
const writeDocs = defineDatabasePermission((permission) =>
  permission
    .collection('transferDocs')
    .title(docTitle)
    .read(DOC_READ)
    .create(DOC_WRITE)
    .update(DOC_WRITE),
);
const readLines = defineDatabasePermission((permission) =>
  permission.collection('transferDocLines').title(lineTitle).read(LINE_READ),
);
const writeLines = defineDatabasePermission((permission) =>
  permission
    .collection('transferDocLines')
    .title(lineTitle)
    .read(LINE_READ)
    .create(LINE_READ)
    .update(LINE_WRITE),
);

/** 动作清单写全，框架默认会把删除也登记上；单据与明细都不提供删除。 */
export const TRANSFER_COLLECTIONS: readonly DatabaseCollectionDefinition[] = [
  { name: 'transferDocs', title: docTitle, actions: ['read', 'create', 'update'] },
  { name: 'transferDocLines', title: lineTitle, actions: ['read', 'create', 'update'] },
];

export const transfers = defineCompositeResource('transfers', (resource) =>
  resource
    .title(title('authorization.transfers.title'))
    .action('view', (action) =>
      action
        .title(title('authorization.transfers.actions.view'))
        .grant('transferDocs', readDocs)
        .grant('transferDocLines', readLines),
    )
    .action('create', (action) =>
      action
        .title(title('authorization.transfers.actions.create'))
        .grant('transferDocs', writeDocs)
        .grant('transferDocLines', writeLines),
    )
    .action('update', (action) =>
      action
        .title(title('authorization.transfers.actions.update'))
        .grant('transferDocs', writeDocs)
        .grant('transferDocLines', writeLines),
    )
    .action('post', (action) =>
      action
        .title(title('authorization.transfers.actions.post'))
        .grant('transferDocs', writeDocs)
        .grant('transferDocLines', writeLines),
    )
    .action('void', (action) =>
      action
        .title(title('authorization.transfers.actions.void'))
        .grant('transferDocs', writeDocs),
    ),
);
