import { defineCompositeResource } from '@nocobase/authorization/core';
import {
  defineDatabasePermission,
  type DatabaseCollectionDefinition,
} from '@nocobase/app-plugin-authorization/server';

/**
 * R-011 员工管理的业务资源声明（R-013 七步里的「声明」）。
 *
 * 四张表按 R-011 的数据模型：档案、只追加的变动记录、岗位字典、职级字典。
 * 部门成员归 R-012，账号归框架的用户资源，都不在这里声明。
 *
 * 列按 R-011.md:232-234/239 的逐列口径收窄，照 R-013 的做法把写权限限定到
 * 端点真正会写的列：授权 policy 没有字段这一层，seed 事后收窄不了
 * （@nocobase/app-plugin-authorization/dist/server/database/builders.d.ts:5）。
 * 读列还须带上筛选与排序列，否则端点会被 FIELD_NOT_ALLOWED 拒。
 *
 * - `view`   四张表各读一组列，列外不带（尤其没有邮箱、手机、证件号、住址、
 *            紧急联系人——这些数据模型里就没有）
 * - `manage` 档案读、建、改各自的列；岗位与职级字典读、建、改；变动记录只建不读、
 *            不更新也不删除
 *
 * 四张表都不登记删除：档案是软删除，字典只停用，变动记录只追加。不写动作清单
 * 的话框架默认把删除也登记上，管理员就能经接口给角色写一条「可以删员工档案」。
 * 表不进角色编辑器（没有 placement），只供 `employees` 的两个业务动作展开。
 *
 * 动作与表的标识符取设计文档：资源 `employees`，动作「查看员工」「管理员工」
 * 沿用 R-012/R-013 的 `view` / `manage` 英文标识，中文作为词条。
 *
 * 这里只是纯声明，不注册、不查库、不赋权。注册在 providers/authorization-resources.ts，
 * 业务角色的 seed 这一版不给它任何授权（只有 root 能看能改）。四张表由后面的迁移片建；
 * 迁移落地前授权检查里这些表带 UNKNOWN_DATABASE_RESOURCE_OR_ACTION、表级授权不生效，
 * 本片没有端点，这是预期的，不是缺陷。
 */
const NAMESPACE = 'app-local';

const profileTitle = {
  key: 'authorization.employees.tables.employees',
  ns: NAMESPACE,
} as const;

const changesTitle = {
  key: 'authorization.employees.tables.changes',
  ns: NAMESPACE,
} as const;

const positionsTitle = {
  key: 'authorization.employees.tables.positions',
  ns: NAMESPACE,
} as const;

const gradesTitle = {
  key: 'authorization.employees.tables.jobGrades',
  ns: NAMESPACE,
} as const;

/**
 * 列表与详情共用一个读权限：列表八列中姓名、用户名、主部门名称现取，不落在档案表上；
 * 详情再带离职日期与上级标识。createdAt/updatedAt 不进对外读列。
 */
const PROFILE_READ_FIELDS = [
  'id',
  'userId',
  'employeeNo',
  'positionId',
  'gradeId',
  'reportsToUserId',
  'status',
  'hiredOn',
  'leftOn',
] as const;

/** 入职与补档会写入的列：工号与在职状态由本条的服务生成，不在请求体里。 */
const PROFILE_CREATE_FIELDS = [
  'userId',
  'employeeNo',
  'positionId',
  'gradeId',
  'reportsToUserId',
  'hiredOn',
  'status',
] as const;

/** 调岗、调级、换上级、离职、复聘会改的列。 */
const PROFILE_UPDATE_FIELDS = [
  'positionId',
  'gradeId',
  'reportsToUserId',
  'status',
  'leftOn',
  'hiredOn',
] as const;

/** 变动记录只回契约里的六项加记录时间，不回档案主键。 */
const CHANGES_READ_FIELDS = [
  'userId',
  'kind',
  'fromValue',
  'toValue',
  'occurredOn',
  'note',
  'actorId',
  'createdAt',
] as const;

/** 记一行变动：主键与记录时间由数据库生成，不在写入列里。 */
const CHANGES_CREATE_FIELDS = [
  'userId',
  'kind',
  'fromValue',
  'toValue',
  'occurredOn',
  'note',
  'actorId',
] as const;

/** 岗位字典：编码在建时定、不能改；职级字典另有 rank。 */
const POSITION_READ_FIELDS = ['id', 'title', 'active', 'sortOrder'] as const;
const POSITION_UPDATE_FIELDS = ['title', 'active', 'sortOrder'] as const;
const GRADE_READ_FIELDS = ['id', 'title', 'rank', 'active'] as const;
const GRADE_UPDATE_FIELDS = ['title', 'rank', 'active'] as const;

const readProfile = defineDatabasePermission((permission) =>
  permission
    .collection('employees')
    .title(profileTitle)
    .read(PROFILE_READ_FIELDS),
);

const readChanges = defineDatabasePermission((permission) =>
  permission
    .collection('employeeChanges')
    .title(changesTitle)
    .read(CHANGES_READ_FIELDS),
);

const readPositions = defineDatabasePermission((permission) =>
  permission
    .collection('positions')
    .title(positionsTitle)
    .read(POSITION_READ_FIELDS),
);

const readGrades = defineDatabasePermission((permission) =>
  permission
    .collection('jobGrades')
    .title(gradesTitle)
    .read(GRADE_READ_FIELDS),
);

/** 管理：档案分别登记读、建、改三组的列，不删（离职是软删除）。 */
const manageProfile = defineDatabasePermission((permission) =>
  permission
    .collection('employees')
    .title(profileTitle)
    .read(PROFILE_READ_FIELDS)
    .create(PROFILE_CREATE_FIELDS)
    .update(PROFILE_UPDATE_FIELDS),
);

/** 变动记录在管理里只建不读、不追加其他列：只追加，没有更新和删除接口。 */
const appendChanges = defineDatabasePermission((permission) =>
  permission
    .collection('employeeChanges')
    .title(changesTitle)
    .create(CHANGES_CREATE_FIELDS),
);

/** 字典只停用不删除：读、建、改各一组列，不删。 */
const managePositions = defineDatabasePermission((permission) =>
  permission
    .collection('positions')
    .title(positionsTitle)
    .read(POSITION_READ_FIELDS)
    .create(POSITION_READ_FIELDS)
    .update(POSITION_UPDATE_FIELDS),
);

const manageGrades = defineDatabasePermission((permission) =>
  permission
    .collection('jobGrades')
    .title(gradesTitle)
    .read(GRADE_READ_FIELDS)
    .create(GRADE_READ_FIELDS)
    .update(GRADE_UPDATE_FIELDS),
);

/**
 * 四张表的裸读写登记。动作清单必须写明，否则框架默认把删除也登记上。
 * 四张表不进角色编辑器（没有 placement），只供 `employees` 的两个业务动作展开。
 */
export const EMPLOYEE_COLLECTIONS: readonly DatabaseCollectionDefinition[] = [
  {
    name: 'employees',
    title: profileTitle,
    actions: ['read', 'create', 'update'],
  },
  {
    name: 'employeeChanges',
    title: changesTitle,
    actions: ['read', 'create'],
  },
  {
    name: 'positions',
    title: positionsTitle,
    actions: ['read', 'create', 'update'],
  },
  {
    name: 'jobGrades',
    title: gradesTitle,
    actions: ['read', 'create', 'update'],
  },
];

export const employees = defineCompositeResource('employees', (resource) =>
  resource
    .title({ key: 'authorization.employees.title', ns: NAMESPACE })
    .action('view', (action) =>
      action
        .title({ key: 'authorization.employees.actions.view', ns: NAMESPACE })
        .grant('employees', readProfile)
        .grant('employeeChanges', readChanges)
        .grant('positions', readPositions)
        .grant('jobGrades', readGrades),
    )
    .action('manage', (action) =>
      action
        .title({ key: 'authorization.employees.actions.manage', ns: NAMESPACE })
        .grant('employees', manageProfile)
        .grant('employeeChanges', appendChanges)
        .grant('positions', managePositions)
        .grant('jobGrades', manageGrades),
    ),
);
