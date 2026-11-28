import { useApiClient, useToaster } from '@nocobase/app-client';
import { useCan } from '@nocobase/app-plugin-authorization/client';
import { useLocale, useTranslation } from '@nocobase/i18n/client';
import type { CellContext, ColumnDef } from '@tanstack/react-table';
import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { Link, Outlet, useLocation } from 'react-router';

import { DataTable } from '#components/data-table';
import { ConfirmDialog } from '#components/erp/confirm';
import {
  FilterRow,
  FilterToggle,
  ListPage,
  ListSearch,
  NewButton,
  ResultCount,
  SelectFilter,
} from '#components/erp/list-page';
import {
  SKELETON_ROW_COUNT,
  skeletonColumns,
  skeletonRows,
} from '#components/erp/list-skeleton';
import { useEntityList } from '#components/erp/list-state';
import { errorText } from '#components/erp/messages';
import { useReferencePage, type WarehouseOption } from '../orders/reference.js';
import { RecordLink } from '#components/record-link';
import { RowActions } from '#components/row-actions';
import { Input } from '#components/ui/input';

import { dateInputValue, endOfDay, formatDateTime, startOfDay } from '../stock/format.js';
import { TransferClient, type TransferSummary } from './client.js';
import { TransferStatusBadge } from './fields.js';
import { TRANSFERS_RESOURCE } from './page-id.js';

const detailLink = (doc: TransferSummary): string =>
  `/transfers/${encodeURIComponent(doc.id)}`;

/** 调拨单列表：端点支持的状态、调入仓、调出仓与日期筛选，加单号/备注搜索。 */
export function TransferListPage(): ReactElement {
  const { t } = useTranslation();
  const { locale } = useLocale();
  const api = useApiClient();
  const toaster = useToaster();
  const location = useLocation();
  const client = useMemo(() => new TransferClient(api), [api]);
  const view = useCan({ resource: TRANSFERS_RESOURCE, action: 'view' });
  const write = useCan({ resource: TRANSFERS_RESOURCE, action: 'update' });
  const voiding = useCan({ resource: TRANSFERS_RESOURCE, action: 'void' });
  const create = useCan({ resource: TRANSFERS_RESOURCE, action: 'create' });
  const canWrite = write.can;
  const canVoid = voiding.can;
  const warehouses = useReferencePage<WarehouseOption>('warehouses', true);
  const list = useEntityList<TransferSummary>({
    path: 'transfers',
    filterKeys: [
      'status',
      'transferInWarehouseId',
      'transferOutWarehouseId',
      'from',
      'to',
    ],
    enabled: view.can,
    pending: view.isPending,
  });
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [voidTarget, setVoidTarget] = useState<TransferSummary>();
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string>();

  const runVoid = async (doc: TransferSummary): Promise<void> => {
    setBusy(true);
    setActionError(undefined);
    try {
      await client.void(doc.id);
      toaster.show({
        type: 'success',
        title: t('transfer.toasts.voided', { docNo: doc.docNo }),
      });
      setVoidTarget(undefined);
      list.reload();
    } catch (error) {
      setVoidTarget(undefined);
      setActionError(errorText(error, t));
    } finally {
      setBusy(false);
    }
  };
  const runRef = useRef(runVoid);
  useEffect(() => {
    runRef.current = runVoid;
  });

  const columns = useMemo<ColumnDef<TransferSummary>[]>(() => {
    const actions: ColumnDef<TransferSummary> = {
      id: 'actions',
      header: () => <span className='sr-only'>{t('erp.fields.actions')}</span>,
      cell: ({ row }: CellContext<TransferSummary, unknown>) => {
        const doc = row.original;
        if (doc.status !== 'draft') return null;
        return (
          <RowActions
            label={t('erp.fields.actionsFor', { name: doc.docNo })}
            actions={[
              canWrite && {
                key: 'edit',
                label: t('erp.actions.edit'),
                render: (
                  <Link
                    to={{
                      pathname: `${detailLink(doc)}/edit`,
                      search: location.search,
                    }}
                  />
                ),
              },
              canVoid && {
                key: 'void',
                label: t('transfer.actions.void'),
                destructive: true,
                onClick: () => setVoidTarget(doc),
              },
            ]}
          />
        );
      },
    };
    return [
      {
        id: 'docNo',
        header: t('transfer.columns.docNo'),
        cell: ({ row }) => (
          <RecordLink
            to={{
              pathname: detailLink(row.original),
              search: location.search,
            }}
          >
            {row.original.docNo}
          </RecordLink>
        ),
      },
      {
        id: 'warehouseOut',
        header: t('transfer.columns.warehouseOut'),
        cell: ({ row }) => row.original.warehouseOut?.name ?? <DashCell />,
      },
      {
        id: 'warehouseIn',
        header: t('transfer.columns.warehouseIn'),
        cell: ({ row }) => row.original.warehouseIn.name,
      },
      {
        id: 'docDate',
        header: t('transfer.columns.docDate'),
        cell: ({ row }) =>
          row.original.docDate ? (
            <span className='tabular-nums'>
              {formatDateTime(row.original.docDate, locale)}
            </span>
          ) : (
            <DashCell />
          ),
      },
      {
        id: 'status',
        header: t('erp.fields.status'),
        cell: ({ row }) => <TransferStatusBadge status={row.original.status} />,
      },
      {
        id: 'createdAt',
        header: t('transfer.columns.createdAt'),
        cell: ({ row }) => (
          <span className='tabular-nums'>
            {formatDateTime(row.original.createdAt, locale)}
          </span>
        ),
      },
      ...(canWrite || canVoid ? [actions] : []),
    ];
  }, [t, locale, canWrite, canVoid, location.search]);

  const statusOptions = useMemo(
    () =>
      (['draft', 'posted', 'void'] as const).map((status) => ({
        value: status,
        label: t(`transfer.status.${status}`),
      })),
    [t],
  );
  const warehouseOptions = useMemo(
    () =>
      (warehouses.items ?? []).map((one) => ({
        value: one.id,
        label: one.name,
        disabled: one.status !== 'active',
      })),
    [warehouses.items],
  );
  const applied = Object.values(list.filters).filter(Boolean).length;
  const skeleton = list.skeleton;
  return (
    <ListPage
      title={t('transfer.title')}
      description={t('transfer.description')}
      actions={
        create.can ? (
          <NewButton to='/transfers/new' label={t('transfer.actions.new')} />
        ) : undefined
      }
    >
      <DataTable<TransferSummary>
        columns={
          skeleton
            ? skeletonColumns(
                columns,
                (row) => t('erp.list.loadingRow', { row }),
                canWrite || canVoid,
              )
            : columns
        }
        data={
          skeleton
            ? skeletonRows<TransferSummary>(SKELETON_ROW_COUNT)
            : list.rows
        }
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
        onClearFilters={list.clearFilters}
        filtered={list.filtered}
        pagination={!skeleton}
        showSelectedCount={false}
        emptyMessage={t('transfer.empty')}
        search={
          <ListSearch
            value={list.q}
            onSearch={list.setSearch}
            label={t('transfer.searchLabel')}
          />
        }
        toolbar={() => (
          <FilterToggle
            expanded={filtersOpen}
            applied={applied}
            onClick={() => setFiltersOpen((open) => !open)}
          />
        )}
        filterPanel={
          filtersOpen ? (
            <FilterRow>
              <SelectFilter
                label={t('transfer.filters.status')}
                value={list.filters.status ?? ''}
                options={statusOptions}
                onChange={(value) => list.setFilter('status', value)}
              />
              <SelectFilter
                label={t('transfer.filters.warehouseIn')}
                value={list.filters.transferInWarehouseId ?? ''}
                options={warehouseOptions}
                onChange={(value) => list.setFilter('transferInWarehouseId', value)}
              />
              <SelectFilter
                label={t('transfer.filters.warehouseOut')}
                value={list.filters.transferOutWarehouseId ?? ''}
                options={warehouseOptions}
                onChange={(value) => list.setFilter('transferOutWarehouseId', value)}
              />
              <DateFilter
                label={t('transfer.filters.from')}
                value={dateInputValue(list.filters.from ?? '')}
                onChange={(text) => list.setFilter('from', startOfDay(text))}
              />
              <DateFilter
                label={t('transfer.filters.to')}
                value={dateInputValue(list.filters.to ?? '')}
                onChange={(text) => list.setFilter('to', endOfDay(text))}
              />
            </FilterRow>
          ) : undefined
        }
        summary={<ResultCount count={list.total} />}
      />
      <ConfirmDialog
        open={voidTarget !== undefined}
        title={t('transfer.voidTitle', { docNo: voidTarget?.docNo ?? '' })}
        description={t('transfer.voidDescription')}
        confirmLabel={t('transfer.actions.void')}
        error={actionError ? <span role='alert'>{actionError}</span> : undefined}
        busy={busy}
        onCancel={() => setVoidTarget(undefined)}
        onConfirm={() => {
          if (voidTarget) void runRef.current(voidTarget);
        }}
      />
      <Outlet />
    </ListPage>
  );
}

function DashCell(): ReactElement {
  return <span className='text-muted-foreground'>—</span>;
}

function DateFilter({
  label,
  value,
  onChange,
}: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (text: string) => void;
}): ReactElement {
  return (
    <div className='flex w-44 flex-col gap-1.5'>
      <span className='text-sm font-medium'>{label}</span>
      {/* ui-component-exception: 项目尚无日期选择器与日历依赖，沿用库存页的两个原生日期输入 */}
      <Input
        type='date'
        aria-label={label}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}

export default TransferListPage;
