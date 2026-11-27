import { defineCompositeResource } from '@nocobase/authorization/core';
import {
  defineDatabasePermission,
  type DatabaseCollectionDefinition,
} from '@nocobase/app-plugin-authorization/server';

/**
 * R-072 的两个业务资源（只声明，不查库、不赋权）。注册在
 * providers/authorization-resources.ts；默认授权由 seed 与 `authz upgrade-r072` 写。
 *
 * `bizDict` 有读与维护两个动作，维护只给 root；`bizOptions` 只有读，两个收窄的
 * 选项端点用它。授权没有字段这一层：读列在下面逐列声明，响应由读服务逐列拼，
 * 审计列 createdById 与任何人员信息都不在允许列里。动作清单写全，没有删除。
 * 本片没有页面，所以不做 ui.place。
 */
const NAMESPACE = 'app-local';

const title = (key: string) => ({ key, ns: NAMESPACE }) as const;

const entryTitle = title('authorization.bizDict.tables.entries');

/** 读列逐项列出；createdById 是审计列，不进任何读授权。 */
const ENTRY_READ = [
  'id', 'dictType', 'code', 'name', 'rate', 'startDate', 'endDate',
  'description', 'isDefault', 'sort', 'status', 'createdAt', 'updatedAt',
] as const;
const ENTRY_CREATE = [
  'dictType', 'code', 'name', 'rate', 'startDate', 'endDate',
  'description', 'isDefault', 'sort',
] as const;
const ENTRY_UPDATE = [
  'name', 'rate', 'startDate', 'endDate', 'description',
  'isDefault', 'sort', 'status',
] as const;

const readEntries = defineDatabasePermission((permission) =>
  permission.collection('bizDictEntries').title(entryTitle).read(ENTRY_READ),
);
const manageEntries = defineDatabasePermission((permission) =>
  permission
    .collection('bizDictEntries')
    .title(entryTitle)
    .read(ENTRY_READ)
    .create(ENTRY_CREATE)
    .update(ENTRY_UPDATE),
);

/** 动作清单写全，否则框架默认把删除也登记上；本片只停用、不删除。 */
export const BIZ_DICT_COLLECTIONS: readonly DatabaseCollectionDefinition[] = [
  { name: 'bizDictEntries', title: entryTitle, actions: ['read', 'create', 'update'] },
];

export const bizDict = defineCompositeResource('bizDict', (resource) =>
  resource
    .title(title('authorization.bizDict.title'))
    .action('view', (action) =>
      action
        .title(title('authorization.bizDict.actions.view'))
        .grant('bizDictEntries', readEntries),
    )
    .action('manage', (action) =>
      action
        .title(title('authorization.bizDict.actions.manage'))
        .grant('bizDictEntries', manageEntries),
    ),
);

/**
 * 框架要求复合动作的每条授权至少展开一条数据库授权，否则声明本身非法。
 * 选项端点走内部读服务、不经过数据库集合层，所以这里给 `bizOptions.view` 一条
 * 最窄的占位授权：`departments` 只读 id 与 title —— 正是部门选项回的两列。
 * 不授予用户表（R-028）、不授予 employees 档案表，不扩大端点之外的读取面。
 */
const readOptionDepartments = defineDatabasePermission((permission) =>
  permission
    .collection('departments')
    .title(title('authorization.departments.tables.departments'))
    .read(['id', 'title']),
);

export const bizOptions = defineCompositeResource('bizOptions', (resource) =>
  resource
    .title(title('authorization.bizOptions.title'))
    .action('view', (action) =>
      action
        .title(title('authorization.bizOptions.actions.view'))
        .grant('departments', readOptionDepartments),
    ),
);
