import type { EmployeeRow } from './client.js';

/** 骨架行与数据行共用同一个行类：替换时高度差为 0（R-011 稳定性）。 */
export const EMPLOYEE_ROW_CLASS = 'grid min-h-11 grid-cols-9 items-center gap-2 border-b px-3 py-1.5 text-sm';

/** 九个宽度互不相同，骨架行按宽度当 key 时不会撞 React key。 */
export const SKELETON_WIDTHS = [
  'w-3/4', 'w-2/3', 'w-4/5', 'w-1/2', 'w-3/5', 'w-5/6', 'w-1/3', 'w-2/5', 'w-1/4',
] as const;

/** 显示用：姓名，其次用户名，最后工号；不是个人联系信息。 */
export function employeeLabel(row: EmployeeRow): string {
  return row.name ?? row.username ?? row.employeeNo;
}

/** 服务端把多条离职前检查理由用分号拼成一个字符串；页面分行显示。 */
export function splitReasons(value: string | undefined): readonly string[] {
  if (!value) return [];
  return value
    .split(/[;；]/u)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}
