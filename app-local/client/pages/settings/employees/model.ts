import type { EmployeeChange, EmployeeRow } from './client.js';

/**
 * 九列网格：前七列平分，Hired on 固定 6.5rem 让日期完整可读，操作列固定 7rem。
 * 列宽写在行类里，骨架行与数据行共用，替换时列宽与行高都不抖（R-011）。
 */
export const EMPLOYEE_GRID_COLS = 'grid-cols-[repeat(7,minmax(0,1fr))_--spacing(26)_--spacing(28)]';

/** 骨架行与数据行共用同一个行类：替换时高度差为 0（R-011 稳定性）。 */
export const EMPLOYEE_ROW_CLASS = `grid min-h-11 ${EMPLOYEE_GRID_COLS} items-center gap-2 border-b px-3 py-1.5 text-sm`;

/** 数据单元格溢出省略，完整值挂 title；窄列不挡读，也不会压进相邻单元格。 */
export const EMPLOYEE_CELL_CLASS = 'min-w-0 truncate';

/** 操作单元格固定宽度、不换行、右对齐，不会横向压进 Hired on。 */
export const EMPLOYEE_ACTIONS_CLASS = 'flex w-28 shrink-0 items-center justify-end whitespace-nowrap';

/** 九个宽度互不相同，骨架行按宽度当 key 时不会撞 React key。 */
export const SKELETON_WIDTHS = [
  'w-3/4', 'w-2/3', 'w-4/5', 'w-1/2', 'w-3/5', 'w-5/6', 'w-1/3', 'w-2/5', 'w-1/4',
] as const;

/** 显示用：姓名，其次用户名，最后工号；不是个人联系信息。 */
export function employeeLabel(row: EmployeeRow): string {
  return row.name ?? row.username ?? row.employeeNo;
}

/**
 * 变动记录里的岗位值是岗位 id；查得到标题就显示标题，查不到退回原值（代码）。
 * 只映射岗位一类变更，其余变更照原样显示。
 */
export function changeDisplayValue(
  change: EmployeeChange,
  titles: ReadonlyMap<string, string>,
): { readonly from: string | null; readonly to: string | null } {
  const resolve = (value: string | null): string | null =>
    value === null ? null : (titles.get(value) ?? value);
  if (change.kind !== 'position') return { from: change.fromValue, to: change.toValue };
  return { from: resolve(change.fromValue), to: resolve(change.toValue) };
}

/** 服务端把多条离职前检查理由用分号拼成一个字符串；页面分行显示。 */
export function splitReasons(value: string | undefined): readonly string[] {
  if (!value) return [];
  return value
    .split(/[;；]/u)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}
