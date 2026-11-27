import { useApiClient } from '@nocobase/app-client';
import { useCan } from '@nocobase/app-plugin-authorization/client';
import { useTranslation } from '@nocobase/i18n/client';
import type { ColumnDef } from '@tanstack/react-table';
import { useEffect, useMemo, useState, type ReactElement } from 'react';
import { Link, Outlet, useLocation } from 'react-router';

import { DataTable } from '#components/data-table';
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
import { dictChoices, useDictEntries } from '#components/erp/options';
import { RecordLink } from '#components/record-link';
import { RowActions } from '#components/row-actions';
import type { EntityPage } from '#components/erp/list-state';

import { DateFilter } from '../orders/fields.js';
import { FinanceClient, type FinanceRecord, type SupplierOption } from './client.js';
import { Dash, FinanceStatusBadge } from './fields.js';
import type { FinanceKind } from './kinds.js';

/** 列表：一个搜索框，点「筛选」展开状态、供应商、类型与支出/到票日期。 */
export function FinanceListPage({
  kind,
}: {
  readonly kind: FinanceKind;
}): ReactElement {
  const { t } = useTranslation();
  const api = useApiClient();
  const location = useLocation();
  const client = useMemo(() => new FinanceClient(api), [api]);
  const view = useCan({ resource: kind.resource, action: 'view' });
  const create = useCan({ resource: kind.resource, action: 'create' });
  const update = useCan({ resource: kind.resource, action: 'update' });
  const voiding = useCan({ resource: kind.resource, action: 'void' });
  const dictView = useCan({
    resource: { type: 'composite', id: 'bizDict' },
    action: 'view',
  });
  const types = useDictEntries(kind.typeDict, dictView.can);
  const [suppliers, setSuppliers] = useState<readonly SupplierOption[]>([]);

  useEffect(() => {
    if (!view.can) return;
    const controller = new AbortController();
    void client
      .supplierOptions()
      .then((page: EntityPage<SupplierOption>) => {
        if (!controller.signal.aborted) setSuppliers(page.items);
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [client, view.can]);

  const list = useEntityList<FinanceRecord>({
    path: kind.api,
    filterKeys: ['status', 'supplierId', 'type', 'from', 'to'],
    enabled: view.can,
    pending: view.isPending,
  });
  const [expanded, setExpanded] = useState(false);
  const applied = [
    list.filters.status,
    list.filters.supplierId,
    list.filters.type,
    list.filters.from,
    list.filters.to,
  ].filter(Boolean).length;
  const showFilters = expanded || applied > 0;
  const writable = update.can || voiding.can;

  const columns = useMemo<ColumnDef<FinanceRecord>[]>(() => {
    const search = location.search;
    const to = (record: FinanceRecord, ...segments: string[]) => ({
      pathname: [`${kind.base}/${encodeURIComponent(record.id)}`, ...segments].join('/'),
      search,
    });
    const cols: ColumnDef<FinanceRecord>[] = [
      {
        id: 'docNo',
        header: t(`finance.${kind.docNoLabel}`),
        cell: ({ row }) => (
          <RecordLink to={to(row.original)}>{row.original.docNo}</RecordLink>
        ),
      },
      {
        id: 'date',
        header: t(kind.id === 'expense' ? 'finance.expenseDate' : 'finance.invoiceDate'),
        cell: ({ row }) => row.original.expenseDate ?? row.original.invoiceDate ?? <Dash />,
      },
      {
        id: 'supplier',
        header: t('finance.supplier'),
        cell: ({ row }) => row.original.supplier?.name ?? row.original.payeeName ?? <Dash />,
      },
      {
        id: 'type',
        header: t(kind.id === 'expense' ? 'finance.expenseType' : 'finance.invoiceType'),
        cell: ({ row }) =>
          row.original.expenseTypeLabel ?? row.original.invoiceTypeLabel ?? <Dash />,
      },
      {
        id: 'totalAmount',
        header: t('finance.totalAmount'),
        cell: ({ row }) => (
          <span className='tabular-nums'>{row.original.totalAmount}</span>
        ),
      },
      {
        id: 'status',
        header: t('erp.fields.status'),
        cell: ({ row }) => <FinanceStatusBadge record={row.original} />,
      },
    ];
    if (writable)
      cols.push({
        id: 'actions',
        header: () => <span className='sr-only'>{t('erp.fields.actions')}</span>,
        cell: ({ row }) => {
          const record = row.original;
          return (
            <RowActions
              label={t('erp.fields.actionsFor', { name: record.docNo })}
              actions={[
                record.status === 'draft' && update.can
                  ? { key: 'edit', label: t('erp.actions.edit'), render: <Link to={to(record, 'edit')} /> }
                  : null,
              ]}
            />
          );
        },
      });
    return cols;
  }, [t, kind, location.search, writable, update.can]);

  return (
    <ListPage
      title={t(`navigation.${kind.l}`)}
      description={t(`${kind.l}.description`)}
      actions={
        create.can ? (
          <NewButton to={`${kind.base}/new${location.search}`} label={t(`${kind.l}.newTitle`)} />
        ) : undefined
      }
    >
      <DataTable<FinanceRecord>
        columns={
          list.skeleton
            ? skeletonColumns(columns, (row) => t('erp.list.loadingRow', { row }), writable)
            : columns
        }
        data={list.skeleton ? skeletonRows<FinanceRecord>(SKELETON_ROW_COUNT) : list.rows}
        getRowId={(row, index) => (list.skeleton ? `skeleton-${index}` : row.id)}
        manualPagination
        rowCount={list.total}
        paginationState={list.paginationState}
        onPaginationChange={list.onPaginationChange}
        pageSizeOptions={list.pageSizeOptions}
        pageSize={20}
        sortableColumns={list.sortableColumns}
        loading={list.loading}
        loadingIdentity={list.requestPath}
        listState={list.skeleton ? undefined : list.listState}
        onRetry={list.reload}
        onClearFilters={list.clearFilters}
        filtered={list.filtered}
        pagination={!list.skeleton}
        showSelectedCount={false}
        emptyMessage={t(`${kind.l}.empty`)}
        search={
          <ListSearch value={list.q} onSearch={list.setSearch} label={t(`${kind.l}.searchLabel`)} />
        }
        toolbar={() => (
          <>
            <FilterToggle expanded={showFilters} applied={applied} onClick={() => setExpanded(!showFilters)} />
            <ResultCount count={list.total} />
          </>
        )}
        filterPanel={
          showFilters ? (
            <FilterRow>
              <SelectFilter
                label={t('erp.fields.status')}
                value={list.filters.status ?? ''}
                options={[
                  { value: 'draft', label: t('finance.status.draft') },
                  { value: 'confirmed', label: t('finance.status.confirmed') },
                  { value: 'void', label: t('finance.status.void') },
                ]}
                onChange={(value) => list.setFilter('status', value)}
              />
              <SelectFilter
                label={t('finance.supplier')}
                value={list.filters.supplierId ?? ''}
                options={suppliers.map((one) => ({ value: one.id, label: one.name }))}
                onChange={(value) => list.setFilter('supplierId', value)}
              />
              <SelectFilter
                label={t(kind.id === 'expense' ? 'finance.expenseType' : 'finance.invoiceType')}
                value={list.filters.type ?? ''}
                options={dictChoices(types.items)}
                onChange={(value) => list.setFilter('type', value)}
              />
              <DateFilter
                label={t('finance.dateFrom')}
                value={list.filters.from ?? ''}
                onChange={(iso) => list.setFilter('from', iso)}
              />
              <DateFilter
                label={t('finance.dateTo')}
                value={list.filters.to ?? ''}
                end
                onChange={(iso) => list.setFilter('to', iso)}
              />
            </FilterRow>
          ) : undefined
        }
      />
      <Outlet />
    </ListPage>
  );
}
