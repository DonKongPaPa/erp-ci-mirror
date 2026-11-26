import type { EmployeeRow } from './client.js';

/**
 * 列表逐列的形状。服务端只回这八列（外加 `userId` 作详情标识），没有邮箱；
 * 这里不按用户名或工号再去查用户表补字段（主会话 2026-11-26 的裁决）。
 */
export interface EmployeeColumn {
  readonly id: string;
  readonly headerKey: string;
  readonly value: (row: EmployeeRow) => string | null;
}

/** 列定义是模块级常量：重渲染不新建，表格列宽与表头不会抖（R-011 稳定性）。 */
export const EMPLOYEE_COLUMNS: readonly EmployeeColumn[] = [
  { id: 'employeeNo', headerKey: 'employees.columns.employeeNo', value: (row) => row.employeeNo },
  { id: 'name', headerKey: 'employees.columns.name', value: (row) => row.name },
  { id: 'username', headerKey: 'employees.columns.username', value: (row) => row.username },
  {
    id: 'primaryDepartment',
    headerKey: 'employees.columns.primaryDepartment',
    value: (row) => row.primaryDepartmentName,
  },
  { id: 'position', headerKey: 'employees.columns.position', value: (row) => row.positionName },
  { id: 'grade', headerKey: 'employees.columns.grade', value: (row) => row.gradeName },
  {
    id: 'status',
    headerKey: 'employees.columns.status',
    value: (row) => (row.status === 'active' ? 'employees.active' : 'employees.left'),
  },
  { id: 'hiredOn', headerKey: 'employees.columns.hiredOn', value: (row) => row.hiredOn },
];

/** 供组件取用；返回同一个模块级引用。 */
export function employeeColumns(): readonly EmployeeColumn[] {
  return EMPLOYEE_COLUMNS;
}
