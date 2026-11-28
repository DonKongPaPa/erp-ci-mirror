import { useCan } from '@nocobase/app-plugin-authorization/client';
import { useTranslation } from '@nocobase/i18n/client';
import type { ColumnDef } from '@tanstack/react-table';
import { useMemo, useState, type ReactElement, type ReactNode } from 'react';
import { useLocation } from 'react-router';

import { DataTable } from '#components/data-table';
import {
  FilterRow,
  FilterToggle,
  ListPage,
  ListSearch,
  ResultCount,
  SelectFilter,
} from '#components/erp/list-page';
import {
  SKELETON_ROW_COUNT,
  skeletonColumns,
  skeletonRows,
} from '#components/erp/list-skeleton';
import { useEntityList } from '#components/erp/list-state';
import { Input } from '#components/ui/input';
import { RecordLink } from '#components/record-link';

import { Dash } from '../orders/fields.js';
import {
  isEmptySegment,
  type LedgerRow,
  type LedgerSegment,
} from './model.js';

/**
 * R-064 订单总台账（只读）：六段全部来自 `/sales-orders/ledger` 的窄列。
 * 没有数据源的段端点回 null，这里画「—」；超期标记与天数由服务端算，页面只显示。
 * 端点没有销售员与交期区间筛选，所以这里只提供它真正支持的筛选，不自己造参数。
 */
export default function OrderLedgerPage(): ReactElement {
  const { t } = useTranslation();
  const location = useLocation();
  const access = useCan({
    resource: { type: 'composite', id: 'salesOrders' },
    action: 'ledgerView',
  });
  const list = useEntityList<LedgerRow>({
    path: 'sales-orders/ledger',
    filterKeys: ['projectCode', 'reviewStatus', 'overdue', 'status'],
    enabled: access.can,
    pending: access.isPending,
  });
  const [expanded, setExpanded] = useState(false);

  const columns = useMemo<ColumnDef<LedgerRow>[]>(() => {
    const link = (row: LedgerRow) => ({
      pathname: `/sales-orders/${encodeURIComponent(row.salesOrderId)}`,
      search: location.search,
    });
    const segment = (value: LedgerSegment): ReactNode => {
      if (isEmptySegment(value)) return <Dash />;
      const qty = value.qty === null || value.total === null ? null : (
        <span className='tabular-nums'>{value.qty} / {value.total}</span>
      );
      return (
        <span className='flex flex-col'>
          {value.status === null ? null : (
            <span>{t(`orderLedger.segmentStatus.${value.status}`)}</span>
          )}
          {qty}
        </span>
      );
    };
    return [
      {
        id: 'orderNo',
        header: t('orderLedger.orderNo'),
        cell: ({ row }) => <RecordLink to={link(row.original)}>{row.original.orderNo}</RecordLink>,
      },
      {
        id: 'orderDate',
        header: t('orderLedger.orderDate'),
        cell: ({ row }) => row.original.orderDate,
      },
      {
        id: 'customer',
        header: t('orderLedger.customer'),
        cell: ({ row }) => row.original.customer?.name ?? <Dash />,
      },
      {
        id: 'project',
        header: t('orderLedger.project'),
        cell: ({ row }) => row.original.projectLabel ?? row.original.projectCode ?? <Dash />,
      },
      {
        id: 'handler',
        header: t('orderLedger.handler'),
        cell: ({ row }) => row.original.handler?.name ?? <Dash />,
      },
      {
        id: 'review',
        header: t('orderLedger.review'),
        cell: ({ row }) =>
          row.original.review.status === null ? <Dash /> : (
            <span className='flex flex-col'>
              <span>
                {t(`orderLedger.segmentStatus.${row.original.review.status}`)}
              </span>
              <span className='text-xs text-muted-foreground'>
                {row.original.review.reviewer?.name ?? <Dash />}
              </span>
            </span>
          ),
      },
      {
        id: 'confirmedDeliveryDate',
        header: t('orderLedger.confirmedDeliveryDate'),
        cell: ({ row }) => row.original.review.confirmedDeliveryDate ?? <Dash />,
      },
      ...(['purchase', 'production', 'receipt', 'shipping', 'payment'] as const).map(
        (key) => ({
          id: key,
          header: t(`orderLedger.${key}`),
          cell: ({ row }: { row: { original: LedgerRow } }) => segment(row.original[key]),
        }),
      ),
      {
        id: 'baselineDate',
        header: t('orderLedger.baselineDate'),
        cell: ({ row }) => {
          const days = row.original.overdueDays;
          return (
            <span
              data-testid={`ledger-baseline-${row.original.salesOrderId}`}
              data-overdue={row.original.overdue}
              title={
                row.original.overdue && days !== null
                  ? t('orderLedger.overdueDays', { days })
                  : undefined
              }
              className={row.original.overdue ? 'text-destructive' : undefined}
            >
              {row.original.baselineDate ?? <Dash />}
            </span>
          );
        },
      },
      {
        id: 'status',
        header: t('orderLedger.status'),
        cell: ({ row }) => row.original.status,
      },
    ];
  }, [t, location.search]);

  const applied = [
    list.filters.projectCode,
    list.filters.reviewStatus,
    list.filters.overdue,
    list.filters.status,
  ].filter(Boolean).length;
  const showFilters = expanded || applied > 0;

  return (
    <ListPage
      title={t('orderLedger.title')}
      description={t('orderLedger.description')}
    >
      <DataTable<LedgerRow>
        columns={
          list.skeleton
            ? skeletonColumns(columns, (row) => t('erp.list.loadingRow', { row }), false)
            : columns
        }
        data={list.skeleton ? skeletonRows<LedgerRow>(SKELETON_ROW_COUNT) : list.rows}
        getRowId={(row, index) =>
          list.skeleton ? `skeleton-${index}` : row.salesOrderId
        }
        manualPagination
        rowCount={list.total}
        paginationState={list.paginationState}
        onPaginationChange={list.onPaginationChange}
        pageSizeOptions={list.pageSizeOptions}
        sortableColumns={list.sortableColumns}
        loading={list.loading}
        loadingIdentity={list.requestPath}
        listState={list.skeleton ? undefined : list.listState}
        onRetry={list.reload}
        onClearFilters={list.clearFilters}
        filtered={list.filtered}
        pagination={!list.skeleton}
        showSelectedCount={false}
        emptyMessage={t('orderLedger.empty')}
        search={
          <ListSearch
            value={list.q}
            onSearch={list.setSearch}
            label={t('orderLedger.searchLabel')}
          />
        }
        toolbar={() => (
          <>
            <FilterToggle
              expanded={showFilters}
              applied={applied}
              onClick={() => setExpanded(!showFilters)}
            />
            <ResultCount count={list.total} />
          </>
        )}
        filterPanel={
          showFilters ? (
            <FilterRow>
              <SelectFilter
                label={t('orderLedger.filter.reviewStatus')}
                value={list.filters.reviewStatus ?? ''}
                options={[
                  { value: 'pending', label: t('orderLedger.pending') },
                  { value: 'done', label: t('orderLedger.done') },
                ]}
                onChange={(value) => list.setFilter('reviewStatus', value)}
              />
              <SelectFilter
                label={t('orderLedger.filter.overdue')}
                value={list.filters.overdue ?? ''}
                options={[
                  { value: 'true', label: t('orderLedger.overdue') },
                  { value: 'false', label: t('orderLedger.upcoming') },
                ]}
                onChange={(value) => list.setFilter('overdue', value)}
              />
              <SelectFilter
                label={t('orderLedger.filter.status')}
                value={list.filters.status ?? ''}
                options={['draft', 'ordered', 'partial', 'done', 'cancelled'].map((value) => ({
                  value,
                  label: t(`salesOrders.status.${value}`),
                }))}
                onChange={(value) => list.setFilter('status', value)}
              />
              <ProjectFilter
                value={list.filters.projectCode ?? ''}
                onChange={(value) => list.setFilter('projectCode', value)}
              />
            </FilterRow>
          ) : undefined
        }
      />
    </ListPage>
  );
}

function ProjectFilter({
  value,
  onChange,
}: {
  readonly value: string;
  readonly onChange: (value: string) => void;
}): ReactElement {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(value);
  return (
    <div className='flex w-48 flex-col gap-1.5'>
      <span className='text-sm font-medium'>
        {t('orderLedger.filter.projectCode')}
      </span>
      <Input
        aria-label={t('orderLedger.filter.projectCode')}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => onChange(draft.trim())}
        onKeyDown={(event) => {
          if (event.key === 'Enter') onChange(draft.trim());
        }}
      />
    </div>
  );
}
