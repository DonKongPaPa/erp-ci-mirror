import { defineCompositeResource } from '@nocobase/authorization/core';
import {
  defineDatabasePermission,
  type DatabaseCollectionDefinition,
} from '@nocobase/app-plugin-authorization/server';

/** R-020 波 1：盘点单业务资源。只声明，不查库、不赋权；没有页面，不进角色编辑器目录。 */
const NAMESPACE = 'app-local';
const title = (key: string) => ({ key, ns: NAMESPACE }) as const;

const docTitle = title('authorization.stocktakings.tables.docs');
const lineTitle = title('authorization.stocktakings.tables.lines');

const DOC_READ = [
  'id', 'docNo', 'docDate', 'warehouseId', 'handlerUserId', 'supervisorUserId',
  'status', 'remark', 'createdById', 'createdAt', 'updatedAt',
] as const;
const DOC_WRITE = [
  'warehouseId', 'handlerUserId', 'supervisorUserId', 'status', 'remark',
  'createdAt', 'updatedAt',
] as const;
const LINE_READ = [
  'id', 'docId', 'itemId', 'systemQty', 'actualQty', 'deltaQty', 'result', 'note',
] as const;
const LINE_WRITE = ['actualQty', 'deltaQty', 'result', 'note'] as const;

const readDocs = defineDatabasePermission((permission) =>
  permission.collection('stocktakingDocs').title(docTitle).read(DOC_READ),
);
const writeDocs = defineDatabasePermission((permission) =>
  permission
    .collection('stocktakingDocs')
    .title(docTitle)
    .read(DOC_READ)
    .create(DOC_WRITE)
    .update(DOC_WRITE),
);
const finishDocs = defineDatabasePermission((permission) =>
  permission.collection('stocktakingDocs').title(docTitle).read(DOC_READ).update(DOC_WRITE),
);
const readLines = defineDatabasePermission((permission) =>
  permission.collection('stocktakingDocLines').title(lineTitle).read(LINE_READ),
);
const writeLines = defineDatabasePermission((permission) =>
  permission
    .collection('stocktakingDocLines')
    .title(lineTitle)
    .read(LINE_READ)
    .create(LINE_READ)
    .update(LINE_WRITE),
);
const finishLines = defineDatabasePermission((permission) =>
  permission
    .collection('stocktakingDocLines')
    .title(lineTitle)
    .read(LINE_READ)
    .update(LINE_WRITE),
);

/** 动作清单写全，框架默认会把删除也登记上；单据与明细都不提供删除。 */
export const STOCKTAKING_COLLECTIONS: readonly DatabaseCollectionDefinition[] = [
  { name: 'stocktakingDocs', title: docTitle, actions: ['read', 'create', 'update'] },
  { name: 'stocktakingDocLines', title: lineTitle, actions: ['read', 'create', 'update'] },
];

export const stocktakings = defineCompositeResource('stocktakings', (resource) =>
  resource
    .title(title('authorization.stocktakings.title'))
    .action('view', (action) =>
      action
        .title(title('authorization.stocktakings.actions.view'))
        .grant('stocktakingDocs', readDocs)
        .grant('stocktakingDocLines', readLines),
    )
    .action('create', (action) =>
      action
        .title(title('authorization.stocktakings.actions.create'))
        .grant('stocktakingDocs', writeDocs)
        .grant('stocktakingDocLines', writeLines),
    )
    .action('update', (action) =>
      action
        .title(title('authorization.stocktakings.actions.update'))
        .grant('stocktakingDocs', writeDocs)
        .grant('stocktakingDocLines', writeLines),
    )
    .action('finish', (action) =>
      action
        .title(title('authorization.stocktakings.actions.finish'))
        .grant('stocktakingDocs', finishDocs)
        .grant('stocktakingDocLines', finishLines),
    )
    .action('void', (action) =>
      action
        .title(title('authorization.stocktakings.actions.void'))
        .grant('stocktakingDocs', finishDocs),
    ),
);
