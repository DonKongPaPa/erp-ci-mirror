import {
  defineRecordAccess,
  type RecordAccessDefinition,
} from '@nocobase/authorization/core';
import {
  anyScope,
  condition,
  type DatabaseScope,
} from '@nocobase/app-plugin-authorization/server';

import type { DepartmentService } from './providers/departments.js';

/**
 * R-013 的两把部门范围键。
 *
 * 解析规则：读主体所属的部门集合，返回「记录的 departmentId 等于其中某一个」的
 * 等值条件并集。框架的条件里没有 `$in`，多部门只能展开成等值的「或」。
 * 主体没有部门、或主体不是用户时返回 false：决策仍是放行，范围换成空结果，
 * 绝不返回全部。
 *
 * 解析器不直接查部门表，只依赖 R-012 的 DepartmentService，由 provider 在 boot()
 * 里从 departmentServiceToken 注入。
 *
 * 只对带 `departmentId` 列的表生效：`collections` 用 '*'（框架要求至少声明一张表），
 * `requiredFields` 让工作区只在这些表上提供这把键；表还没有这一列时，范围解析出来的
 * 条件也会被集合的字段校验拒绝。部门表落地后这些键自动开始有数据，不用改代码。
 */
export const MY_DEPARTMENTS = 'org.myDepartments';
export const MY_DEPARTMENTS_AND_BELOW = 'org.myDepartmentsAndBelow';

const NAMESPACE = 'app-local';

/** db 适配器读取的适用性元数据，不在授权库的公开类型里。 */
interface DepartmentRecordAccessDefinition extends RecordAccessDefinition {
  readonly requiredFields?: readonly string[];
}

/** 等值条件并集；ids 为空时 anyScope 返回 false，正好是「一条都不选」。 */
function departmentsScope(ids: readonly string[]): DatabaseScope {
  return anyScope(ids.map((id) => condition('departmentId', '$eq', id)));
}

export function defineDepartmentRecordAccess(
  departmentService: DepartmentService,
): readonly DepartmentRecordAccessDefinition[] {
  const myDepartments = defineRecordAccess(MY_DEPARTMENTS, (access) =>
    access
      .title({ key: 'authorization.recordAccess.myDepartments', ns: NAMESPACE })
      .collections('*')
      .resolver(async ({ principal }) => {
        if (principal.type !== 'user') {
          return false;
        }
        return departmentsScope(
          await departmentService.departmentIdsOfUser(principal.id),
        );
      }),
  ).build();

  const myDepartmentsAndBelow = defineRecordAccess(
    MY_DEPARTMENTS_AND_BELOW,
    (access) =>
      access
        .title({
          key: 'authorization.recordAccess.myDepartmentsAndBelow',
          ns: NAMESPACE,
        })
        .collections('*')
        .resolver(async ({ principal }) => {
          if (principal.type !== 'user') {
            return false;
          }
          const departments = await departmentService.departmentIdsOfUser(
            principal.id,
          );
          const subtrees = await Promise.all(
            departments.map((id) => departmentService.subtreeIds(id)),
          );
          return departmentsScope([...new Set(subtrees.flat())]);
        }),
  ).build();

  return [
    { ...myDepartments, requiredFields: ['departmentId'] },
    { ...myDepartmentsAndBelow, requiredFields: ['departmentId'] },
  ];
}
