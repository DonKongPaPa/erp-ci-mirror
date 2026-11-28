import { useLocale } from '@nocobase/i18n/client';
import { useCan } from '@nocobase/app-plugin-authorization/client';
import { useTranslation } from '@nocobase/i18n/client';
import type { CellContext, ColumnDef } from '@tanstack/react-table';
import { useMemo, useState, type ReactElement } from 'react';
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
import { dictChoices, useDictEntries } from '#components/erp/options';
import { useEntityList } from '#components/erp/list-state';
import { RecordLink } from '#components/record-link';
import { RowActions } from '#components/row-actions';

import { useReferencePage, type PartnerOption } from '../orders/reference.js';
import type { Quotation } from './client.js';
import { DayFilter, ExpiredBadge, QuotationStatusBadge } from './fields.js';
import { formatAmount } from './model.js';
import { QUOTATIONS_RESOURCE } from './page-id.js';

/**
 * 报价单列表（R-022 波 2）：列表端点支持的筛选是状态、客户、项目、有效期至与关键字，
 * 没有创建时间参数。已过期的行由服务端的 `expired` 标记出来，页面不自己比日期。
 */
export default function QuotationListPage(): ReactElement {
  const { t } = useTranslation();
  const { locale } = useLocale();
  const location = useLocation();
  const view = useCan({ resource: QUOTATIONS_RESOURCE, action: 'view' });
  const create = useCan({ resource: QUOTATIONS_RESOURCE, action: 'create' });
  const update = useCan({ resource: QUOTATIONS_RESOURCE, action: 'update' });
  const customerView = useCan({
    resource: { type: 'composite', id: 'customers' },
    action: 'view',
  });
  const dictView = useCan({
    resource: { type: 'composite', id: 'bizDict' },
    action: 'view',
  });
  const list = useEntityList<Quotation>({
    path: 'quotations',
    filterKeys: ['customerId', 'projectCode', 'status', 'validFrom', 'validTo'],
    enabled: view.can,
    pending: view.isPending,
  });
  const customers = useReferencePage<PartnerOption>(
    'partners?kind=customer&status=active',
    customerView.can,
  );
  const projects = useDictEntries('project', dictView.can);
  const [expanded, setExpanded] = useState(false);
  const applied = [
    list.filters.status,
    list.filters.customerId,
    list.filters.projectCode,
    list.filters.validFrom,
    list.filters.validTo,
  ].filter(Boolean).length;
  const showFilters = expanded || applied > 0;

  const columns = useMemo<ColumnDef<Quotation>[]>(() => {
    const search = location.search;
    const to = (quotation: Quotation, ...segments: string[]) => ({
      pathname: ['/quotations', encodeURIComponent(quotation.id), ...segments].join('/'),
      search,
    });
    return [
      {
        id: 'docNo',
        header: t('quotations.fields.docNo'),
        cell: ({ row }) => (
          <RecordLink to={to(row.original)}>{row.original.docNo}</RecordLink>
        ),
      },
      {
        id: 'customer',
        header: t('quotations.fields.customer'),
        cell: ({ row }) =>
          row.original.customer ? (
            <span className='flex min-w-0 flex-col'>
              <span className='font-medium tabular-nums'>
                {row.original.customer.code}
              </span>
              <span className='wrap-anywhere'>{row.original.customer.name}</span>
            </span>
          ) : null,
      },
      {
        id: 'quoteDate',
        header: t('quotations.fields.quoteDate'),
        cell: ({ row }) => <span className='tabular-nums'>{row.original.quoteDate}</span>,
      },
      {
        id: 'validUntil',
        header: t('quotations.fields.validUntil'),
        cell: ({ row }) => (
          <span className='flex flex-wrap items-center gap-2'>
            <span className='tabular-nums'>{row.original.validUntil ?? '—'}</span>
            {row.original.expired ? <ExpiredBadge /> : null}
          </span>
        ),
      },
      {
        id: 'payableTotal',
        header: t('quotations.fields.payableTotal'),
        cell: ({ row }) =>
          row.original.payableTotal === null ? null : (
            <span className='tabular-nums'>
              {t('quotations.money', {
                amount: formatAmount(row.original.payableTotal, locale),
              })}
            </span>
          ),
      },
      {
        id: 'status',
        header: t('erp.fields.status'),
        cell: ({ row }) => <QuotationStatusBadge status={row.original.status} />,
      },
      ...(update.can
        ? [
            {
              id: 'actions',
              header: () => <span className='sr-only'>{t('erp.fields.actions')}</span>,
              cell: ({ row }: CellContext<Quotation, unknown>) => {
                const quotation = row.original;
                return (
                  <RowActions
                    label={t('quotations.actionsFor', { name: quotation.docNo })}
                    actions={[
                      quotation.status === 'draft'
                        ? {
                            key: 'edit',
                            label: t('quotations.actions.edit'),
                            render: <Link to={to(quotation, 'edit')} />,
                          }
                        : null,
                    ]}
                  />
                );
              },
            } satisfies ColumnDef<Quotation>,
          ]
        : []),
    ];
  }, [t, locale, location.search, update.can]);

  const skeleton = list.skeleton;
  return (
    <ListPage
      title={t('quotations.title')}
      description={t('quotations.description')}
      actions={
        create.can ? (
          <NewButton
            to={`/quotations/new${location.search}`}
            label={t('quotations.actions.new')}
          />
        ) : undefined
      }
    >
      <DataTable<Quotation>
        columns={skeleton ? skeletonColumns(columns, (row) => t('erp.list.loadingRow', { row }), false) : columns}
        data={skeleton ? skeletonRows<Quotation>(SKELETON_ROW_COUNT) : list.rows}
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
        emptyMessage={t('quotations.empty')}
        search={
          <ListSearch
            value={list.q}
            onSearch={list.setSearch}
            label={t('quotations.searchLabel')}
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
                label={t('quotations.filters.status')}
                value={list.filters.status ?? ''}
                options={['draft', 'confirmed', 'converted', 'void'].map((status) => ({
                  value: status,
                  label: t(`quotations.status.${status}`),
                }))}
                onChange={(value) => list.setFilter('status', value)}
              />
              {customerView.can ? (
                <SelectFilter
                  label={t('quotations.filters.customer')}
                  value={list.filters.customerId ?? ''}
                  options={(customers.items ?? []).map((customer) => ({
                    value: customer.id,
                    label: `${customer.code} ${customer.name}`,
                  }))}
                  onChange={(value) => list.setFilter('customerId', value)}
                />
              ) : null}
              {dictView.can ? (
                <SelectFilter
                  label={t('quotations.filters.project')}
                  value={list.filters.projectCode ?? ''}
                  options={dictChoices(projects.items)}
                  onChange={(value) => list.setFilter('projectCode', value)}
                />
              ) : null}
              <DayFilter
                label={t('quotations.filters.validFrom')}
                value={list.filters.validFrom ?? ''}
                onChange={(day) => list.setFilter('validFrom', day)}
              />
              <DayFilter
                label={t('quotations.filters.validTo')}
                value={list.filters.validTo ?? ''}
                onChange={(day) => list.setFilter('validTo', day)}
              />
            </FilterRow>
          ) : undefined
        }
      />
      {/* 新建与详情的子页盖在列表上。 */}
      <Outlet />
    </ListPage>
  );
}
