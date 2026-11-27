import { defineDatabasePermission } from '@nocobase/app-plugin-authorization/server';
import type { DatabaseCollectionDefinition } from '@nocobase/app-plugin-authorization/server';

/** R-021 加片：附件表只在授权模型里登记列，不给业务角色动作；读写都走自己的端点。 */
const NAMESPACE = 'app-local';
const docTitle = { key: 'authorization.docFiles.table', ns: NAMESPACE } as const;

export const DOC_FILE_COLLECTIONS: readonly DatabaseCollectionDefinition[] = [
  {
    name: 'docFiles',
    title: docTitle,
    actions: ['read', 'create', 'update'],
  },
];

export const docFileColumns = defineDatabasePermission((permission) =>
  permission
    .collection('docFiles')
    .title(docTitle)
    .read(['id', 'ownerType', 'ownerId', 'name', 'contentType', 'size', 'createdAt'])
    .create(['ownerType', 'ownerId', 'name', 'contentType', 'size', 'createdAt'])
    .update(['ownerId']),
);
