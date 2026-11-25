import { defineCompositeResource } from '@nocobase/authorization/core';
import {
  defineDatabasePermission,
  type DatabaseCollectionDefinition,
} from '@nocobase/app-plugin-authorization/server';

/**
 * R-012 部门管理的业务资源声明（R-013 七步里的「声明」）。
 *
 * 两张读写的表与一张只追加的变动记录表：
 *
 * - `view`   读三张表 —— 树、成员、变动记录
 * - `manage` 读三张表；部门可建可改（没有删除端点）；成员可建可改可删
 *   （移出成员、合并与批量调动都会删成员行）；变动记录只追加，不给改与删
 *
 * 部门表不登记删除：设计明确没有删除端点，业务记录上的 departmentId 要一直指着它。
 * 变动记录不登记 update/delete：这张表只追加，「库里没有更新或删除这张表的路径」
 * 是验收第 14 条的一部分。
 *
 * 这里只是纯声明，不注册、不查库、不赋权。注册在 providers/authorization-resources.ts，
 * 业务角色的 seed 这一版不给它任何授权（只有 root 能看能改）。
 */
const NAMESPACE = 'app-local';

const departmentTitle = {
  key: 'authorization.departments.tables.departments',
  ns: NAMESPACE,
} as const;

const memberTitle = {
  key: 'authorization.departments.tables.members',
  ns: NAMESPACE,
} as const;

const historyTitle = {
  key: 'authorization.departments.tables.history',
  ns: NAMESPACE,
} as const;

const readDepartments = defineDatabasePermission((permission) =>
  permission.collection('departments').title(departmentTitle).read('*'),
);

const readMembers = defineDatabasePermission((permission) =>
  permission.collection('departmentMembers').title(memberTitle).read('*'),
);

const readHistory = defineDatabasePermission((permission) =>
  permission
    .collection('departmentMemberHistory')
    .title(historyTitle)
    .read('*'),
);

/** 管理：部门读写不删；成员读写不删之外再加删（移出与合并会删成员行）。 */
const manageDepartments = defineDatabasePermission((permission) =>
  permission
    .collection('departments')
    .title(departmentTitle)
    .read('*')
    .create('*')
    .update('*'),
);

const manageMembers = defineDatabasePermission((permission) =>
  permission
    .collection('departmentMembers')
    .title(memberTitle)
    .read('*')
    .create('*')
    .update('*')
    .delete(),
);

/** 变动记录在管理里也只读与建：只追加，没有更新和删除接口。 */
const appendHistory = defineDatabasePermission((permission) =>
  permission
    .collection('departmentMemberHistory')
    .title(historyTitle)
    .read('*')
    .create('*'),
);

/**
 * 三张表的裸读写登记。动作清单必须写明：不写的话框架默认把删除也登记上，
 * 管理员就能经接口给角色写一条「可以删部门」。三张表不进角色编辑器（没有 placement），
 * 只供 `departments` 的两个业务动作展开。
 */
export const DEPARTMENT_COLLECTIONS: readonly DatabaseCollectionDefinition[] = [
  {
    name: 'departments',
    title: departmentTitle,
    actions: ['read', 'create', 'update'],
  },
  {
    name: 'departmentMembers',
    title: memberTitle,
    actions: ['read', 'create', 'update', 'delete'],
  },
  {
    name: 'departmentMemberHistory',
    title: historyTitle,
    actions: ['read', 'create'],
  },
];

export const departments = defineCompositeResource('departments', (resource) =>
  resource
    .title({ key: 'authorization.departments.title', ns: NAMESPACE })
    .action('view', (action) =>
      action
        .title({ key: 'authorization.departments.actions.view', ns: NAMESPACE })
        .grant('departments', readDepartments)
        .grant('departmentMembers', readMembers)
        .grant('departmentMemberHistory', readHistory),
    )
    .action('manage', (action) =>
      action
        .title({ key: 'authorization.departments.actions.manage', ns: NAMESPACE })
        .grant('departments', manageDepartments)
        .grant('departmentMembers', manageMembers)
        .grant('departmentMemberHistory', appendHistory),
    ),
);
