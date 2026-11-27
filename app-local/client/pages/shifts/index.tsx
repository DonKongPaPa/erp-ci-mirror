import { useApiClient, useToaster } from '@nocobase/app-client';
import { useCan } from '@nocobase/app-plugin-authorization/client';
import { useTranslation } from '@nocobase/i18n/client';
import type { CellContext, ColumnDef } from '@tanstack/react-table';
import { StatusBadge } from '#components/status-badge';
import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { Link, Outlet } from 'react-router';

import { DataTable } from '#components/data-table';
import { ConfirmDialog } from '#components/erp/confirm';
import { ActiveBadge } from '#components/erp/detail';
import { errorText } from '#components/erp/messages';
import {
  IncludeInactiveFilter,
  ListPage,
  NewButton,
  ResultCount,
} from '#components/erp/list-page';
import {
  SKELETON_ROW_COUNT,
  skeletonColumns,
  skeletonRows,
} from '#components/erp/list-skeleton';
import { useEntityList } from '#components/erp/list-state';
import { RowActions } from '#components/row-actions';

import { ShiftsClient, type Shift } from './client.js';
import { breakRange, isOvernight, timeRange } from './model.js';
import { SHIFTS_RESOURCE } from './page-id.js';

const DASH = <span className='text-muted-foreground'>—</span>;
const editLink = (shift: Shift) =>
  `/shifts/${encodeURIComponent(shift.id)}/edit`;
const copyLink = (shift: Shift) =>
  `/shifts/${encodeURIComponent(shift.id)}/copy`;

/**
 * 班次定义（`/shifts`，R-025 第一版）：列表、新建、编辑、复制新建并停用旧的、停用与启用。
 * 端点没有搜索参数，所以工具栏里只有「含已停用」；没有详情，编辑对话框里已经看全。
 */
export default function ShiftsPage(): ReactElement {
  const { t } = useTranslation();
  const api = useApiClient();
  const toaster = useToaster();
  const client = useMemo(() => new ShiftsClient(api), [api]);
  const view = useCan({ resource: SHIFTS_RESOURCE, action: 'view' });
  const manage = useCan({ resource: SHIFTS_RESOURCE, action: 'manage' });
  const canManage = manage.can;
  const list = useEntityList<Shift>({
    path: 'shifts',
    searchable: false,
    enabled: view.can,
    pending: view.isPending,
  });
  const [stopping, setStopping] = useState<Shift>();
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string>();

  /** 行上的启用与停用。停用先过下面的确认框。 */
  const run = async (shift: Shift, action: 'activate' | 'deactivate') => {
    setBusy(true);
    setActionError(undefined);
    try {
      await client[action](shift.id);
      toaster.show({
        type: 'success',
        title:
          action === 'activate'
            ? t('shifts.activatedToast', { name: shift.title })
            : t('shifts.deactivatedToast', { name: shift.title }),
      });
      setStopping(undefined);
      list.reload();
    } catch (error) {
      // 停用有确认框，错写在框里；启用没有，错用提示说。
      const text = errorText(error, t);
      if (action === 'deactivate') setActionError(text);
      else toaster.show({ type: 'error', title: text });
    } finally {
      setBusy(false);
    }
  };
  // 行上的操作调用最新的一份 run；列定义保持是同一个引用，重新取数时不会重装操作格。
  const runRef = useRef(run);
  useEffect(() => {
    runRef.current = run;
  });

  const columns = useMemo<ColumnDef<Shift>[]>(
    () => [
      {
        id: 'id',
        header: t('erp.fields.code'),
        cell: ({ row }) => (
          <span className='font-medium tabular-nums'>{row.original.id}</span>
        ),
      },
      {
        id: 'title',
        header: t('erp.fields.name'),
        cell: ({ row }) => row.original.title,
      },
      {
        id: 'range',
        header: t('shifts.columns.range'),
        cell: ({ row }) => timeRange(row.original),
      },
      {
        id: 'crossMidnight',
        header: t('shifts.columns.crossMidnight'),
        cell: ({ row }) =>
          isOvernight(row.original) ? (
            <StatusBadge size='sm' tone='warning'>
              {t('shifts.crossMidnight')}
            </StatusBadge>
          ) : (
            DASH
          ),
      },
      {
        id: 'break',
        header: t('shifts.columns.break'),
        // 休息段可能要换行，不截断。
        cell: ({ row }) => breakRange(row.original) ?? DASH,
      },
      {
        id: 'status',
        header: t('erp.fields.status'),
        cell: ({ row }) => <ActiveBadge active={row.original.active} />,
      },
      // 没有写权限的人整列操作都不画。
      ...(canManage
        ? [
            {
              id: 'actions',
              header: () => (
                <span className='sr-only'>{t('erp.fields.actions')}</span>
              ),
              cell: ({ row }: CellContext<Shift, unknown>) => (
                <RowActions
                  label={t('erp.fields.actionsFor', {
                    name: row.original.title,
                  })}
                  actions={
                    row.original.active
                      ? [
                          {
                            key: 'edit',
                            label: t('erp.actions.edit'),
                            render: <Link to={editLink(row.original)} />,
                          },
                          {
                            key: 'copy',
                            label: t('shifts.copyAction'),
                            render: <Link to={copyLink(row.original)} />,
                          },
                          {
                            key: 'deactivate',
                            label: t('erp.actions.deactivate'),
                            destructive: true,
                            onClick: () => setStopping(row.original),
                          },
                        ]
                      : [
                          {
                            key: 'activate',
                            label: t('erp.actions.activate'),
                            onClick: () =>
                              void runRef.current(row.original, 'activate'),
                          },
                          {
                            key: 'copy',
                            label: t('shifts.copyAction'),
                            render: <Link to={copyLink(row.original)} />,
                          },
                        ]
                  }
                />
              ),
            },
          ]
        : []),
    ],
    [t, canManage],
  );

  const skeleton = list.skeleton;
  return (
    <ListPage
      title={t('shifts.title')}
      description={t('shifts.description')}
      actions={
        canManage ? (
          <NewButton to='/shifts/new' label={t('shifts.new')} />
        ) : undefined
      }
    >
      <DataTable<Shift>
        columns={
          skeleton
            ? skeletonColumns(
                columns,
                (row) => t('erp.list.loadingRow', { row }),
                canManage,
              )
            : columns
        }
        data={skeleton ? skeletonRows<Shift>(SKELETON_ROW_COUNT) : list.rows}
        getRowId={(row, index) => (skeleton ? `skeleton-${index}` : row.id)}
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
        emptyMessage={t('shifts.empty')}
        toolbar={() => (
          <IncludeInactiveFilter
            checked={list.includeInactive}
            onCheckedChange={list.setIncludeInactive}
          />
        )}
        summary={<ResultCount count={list.total} />}
      />
      <ConfirmDialog
        open={stopping !== undefined}
        title={t('shifts.deactivateTitle', { name: stopping?.title ?? '' })}
        description={t('shifts.deactivateDescription')}
        confirmLabel={t('erp.actions.deactivate')}
        error={
          actionError ? <span role='alert'>{actionError}</span> : undefined
        }
        busy={busy}
        onCancel={() => setStopping(undefined)}
        onConfirm={() => {
          if (stopping) void runRef.current(stopping, 'deactivate');
        }}
      />
      {/* 新建、编辑、复制新建的路由对话框从这里出来。 */}
      <Outlet />
    </ListPage>
  );
}
