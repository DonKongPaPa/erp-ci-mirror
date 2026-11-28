import { useCan } from '@nocobase/app-plugin-authorization/client';
import { useTranslation } from '@nocobase/i18n/client';
import type { ColumnDef, Row } from '@tanstack/react-table';
import { useMemo, useState, type ReactElement } from 'react';
import { Link, Outlet, useLocation } from 'react-router';

import { DataTable } from '#components/data-table';
import {
  FilterRow, FilterToggle, ListPage, ListSearch, NewButton, ResultCount, SelectFilter,
} from '#components/erp/list-page';
import { SKELETON_ROW_COUNT, skeletonColumns, skeletonRows } from '#components/erp/list-skeleton';
import { useEntityList } from '#components/erp/list-state';
import { RecordLink } from '#components/record-link';
import { RowActions } from '#components/row-actions';

import { DateFilter } from '../orders/fields.js';
import { Dash, DocStatusBadge, ReconStatusBadge } from './fields.js';
import type { ReconciliationKind } from './kinds.js';

interface ListRow {
  readonly id: string;
  readonly docNo: string;
  readonly date?: string;
  readonly reconDate?: string;
  readonly partner?: string;
  readonly customer?: unknown;
  readonly supplier?: unknown;
  readonly typeLabel?: string | null;
  readonly reconStatus?: 'unsettled' | 'partial' | 'settled';
  readonly totalAmount?: number;
  readonly periodAmount?: number;
  readonly status: string;
}

/** 四张财务单的列表：同构列、状态筛选与日期区间；没有写权限就没有新建与行操作。 */
export function ReconciliationListPage({ kind }: {
  readonly kind: ReconciliationKind;
}): ReactElement {
  const { t } = useTranslation();
  const location = useLocation();
  const view = useCan({ resource: kind.resource, action: 'view' });
  const create = useCan({ resource: kind.resource, action: 'create' });
  const update = useCan({ resource: kind.resource, action: 'update' });
  const voiding = useCan({ resource: kind.resource, action: 'void' });
  const list = useEntityList<ListRow>({
    path: kind.api,
    filterKeys: ['status', 'partnerId', 'type', 'from', 'to'],
    enabled: view.can,
    pending: view.isPending,
  });
  const [expanded, setExpanded] = useFilterExpanded(list);
  const applied = [list.filters.status, list.filters.partnerId, list.filters.type,
    list.filters.from, list.filters.to].filter(Boolean).length;
  const showFilters = expanded || applied > 0;
  const writable = update.can || voiding.can;

  const columns = useMemo<ColumnDef<ListRow>[]>(() => {
    const search = location.search;
    const to = (record: ListRow, ...segments: string[]) => ({
      pathname: [`${kind.base}/${encodeURIComponent(record.id)}`, ...segments].join('/'),
      search,
    });
    const cols: ColumnDef<ListRow>[] = [
      {
        id: 'docNo', header: t('reconciliation.docNo'),
        cell: ({ row }) => <RecordLink to={to(row.original)}>{row.original.docNo}</RecordLink>,
      },
      {
        id: 'date', header: t(kind.group === 'recon' ? 'reconciliation.reconDate' : 'reconciliation.date'),
        cell: ({ row }) => row.original.reconDate ?? row.original.date ?? <Dash />,
      },
      {
        id: 'partner', header: t(kind.group === 'recon' && kind.id === 'receivable'
          ? 'reconciliation.customer' : kind.group === 'recon' ? 'reconciliation.supplier' : 'reconciliation.customer'),
        cell: ({ row }) => row.original.partner ?? <Dash />,
      },
      {
        id: 'amount', header: t(kind.group === 'recon' ? 'reconciliation.periodAmount' : 'reconciliation.totalAmount'),
        cell: ({ row }) => {
          const value = row.original.reconDate ? row.original.periodAmount : row.original.totalAmount;
          return (
            <span className='tabular-nums text-right'>
              {typeof value === 'number' ? value.toFixed(2) : <Dash />}
            </span>
          );
        },
      },
      {
        id: 'status', header: t('erp.fields.status'),
        cell: ({ row }) => <DocStatusBadge status={row.original.status} />,
      },
    ];
    if (kind.group === 'recon')
      cols.push({
        id: 'reconStatus', header: t('reconciliation.reconStatus'),
        cell: ({ row }) => row.original.reconStatus ? <ReconStatusBadge status={row.original.reconStatus} /> : <Dash />,
      });
    if (writable)
      cols.push({
        id: 'actions', header: () => <span className='sr-only'>{t('erp.fields.actions')}</span>,
        cell: ({ row }) => (
          <RowActions
            label={t('erp.fields.actionsFor', { name: row.original.docNo })}
            actions={[
              row.original.status === 'draft' && update.can
                ? { key: 'edit', label: t('erp.actions.edit'), render: <Link to={to(row.original, 'edit')} /> }
                : null,
            ]}
          />
        ),
      });
    return cols;
  }, [t, kind, location.search, writable, update.can]);

  const to = (record: ListRow) => ({
    pathname: `${kind.base}/${encodeURIComponent(record.id)}`,
    search: location.search,
  });
  const renderCard = (row: Row<ListRow>) => {
    const record = row.original;
    const value = record.reconDate ? record.periodAmount : record.totalAmount;
    return (
      <article aria-label={record.docNo} className='flex flex-col gap-1 text-sm'>
        <RecordLink to={to(record)}>{record.docNo}</RecordLink>
        <span className='text-muted-foreground'>
          {record.reconDate ?? record.date ?? <Dash />}
        </span>
        <span>{record.partner ?? <Dash />}</span>
        <span className='tabular-nums text-right'>
          {typeof value === 'number' ? value.toFixed(2) : <Dash />}
        </span>
        <DocStatusBadge status={record.status} />
        {kind.group === 'recon' && record.reconStatus ? (
          <ReconStatusBadge status={record.reconStatus} />
        ) : null}
      </article>
    );
  };
  const labels: Readonly<Record<string, string>> = {
    docNo: t('reconciliation.docNo'),
    date: t(kind.group === 'recon' ? 'reconciliation.reconDate' : 'reconciliation.date'),
    partner: t(kind.group === 'recon' && kind.id === 'receivable'
      ? 'reconciliation.customer' : kind.group === 'recon' ? 'reconciliation.supplier' : 'reconciliation.customer'),
    amount: t(kind.group === 'recon' ? 'reconciliation.periodAmount' : 'reconciliation.totalAmount'),
    status: t('erp.fields.status'),
    reconStatus: t('reconciliation.reconStatus'),
  };

  return (
    <ListPage
      title={t(`navigation.${kind.l}`)}
      description={t(`${kind.l}.description`)}
      actions={create.can
        ? <NewButton to={`${kind.base}/new${location.search}`} label={t(`${kind.l}.newTitle`)} />
        : undefined}
    >
      <DataTable<ListRow>
        columns={list.skeleton ? skeletonColumns(columns, (row) => t('erp.list.loadingRow', { row }), writable) : columns}
        data={list.skeleton ? skeletonRows<ListRow>(SKELETON_ROW_COUNT) : list.rows}
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
        emptyMessage={`${t(`${kind.l}.empty`)} ${t(`${kind.l}.emptyHint`)}`}
        emptyAction={create.can
          ? <NewButton to={`${kind.base}/new${location.search}`} label={t(`${kind.l}.newTitle`)} />
          : undefined}
        renderCard={list.skeleton ? undefined : renderCard}
        getColumnLabel={(column) => labels[column.id] ?? column.id}
        search={<ListSearch value={list.q} onSearch={list.setSearch} label={t(`${kind.l}.searchLabel`)} />}
        toolbar={() => (
          <>
            <FilterToggle expanded={showFilters} applied={applied} onClick={() => setExpanded(!showFilters)} />
            <ResultCount count={list.total} />
          </>
        )}
        filterPanel={showFilters ? (
          <FilterRow>
            <SelectFilter
              label={t('erp.fields.status')}
              value={list.filters.status ?? ''}
              options={[
                { value: 'draft', label: t('reconciliation.status.draft') },
                { value: 'confirmed', label: t('reconciliation.status.confirmed') },
                { value: 'void', label: t('reconciliation.status.void') },
              ]}
              onChange={(value) => list.setFilter('status', value)}
            />
            <SelectFilter
              label={t('reconciliation.reconStatus')}
              value={list.filters.type ?? ''}
              options={[
                { value: 'unsettled', label: t('reconciliation.reconStatusValues.unsettled') },
                { value: 'partial', label: t('reconciliation.reconStatusValues.partial') },
                { value: 'settled', label: t('reconciliation.reconStatusValues.settled') },
              ]}
              onChange={(value) => list.setFilter('type', value)}
            />
            <DateFilter label={t('reconciliation.dateFrom')} value={list.filters.from ?? ''}
              onChange={(iso) => list.setFilter('from', iso)} />
            <DateFilter label={t('reconciliation.dateTo')} value={list.filters.to ?? ''} end
              onChange={(iso) => list.setFilter('to', iso)} />
          </FilterRow>
        ) : undefined}
      />
      <Outlet />
    </ListPage>
  );
}

/** 筛选面板的展开状态留在列表实例上。 */
function useFilterExpanded(_list: unknown): [boolean, (value: boolean) => void] {
  const [expanded, setExpanded] = useState(false);
  return [expanded, setExpanded];
}
