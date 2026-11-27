import { useApiClient, useToaster } from '@nocobase/app-client';
import { useCan } from '@nocobase/app-plugin-authorization/client';
import { useTranslation } from '@nocobase/i18n/client';
import type { CellContext, ColumnDef } from '@tanstack/react-table';
import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { Link, Outlet } from 'react-router';

import { DataTable } from '#components/data-table';
import { ConfirmDialog } from '#components/erp/confirm';
import { ActiveBadge } from '#components/erp/detail';
import {
  IncludeInactiveFilter,
  ListPage,
  ListSearch,
  NewButton,
  ResultCount,
} from '#components/erp/list-page';
import {
  SKELETON_ROW_COUNT,
  skeletonColumns,
  skeletonRows,
} from '#components/erp/list-skeleton';
import { useEntityList } from '#components/erp/list-state';
import { errorText } from '#components/erp/messages';
import { RowActions } from '#components/row-actions';

import { WarehousesClient, type Warehouse } from './client.js';
import { INVENTORY_RESOURCE } from './page-id.js';

const DASH = <span className='text-muted-foreground'>—</span>;
const editLink = (warehouse: Warehouse) =>
  `/warehouses/${encodeURIComponent(warehouse.id)}/edit`;

/**
 * 仓库（`/warehouses`，R-020）：列表、新建、编辑、停用与启用。
 * 不设详情（字段太少，列表里已经看全），不删除：停用后新单据里选不到它。
 * 读要 inventory.warehouseView（仓管、采购、销售），建改要 warehouseManage（只有 root）。
 */
export default function WarehousesPage(): ReactElement {
  const { t } = useTranslation();
  const api = useApiClient();
  const toaster = useToaster();
  const client = useMemo(() => new WarehousesClient(api), [api]);
  const view = useCan({ resource: INVENTORY_RESOURCE, action: 'warehouseView' });
  const manage = useCan({
    resource: INVENTORY_RESOURCE,
    action: 'warehouseManage',
  });
  const canManage = manage.can;
  // 默认只列在用的：端点没有「含已停用」参数，不勾时传 status=active。
  const list = useEntityList<Warehouse>({
    path: 'warehouses',
    inactiveParam: 'status',
    enabled: view.can,
    pending: view.isPending,
  });
  const [stopping, setStopping] = useState<Warehouse>();
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string>();

  /** 行上的启用与停用。停用先过下面的确认框。 */
  const run = async (warehouse: Warehouse, action: 'activate' | 'deactivate') => {
    setBusy(true);
    setActionError(undefined);
    try {
      await client.update(warehouse.id, {
        status: action === 'activate' ? 'active' : 'inactive',
      });
      toaster.show({
        type: 'success',
        title:
          action === 'activate'
            ? t('warehouses.activatedToast', { name: warehouse.name })
            : t('warehouses.deactivatedToast', { name: warehouse.name }),
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

  const columns = useMemo<ColumnDef<Warehouse>[]>(
    () => [
      {
        id: 'code',
        header: t('erp.fields.code'),
        // 不设详情：首列是短码，不是链接。
        cell: ({ row }) => (
          <span className='font-medium tabular-nums'>{row.original.code}</span>
        ),
      },
      {
        id: 'name',
        header: t('erp.fields.name'),
        cell: ({ row }) => row.original.name,
      },
      {
        id: 'note',
        header: t('erp.fields.note'),
        // 备注可能要换行，不截断。
        cell: ({ row }) => row.original.note || DASH,
      },
      {
        id: 'status',
        header: t('erp.fields.status'),
        cell: ({ row }) => (
          <ActiveBadge active={row.original.status === 'active'} />
        ),
      },
      // 没有建改权限的人整列操作都不画。
      ...(canManage
        ? [
            {
              id: 'actions',
              header: () => (
                <span className='sr-only'>{t('erp.fields.actions')}</span>
              ),
              cell: ({ row }: CellContext<Warehouse, unknown>) => (
                <RowActions
                  label={t('erp.fields.actionsFor', {
                    name: row.original.name,
                  })}
                  actions={
                    row.original.status === 'active'
                      ? [
                          {
                            key: 'edit',
                            label: t('erp.actions.edit'),
                            render: <Link to={editLink(row.original)} />,
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
                            key: 'edit',
                            label: t('erp.actions.edit'),
                            render: <Link to={editLink(row.original)} />,
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
      title={t('warehouses.title')}
      description={t('warehouses.description')}
      actions={
        canManage ? (
          <NewButton to='/warehouses/new' label={t('warehouses.new')} />
        ) : undefined
      }
    >
      <DataTable<Warehouse>
        columns={
          skeleton
            ? skeletonColumns(
                columns,
                (row) => t('erp.list.loadingRow', { row }),
                canManage,
              )
            : columns
        }
        data={skeleton ? skeletonRows<Warehouse>(SKELETON_ROW_COUNT) : list.rows}
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
        emptyMessage={t('warehouses.empty')}
        search={
          <ListSearch
            value={list.q}
            onSearch={list.setSearch}
            label={t('warehouses.searchLabel')}
          />
        }
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
        title={t('warehouses.deactivateTitle', {
          name: stopping?.name ?? '',
        })}
        description={t('warehouses.deactivateDescription')}
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
      {/* 新建与编辑的路由对话框从这里出来。 */}
      <Outlet />
    </ListPage>
  );
}
