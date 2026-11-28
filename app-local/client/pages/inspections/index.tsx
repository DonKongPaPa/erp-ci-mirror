import { useApiClient, useToaster } from '@nocobase/app-client';
import { useCan } from '@nocobase/app-plugin-authorization/client';
import { useTranslation } from '@nocobase/i18n/client';
import type { CellContext, ColumnDef } from '@tanstack/react-table';
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
} from 'react';
import { PlusIcon } from 'lucide-react';
import { Link, Outlet, useLocation } from 'react-router';

import { DataTable } from '#components/data-table';
import { ConfirmDialog } from '#components/erp/confirm';
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
import { errorText } from '#components/erp/messages';
import { RecordLink } from '#components/record-link';
import { RowActions } from '#components/row-actions';
import { Button } from '#components/ui/button';
import { Skeleton } from '#components/ui/skeleton';

import { DateFilter } from '../orders/fields.js';
import type { Choice } from '../orders/reference.js';
import { InspectionsClient, type InspectionSummary } from './client.js';
import { Dash, InspectionStatusBadge } from './fields.js';
import {
  INSPECTIONS_LIST_KEYS,
  INSPECTIONS_RESOURCE,
} from './page-id.js';

const STATUSES = ['pending', 'passed', 'partial', 'failed', 'void'] as const;

/** 列表页的主操作：常规高度、左侧图标、可见焦点；地址栏的筛选条件照旧带到新建页。 */
function NewInspectionLink({
  to,
  label,
}: {
  readonly to: string;
  readonly label: string;
}): ReactElement {
  return (
    <Button
      nativeButton={false}
      render={<Link to={to} />}
      className='focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring'
    >
      <PlusIcon data-icon='inline-start' aria-hidden='true' />
      {label}
    </Button>
  );
}

/**
 * 来料检验单列表：筛选项只取端点支持的（状态、日期、采购订单、供应商、关键字），
 * 按会话持有的动作决定行操作，不按角色名猜；采购只有 view，看不到写入口。
 */
export default function InspectionsPage(): ReactElement {
  const { t } = useTranslation();
  const api = useApiClient();
  const toaster = useToaster();
  const location = useLocation();
  const client = useMemo(() => new InspectionsClient(api), [api]);
  const view = useCan({ resource: INSPECTIONS_RESOURCE, action: 'view' });
  const create = useCan({ resource: INSPECTIONS_RESOURCE, action: 'create' });
  const update = useCan({ resource: INSPECTIONS_RESOURCE, action: 'update' });
  const complete = useCan({ resource: INSPECTIONS_RESOURCE, action: 'complete' });
  const voiding = useCan({ resource: INSPECTIONS_RESOURCE, action: 'void' });
  const list = useEntityList<InspectionSummary>({
    path: 'inspections',
    filterKeys: ['status', 'purchaseOrderId', 'supplierId', 'from', 'to'],
    enabled: view.can,
    pending: view.isPending,
  });
  const [orders, setOrders] = useState<readonly {
    id: string; orderNo: string; supplier: { id: string; name: string } | null;
  }[]>([]);
  useEffect(() => {
    if (!view.can) return;
    const controller = new AbortController();
    client
      .orderOptions({ page: 1, pageSize: 100 })
      .then((page) => {
        if (!controller.signal.aborted) setOrders(page.items);
      })
      .catch(() => {
        if (!controller.signal.aborted) setOrders([]);
      });
    return () => controller.abort();
  }, [client, view.can]);

  const writable = update.can || complete.can || voiding.can;
  const applied = [
    list.filters.status,
    list.filters.purchaseOrderId,
    list.filters.supplierId,
    list.filters.from,
    list.filters.to,
  ].filter(Boolean).length;
  const [expanded, setExpanded] = useState(false);
  const filtersOpen = expanded || applied > 0;
  const [busyId, setBusyId] = useState<string>();
  const [voidRow, setVoidRow] = useState<InspectionSummary>();
  const [actionError, setActionError] = useState<string>();

  const act = async (kind: 'complete' | 'void', row: InspectionSummary): Promise<void> => {
    setBusyId(row.id);
    setActionError(undefined);
    try {
      await client[kind](row.id);
      toaster.show({
        type: 'success',
        title: t(`inspections.toasts.${kind === 'void' ? 'voided' : 'completed'}`, {
          name: row.docNo,
        }),
      });
      list.reload();
    } catch (next) {
      setActionError(errorText(next, t));
      list.reload();
    } finally {
      setBusyId(undefined);
      setVoidRow(undefined);
    }
  };
  const actRef = useRef(act);
  useEffect(() => {
    actRef.current = act;
  });

  const columns = useMemo<ColumnDef<InspectionSummary>[]>(() => {
    const search = location.search;
    const base = (row: InspectionSummary) =>
      `/inspections/${encodeURIComponent(row.id)}`;
    const to = (row: InspectionSummary, segment?: string) => ({
      pathname: segment ? `${base(row)}/${segment}` : base(row),
      search,
    });
    const actions: ColumnDef<InspectionSummary> = {
      id: 'actions',
      header: () => <span className='sr-only'>{t('erp.fields.actions')}</span>,
      cell: ({ row }: CellContext<InspectionSummary, unknown>) => {
        const one = row.original;
        return (
          <RowActions
            label={t('inspections.actionsFor', { name: one.docNo })}
            actions={[
              one.status === 'pending' && update.can
                ? {
                    key: 'edit',
                    label: t('inspections.actions.edit'),
                    render: <Link to={to(one, 'edit')} />,
                  }
                : null,
              one.status === 'pending' && complete.can
                ? {
                    key: 'complete',
                    label: t('inspections.actions.complete'),
                    disabled: busyId === one.id,
                    onClick: () => void actRef.current('complete', one),
                  }
                : null,
              one.status === 'pending' && voiding.can
                ? {
                    key: 'void',
                    label: t('inspections.actions.void'),
                    destructive: true,
                    disabled: busyId === one.id,
                    onClick: () => setVoidRow(one),
                  }
                : null,
            ]}
          />
        );
      },
    };
    return [
      {
        id: 'docNo',
        header: t('inspections.fields.docNo'),
        cell: ({ row }) => (
          <RecordLink to={to(row.original)}>{row.original.docNo}</RecordLink>
        ),
      },
      {
        id: 'inspectionDate',
        header: t('inspections.fields.inspectionDate'),
        cell: ({ row }) => (
          <span className='tabular-nums'>{row.original.inspectionDate}</span>
        ),
      },
      {
        id: 'purchaseOrder',
        header: t('inspections.fields.purchaseOrder'),
        cell: ({ row }) => row.original.purchaseOrder.orderNo || <Dash />,
      },
      {
        id: 'supplier',
        header: t('inspections.fields.supplier'),
        cell: ({ row }) => row.original.supplier?.name ?? <Dash />,
      },
      {
        id: 'inspector',
        header: t('inspections.fields.inspector'),
        cell: ({ row }) => row.original.inspector?.name ?? <Dash />,
      },
      {
        id: 'status',
        header: t('erp.fields.status'),
        cell: ({ row }) => <InspectionStatusBadge status={row.original.status} />,
      },
      ...(writable ? [actions] : []),
    ];
  }, [
    t,
    location.search,
    update.can,
    complete.can,
    voiding.can,
    writable,
    busyId,
  ]);

  const orderChoices: Choice[] = orders.map((order) => ({
    value: order.id,
    label: order.orderNo,
  }));
  const supplierMap = new Map<string, string>();
  for (const order of orders) {
    if (order.supplier) supplierMap.set(order.supplier.id, order.supplier.name);
  }
  const supplierChoices: Choice[] = [...supplierMap].map(([value, label]) => ({
    value, label,
  }));

  const skeleton = list.skeleton;
  return (
    <ListPage
      title={t('inspections.title')}
      description={t('inspections.description')}
      actions={
        create.can ? (
          <NewInspectionLink
            to={`/inspections/new${location.search}`}
            label={t('inspections.actions.new')}
          />
        ) : undefined
      }
    >
      <DataTable<InspectionSummary>
        columns={
          skeleton
            ? skeletonColumns(columns, (row) => t('erp.list.loadingRow', { row }), writable)
            : columns
        }
        data={skeleton ? skeletonRows<InspectionSummary>(SKELETON_ROW_COUNT) : list.rows}
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
        emptyMessage={t('inspections.empty')}
        emptyAction={
          create.can ? (
            <NewInspectionLink
              to={`/inspections/new${location.search}`}
              label={t('inspections.actions.new')}
            />
          ) : undefined
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
                        pathname: `/inspections/${encodeURIComponent(row.original.id)}`,
                        search: location.search,
                      }}
                    >
                      {row.original.docNo}
                    </RecordLink>
                    {card.actions}
                  </div>
                  <p className='text-muted-foreground'>
                    {row.original.purchaseOrder.orderNo || <Dash />}
                    {row.original.supplier
                      ? ` · ${row.original.supplier.name}`
                      : ''}
                  </p>
                  <div className='flex flex-wrap items-center gap-2'>
                    <InspectionStatusBadge status={row.original.status} />
                    <span className='text-muted-foreground tabular-nums'>
                      {row.original.inspectionDate}
                    </span>
                  </div>
                </article>
              )
        }
        search={
          <ListSearch
            value={list.q}
            onSearch={list.setSearch}
            label={t('inspections.search')}
          />
        }
        toolbar={() => (
          <>
            <FilterToggle
              expanded={filtersOpen}
              applied={applied}
              onClick={() => setExpanded(!filtersOpen)}
            />
            <ResultCount count={list.total} />
          </>
        )}
        filterPanel={
          filtersOpen ? (
            <FilterRow>
              <SelectFilter
                label={t('inspections.filters.status')}
                value={list.filters.status ?? ''}
                options={STATUSES.map((status) => ({
                  value: status,
                  label: t(`inspections.status.${status}`),
                }))}
                onChange={(value) => list.setFilter('status', value)}
              />
              <SelectFilter
                label={t('inspections.filters.purchaseOrder')}
                value={list.filters.purchaseOrderId ?? ''}
                options={orderChoices}
                onChange={(value) => list.setFilter('purchaseOrderId', value)}
              />
              <SelectFilter
                label={t('inspections.filters.supplier')}
                value={list.filters.supplierId ?? ''}
                options={supplierChoices}
                onChange={(value) => list.setFilter('supplierId', value)}
              />
              <DateFilter
                label={t('inspections.filters.from')}
                value={list.filters.from ?? ''}
                onChange={(iso) => list.setFilter('from', iso)}
              />
              <DateFilter
                label={t('inspections.filters.to')}
                value={list.filters.to ?? ''}
                end
                onChange={(iso) => list.setFilter('to', iso)}
              />
            </FilterRow>
          ) : undefined
        }
      />
      {actionError ? (
        <p role='alert' className='text-sm text-destructive'>
          {actionError}
        </p>
      ) : null}
      <ConfirmDialog
        open={voidRow !== undefined}
        title={t('inspections.voidTitle', { name: voidRow?.docNo ?? '' })}
        description={t('inspections.voidDescription')}
        confirmLabel={t('inspections.actions.void')}
        error={actionError ? <span role='alert'>{actionError}</span> : undefined}
        busy={busyId !== undefined}
        onCancel={() => setVoidRow(undefined)}
        onConfirm={() => {
          if (voidRow) void act('void', voidRow);
        }}
      />
      <Outlet />
    </ListPage>
  );
}

/** 搜索、筛选、页码从详情回到列表时原样带回。 */
export { INSPECTIONS_LIST_KEYS };
