import { useApiClient, useToaster } from '@nocobase/app-client';
import { useCan } from '@nocobase/app-plugin-authorization/client';
import { useLocale, useTranslation } from '@nocobase/i18n/client';
import type { CellContext, ColumnDef } from '@tanstack/react-table';
import { PlusIcon } from 'lucide-react';
import { useMemo, useState, type ReactElement } from 'react';
import { Link, Outlet, useLocation } from 'react-router';

import { DataTable } from '#components/data-table';
import { ConfirmDialog } from '#components/erp/confirm';
import {
  FilterRow,
  FilterToggle,
  ListPage,
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
import { RecordLink } from '#components/record-link';
import { RowActions } from '#components/row-actions';
import { Button } from '#components/ui/button';
import { Skeleton } from '#components/ui/skeleton';

import { BomsClient, type BomSummary } from './client.js';
import { BomStatusBadge } from './fields.js';
import { qtyText } from './format.js';
import { BOMS_RESOURCE } from './page-id.js';

/** 产品与物料共用 items 列表；下拉只选 product 类型、在用的。 */
import { itemChoices, type Item } from '../orders/reference.js';
import { useReferencePage } from '../orders/reference.js';

const detailLink = (doc: BomSummary): string =>
  `/boms/${encodeURIComponent(doc.id)}`;

/** 列表页的主操作：常规高度、左侧图标、可见焦点。 */
function NewBomLink({ label }: { readonly label: string }): ReactElement {
  return (
    <Button
      nativeButton={false}
      render={<Link to='/boms/new' />}
      className='focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring'
    >
      <PlusIcon data-icon='inline-start' aria-hidden='true' />
      {label}
    </Button>
  );
}

/** BOM 列表：按成品与状态筛；建、改、作废按 boms 业务资源的动作显隐。 */
export function BomsPage(): ReactElement {
  const { t } = useTranslation();
  const { locale } = useLocale();
  const api = useApiClient();
  const toaster = useToaster();
  const location = useLocation();
  const client = useMemo(() => new BomsClient(api), [api]);
  const view = useCan({ resource: BOMS_RESOURCE, action: 'view' });
  const create = useCan({ resource: BOMS_RESOURCE, action: 'create' });
  const update = useCan({ resource: BOMS_RESOURCE, action: 'update' });
  const voiding = useCan({ resource: BOMS_RESOURCE, action: 'void' });
  const products = useReferencePage<Item>('items?itemType=product', view.can);

  const list = useEntityList<BomSummary>({
    path: 'boms',
    filterKeys: ['productId', 'status'],
    enabled: view.can,
    pending: view.isPending,
  });
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [voidTarget, setVoidTarget] = useState<BomSummary>();
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string>();

  const runVoid = async (doc: BomSummary): Promise<void> => {
    setBusy(true);
    setActionError(undefined);
    try {
      await client.void(doc.id);
      toaster.show({
        type: 'success',
        title: t('boms.toasts.voided', { name: doc.docNo }),
      });
      setVoidTarget(undefined);
      list.reload();
    } catch (cause) {
      setVoidTarget(undefined);
      setActionError(errorText(cause, t));
    } finally {
      setBusy(false);
    }
  };

  const columns = useMemo<ColumnDef<BomSummary>[]>(() => {
    const actions: ColumnDef<BomSummary> = {
      id: 'actions',
      header: () => <span className='sr-only'>{t('erp.fields.actions')}</span>,
      cell: ({ row }: CellContext<BomSummary, unknown>) => {
        const doc = row.original;
        return (
          <RowActions
            label={t('boms.actionsFor', { name: doc.docNo })}
            actions={[
              update.can && {
                key: 'edit',
                label: t('boms.actions.edit'),
                render: (
                  <Link
                    to={{
                      pathname: `${detailLink(doc)}/edit`,
                      search: location.search,
                    }}
                  />
                ),
              },
              voiding.can &&
                doc.status === 'active' && {
                  key: 'void',
                  label: t('boms.actions.void'),
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
        header: t('boms.columns.docNo'),
        cell: ({ row }) => (
          <RecordLink
            to={{ pathname: detailLink(row.original), search: location.search }}
          >
            {row.original.docNo}
          </RecordLink>
        ),
      },
      {
        id: 'version',
        header: t('boms.fields.version'),
        cell: ({ row }) => row.original.version,
      },
      {
        id: 'product',
        header: t('boms.fields.product'),
        cell: ({ row }) =>
          `${row.original.product.code} ${row.original.product.name}`,
      },
      {
        id: 'effectiveFrom',
        header: t('boms.fields.effectiveFrom'),
        cell: ({ row }) => row.original.effectiveFrom,
      },
      {
        id: 'effectiveTo',
        header: t('boms.fields.effectiveTo'),
        cell: ({ row }) => row.original.effectiveTo ?? t('boms.fields.longTerm'),
      },
      {
        id: 'dailyOutput',
        header: t('boms.fields.dailyOutput'),
        cell: ({ row }) =>
          row.original.dailyOutput === null
            ? t('boms.fields.none')
            : qtyText(row.original.dailyOutput, locale),
      },
      {
        id: 'status',
        header: t('erp.fields.status'),
        cell: ({ row }) => <BomStatusBadge status={row.original.status} />,
      },
      ...(update.can || voiding.can ? [actions] : []),
    ];
  }, [t, locale, update.can, voiding.can, location.search]);

  const productOptions = useMemo(
    () => itemChoices(products.items ?? [], t('orderDocs.form.inactiveItem')),
    [products.items, t],
  );
  const statusOptions = useMemo(
    () =>
      (['active', 'inactive'] as const).map((status) => ({
        value: status,
        label: t(`boms.status.${status}`),
      })),
    [t],
  );
  const applied = Object.values(list.filters).filter(Boolean).length;
  const skeleton = list.skeleton;
  return (
    <ListPage
      title={t('boms.title')}
      description={t('boms.description')}
      actions={
        create.can ? <NewBomLink label={t('boms.actions.new')} /> : undefined
      }
    >
      <DataTable<BomSummary>
        columns={
          skeleton
            ? skeletonColumns(
                columns,
                (row) => t('erp.list.loadingRow', { row }),
                update.can || voiding.can,
              )
            : columns
        }
        data={skeleton ? skeletonRows<BomSummary>(SKELETON_ROW_COUNT) : list.rows}
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
        emptyMessage={t('boms.empty')}
        emptyAction={
          create.can ? <NewBomLink label={t('boms.actions.new')} /> : undefined
        }
        getColumnLabel={(column) => {
          const header = column.columnDef.header;
          return typeof header === 'string' ? header : column.id;
        }}
        renderCard={
          skeleton
            ? () => (
                <div className='flex flex-col gap-3 rounded-lg border border-border bg-card p-4'>
                  <Skeleton className='h-5 w-2/5' />
                  <Skeleton className='h-4 w-3/5' />
                  <Skeleton className='h-4 w-1/3' />
                </div>
              )
            : (row, card) => (
                <article className='flex flex-col gap-2 rounded-lg border border-border bg-card p-4 text-sm'>
                  <div className='flex items-start justify-between gap-2'>
                    <RecordLink
                      to={{
                        pathname: detailLink(row.original),
                        search: location.search,
                      }}
                    >
                      {row.original.docNo}
                    </RecordLink>
                    {card.actions}
                  </div>
                  <p className='text-muted-foreground'>
                    {row.original.product.code} {row.original.product.name}
                  </p>
                  <div className='flex flex-wrap items-center gap-2'>
                    <BomStatusBadge status={row.original.status} />
                    <span className='text-muted-foreground tabular-nums'>
                      {t('boms.fields.version')} {row.original.version} ·{' '}
                      {row.original.effectiveFrom}
                    </span>
                  </div>
                </article>
              )
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
                label={t('boms.filters.product')}
                value={list.filters.productId ?? ''}
                options={productOptions}
                onChange={(value) => list.setFilter('productId', value)}
              />
              <SelectFilter
                label={t('boms.filters.status')}
                value={list.filters.status ?? ''}
                options={statusOptions}
                onChange={(value) => list.setFilter('status', value)}
              />
            </FilterRow>
          ) : undefined
        }
        summary={<ResultCount count={list.total} />}
      />
      <ConfirmDialog
        open={voidTarget !== undefined}
        title={t('boms.voidTitle', { name: voidTarget?.docNo ?? '' })}
        description={t('boms.voidDescription')}
        confirmLabel={t('boms.actions.void')}
        error={actionError ? <span role='alert'>{actionError}</span> : undefined}
        busy={busy}
        onCancel={() => setVoidTarget(undefined)}
        onConfirm={() => {
          if (voidTarget) void runVoid(voidTarget);
        }}
      />
      <Outlet />
    </ListPage>
  );
}

export default BomsPage;
