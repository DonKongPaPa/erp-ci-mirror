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

import { StocktakingClient, type StocktakingSummary } from './client.js';
import { StocktakingStatusBadge } from './fields.js';
import { dateInputValue, endOfDay, formatDateTime, startOfDay } from '../stock/format.js';
import { STOCKTAKINGS_RESOURCE } from './page-id.js';

const detailLink = (doc: StocktakingSummary): string =>
  `/stocktakings/${encodeURIComponent(doc.id)}`;

/**
 * 盘点单列表：搜索（单号或备注），展开的筛选里是状态、仓库与日期，都是端点支持的参数。
 * 读、改、作废按盘点单业务资源的动作决定；结束盘点在详情里单独按 finish 动作显隐。
 */
export function StocktakingListPage(): ReactElement {
  const { t } = useTranslation();
  const { locale } = useLocale();
  const api = useApiClient();
  const toaster = useToaster();
  const location = useLocation();
  const client = useMemo(() => new StocktakingClient(api), [api]);
  const view = useCan({ resource: STOCKTAKINGS_RESOURCE, action: 'view' });
  const write = useCan({ resource: STOCKTAKINGS_RESOURCE, action: 'update' });
  const voiding = useCan({ resource: STOCKTAKINGS_RESOURCE, action: 'void' });
  const create = useCan({ resource: STOCKTAKINGS_RESOURCE, action: 'create' });
  const canWrite = write.can;
  const canVoid = voiding.can;
  const warehouses = useReferencePage<WarehouseOption>('warehouses', true);
  const list = useEntityList<StocktakingSummary>({
    path: 'stocktakings',
    filterKeys: ['status', 'warehouseId', 'from', 'to'],
    enabled: view.can,
    pending: view.isPending,
  });
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [voidTarget, setVoidTarget] = useState<StocktakingSummary>();
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string>();

  const runVoid = async (doc: StocktakingSummary): Promise<void> => {
    setBusy(true);
    setActionError(undefined);
    try {
      await client.void(doc.id);
      toaster.show({
        type: 'success',
        title: t('stocktaking.toasts.voided', { docNo: doc.docNo }),
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

  const columns = useMemo<ColumnDef<StocktakingSummary>[]>(() => {
    const actions: ColumnDef<StocktakingSummary> = {
      id: 'actions',
      header: () => <span className='sr-only'>{t('erp.fields.actions')}</span>,
      cell: ({ row }: CellContext<StocktakingSummary, unknown>) => {
        const doc = row.original;
        if (doc.status !== 'staging') return null;
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
                label: t('stocktaking.actions.void'),
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
        header: t('stocktaking.columns.docNo'),
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
        id: 'warehouse',
        header: t('stocktaking.columns.warehouse'),
        cell: ({ row }) => row.original.warehouse.name,
      },
      {
        id: 'docDate',
        header: t('stocktaking.columns.docDate'),
        cell: ({ row }) => (
          <span className='tabular-nums'>
            {formatDateTime(row.original.docDate, locale)}
          </span>
        ),
      },
      {
        id: 'status',
        header: t('erp.fields.status'),
        cell: ({ row }) => (
          <StocktakingStatusBadge status={row.original.status} />
        ),
      },
      {
        id: 'createdAt',
        header: t('stocktaking.columns.createdAt'),
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
      (['staging', 'finished', 'void'] as const).map((status) => ({
        value: status,
        label: t(`stocktaking.status.${status}`),
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
      title={t('stocktaking.title')}
      description={t('stocktaking.description')}
      actions={
        create.can ? (
          <NewButton
            to='/stocktakings/new'
            label={t('stocktaking.actions.new')}
          />
        ) : undefined
      }
    >
      <DataTable<StocktakingSummary>
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
            ? skeletonRows<StocktakingSummary>(SKELETON_ROW_COUNT)
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
        emptyMessage={t('stocktaking.empty')}
        search={
          <ListSearch
            value={list.q}
            onSearch={list.setSearch}
            label={t('stocktaking.searchLabel')}
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
                label={t('stocktaking.filters.status')}
                value={list.filters.status ?? ''}
                options={statusOptions}
                onChange={(value) => list.setFilter('status', value)}
              />
              <SelectFilter
                label={t('stocktaking.filters.warehouse')}
                value={list.filters.warehouseId ?? ''}
                options={warehouseOptions}
                onChange={(value) => list.setFilter('warehouseId', value)}
              />
              <DateFilter
                label={t('stocktaking.filters.from')}
                value={dateInputValue(list.filters.from ?? '')}
                onChange={(text) => list.setFilter('from', startOfDay(text))}
              />
              <DateFilter
                label={t('stocktaking.filters.to')}
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
        title={t('stocktaking.voidTitle', { docNo: voidTarget?.docNo ?? '' })}
        description={t('stocktaking.voidDescription')}
        confirmLabel={t('stocktaking.actions.void')}
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

/** 展开行里的一个日期：沿用库存查询页的做法，两个原生日期输入。 */
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
      {/* ui-component-exception: 项目尚无日期选择器与日历依赖，沿用库存页的两个原生日期输入；补 DatePicker 要先引入依赖，超出本片范围 */}
      <Input
        type='date'
        aria-label={label}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}

export default StocktakingListPage;
