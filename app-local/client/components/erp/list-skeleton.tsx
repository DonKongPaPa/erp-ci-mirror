import type { CellContext, ColumnDef } from '@tanstack/react-table';

import { Skeleton } from '#components/ui/skeleton';
import { cn } from 'cn';

const SKELETON_WIDTHS = [
  'w-3/5',
  'w-4/5',
  'w-2/3',
  'w-1/2',
  'w-3/4',
  'w-2/5',
] as const;

/** 首次加载画的骨架行数。 */
export const SKELETON_ROW_COUNT = 5;

/**
 * 首次加载的骨架列：表头照旧，每一格换成骨架块。骨架行和数据行在同一张表里，
 * 所以一样高；有操作列时最后一格与行尾的「⋮」按钮同高（`tall`）。
 */
export function skeletonColumns<TData>(
  columns: readonly ColumnDef<TData>[],
  rowLabel: (row: number) => string,
  tall: boolean,
): ColumnDef<TData>[] {
  return columns.map((column, index) => {
    const id =
      column.id ??
      ('accessorKey' in column && typeof column.accessorKey === 'string'
        ? column.accessorKey
        : undefined);
    if (id === undefined)
      throw new Error(
        'List columns need an id or an accessorKey to show skeleton rows.',
      );
    return {
      id,
      header: column.header,
      enableSorting: false,
      cell: ({ row }: CellContext<TData, unknown>) => (
        <>
          {index === 0 ? (
            <span className='sr-only'>{rowLabel(row.index + 1)}</span>
          ) : null}
          <Skeleton
            aria-hidden='true'
            className={cn(
              tall && index === columns.length - 1 ? 'h-7' : 'h-5',
              SKELETON_WIDTHS[index % SKELETON_WIDTHS.length],
            )}
          />
        </>
      ),
    };
  });
}

/**
 * 骨架行的占位数据：只用来撑出 `count` 行，格子由 `skeletonColumns` 画。
 * 调用方在骨架态按下标给行 id（真实行的 id 读的是真实字段）。
 */
export function skeletonRows<T>(count: number): T[] {
  return Array.from(
    { length: count },
    (_, index) => ({ skeleton: index }) as T,
  );
}
