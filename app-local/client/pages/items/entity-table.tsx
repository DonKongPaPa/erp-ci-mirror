import type { ColumnDef } from '@tanstack/react-table';
import { useTranslation } from '@nocobase/i18n/client';
import type { ReactElement, ReactNode } from 'react';

import { DataTable } from '#components/data-table';
import {
  SKELETON_ROW_COUNT,
  skeletonColumns,
  skeletonRows,
} from '#components/erp/list-skeleton';
import type { useEntityList } from '#components/erp/list-state';

type EntityList<T> = ReturnType<typeof useEntityList<T>>;

/**
 * 一个标签里的那张表：三个标签共用。首次加载用骨架行画表头，分页、空态、错误态、
 * 清空筛选与重试都由 `DataTable` 出；工具栏放什么由调用方给。
 */
export function EntityTable<T>({
  list,
  columns,
  canManage,
  getRowId,
  empty,
  search,
  toolbar,
  filterPanel,
}: {
  readonly list: EntityList<T>;
  readonly columns: readonly ColumnDef<T>[];
  /** 有写权限才有操作列；骨架行的最后一格要和「⋮」同高。 */
  readonly canManage: boolean;
  readonly getRowId: (row: T) => string;
  readonly empty: ReactNode;
  readonly search?: ReactNode;
  readonly toolbar?: ReactNode;
  readonly filterPanel?: ReactNode;
}): ReactElement {
  const { t } = useTranslation();
  const skeleton = list.skeleton;
  return (
    <DataTable<T>
      columns={
        skeleton
          ? skeletonColumns(
              columns,
              (row) => t('erp.list.loadingRow', { row }),
              canManage,
            )
          : ([...columns] as ColumnDef<T>[])
      }
      data={skeleton ? skeletonRows<T>(SKELETON_ROW_COUNT) : list.rows}
      getRowId={(row, index) =>
        skeleton ? `skeleton-${index}` : getRowId(row)
      }
      manualPagination
      rowCount={list.total}
      paginationState={list.paginationState}
      onPaginationChange={list.onPaginationChange}
      pageSizeOptions={list.pageSizeOptions}
      pageSize={20}
      sortableColumns={list.sortableColumns}
      loading={list.loading}
      loadingIdentity={list.requestPath}
      listState={skeleton ? undefined : list.listState}
      onRetry={list.reload}
      onClearFilters={list.clearable ? list.clearFilters : undefined}
      filtered={list.filtered}
      pagination={!skeleton}
      showSelectedCount={false}
      emptyMessage={empty}
      search={search}
      toolbar={toolbar === undefined ? undefined : () => toolbar}
      filterPanel={filterPanel}
    />
  );
}
