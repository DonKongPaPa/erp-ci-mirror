import { defineCompositeResource } from '@nocobase/authorization/core';
import {
  defineDatabasePermission,
  type DatabaseCollectionDefinition,
} from '@nocobase/app-plugin-authorization/server';

/**
 * R-025 班次定义的业务资源声明（只有声明，不注册、不查库、不赋权）。
 *
 * 班次定义不是人员信息：一张 `shifts` 表，十列全是班次自己的事实，没有账号、姓名、
 * 邮箱、部门或操作人。所以它是独立资源，不并入 `employees`。注册在
 * providers/authorization-resources.ts；默认授权由 seed 与 `authz upgrade-r025` 写。
 *
 * 授权没有字段这一层，写权限只能限定到端点会写的列（同 employees-resources.ts:13-15）。
 * - `view` 读十列，列表的筛选/排序列也在这十列里；
 * - `manage` 读十列、建七列（编码、名称、起止、休息段与排序；active 用默认值、
 *   时间戳由服务写）、改三列（名称、排序、停用标记）。`PATCH` 不写编码与起止，
 *   所以 update 里没有它们；停用与启用写 `active`，所以在。
 *
 * 动作清单写全，不登记删除：班次只停用不删除（R-025.md「理由」第 4 条）。
 * 表不进角色编辑器（没有 placement），只供 `shifts` 的两个业务动作展开。
 */
const NAMESPACE = 'app-local';

const shiftsTitle = {
  key: 'authorization.shifts.tables.shifts',
  ns: NAMESPACE,
} as const;

/** 响应与列表共用的十列：不含任何人员信息。 */
const SHIFT_READ_FIELDS = [
  'id',
  'title',
  'startMinute',
  'endMinute',
  'breakStartMinute',
  'breakEndMinute',
  'active',
  'sortOrder',
  'createdAt',
  'updatedAt',
] as const;

/** 建时由请求体给的列；时间戳与 active 由服务与默认值写，不在请求体里。 */
const SHIFT_CREATE_FIELDS = [
  'id',
  'title',
  'startMinute',
  'endMinute',
  'breakStartMinute',
  'breakEndMinute',
  'sortOrder',
] as const;

/** PATCH 只写名称与排序；停用与启用写 active。编码与起止、休息段不可改。 */
const SHIFT_UPDATE_FIELDS = ['title', 'sortOrder', 'active'] as const;

const readShifts = defineDatabasePermission((permission) =>
  permission.collection('shifts').title(shiftsTitle).read(SHIFT_READ_FIELDS),
);

const manageShifts = defineDatabasePermission((permission) =>
  permission
    .collection('shifts')
    .title(shiftsTitle)
    .read(SHIFT_READ_FIELDS)
    .create(SHIFT_CREATE_FIELDS)
    .update(SHIFT_UPDATE_FIELDS),
);

/** 动作清单必须写明，否则框架默认把删除也登记上。 */
export const SHIFT_COLLECTIONS: readonly DatabaseCollectionDefinition[] = [
  {
    name: 'shifts',
    title: shiftsTitle,
    actions: ['read', 'create', 'update'],
  },
];

export const shifts = defineCompositeResource('shifts', (resource) =>
  resource
    .title({ key: 'authorization.shifts.title', ns: NAMESPACE })
    .action('view', (action) =>
      action
        .title({ key: 'authorization.shifts.actions.view', ns: NAMESPACE })
        .grant('shifts', readShifts),
    )
    .action('manage', (action) =>
      action
        .title({ key: 'authorization.shifts.actions.manage', ns: NAMESPACE })
        .grant('shifts', manageShifts),
    ),
);
