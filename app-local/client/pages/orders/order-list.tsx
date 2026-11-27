import { useApiClient, useToaster } from '@nocobase/app-client';
import { useCan } from '@nocobase/app-plugin-authorization/client';
import { useTranslation } from '@nocobase/i18n/client';
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
import { RecordLink } from '#components/record-link';
import { RowActions } from '#components/row-actions';

import {
  OrdersClient,
  toOrder,
  type Order,
  type OrderResponse,
} from './client.js';
import { Dash, DateFilter, OrderStatusBadge } from './fields.js';
import type { OrderKindDef } from './kinds.js';
import { useReferencePage, type PartnerOption } from './reference.js';

/**
 * 采购订单、销售订单的列表（《基座ERP前端设计》2.1、3.4、3.5）：一个搜索框搜单号、备注、往来单位名称，
 * 点「筛选」展开状态、往来单位、创建时间。单据列表默认是全部状态。
 * 端点的列表行不带明细与往来单位（设计第六节第 4 条），所以只画单号、单据日期、状态、备注。
 */
export function OrderListPage({
  def,
}: {
  readonly def: OrderKindDef;
}): ReactElement {
  const { t } = useTranslation();
  const api = useApiClient();
  const toaster = useToaster();
  const location = useLocation();
  const client = useMemo(() => new OrdersClient(api, def), [api, def]);
  const partnerKey = def.id === 'purchase' ? 'supplierId' : 'customerId';
  const view = useCan({ resource: def.resource, action: 'view' });
  const create = useCan({ resource: def.resource, action: 'create' });
  const update = useCan({ resource: def.resource, action: 'update' });
  const cancel = useCan({ resource: def.resource, action: 'cancel' });
  const make = useCan({ resource: def.resource, action: def.makeAction });
  const partnerView = useCan({
    resource: def.partnerResource,
    action: 'view',
  });
  // 没有任何写权限的人整列操作都不画（设计 2.7）。
  const writable = update.can || cancel.can || make.can;

  // 端点回的是原始订单；列表行和详情一样过 toOrder，状态徽标才认得 received / shipped。
  const list = useEntityList<OrderResponse>({
    path: def.api,
    filterKeys: [partnerKey, 'status', 'from', 'to'],
    enabled: view.can,
    pending: view.isPending,
  });
  const rows = useMemo(
    () => list.rows.map((raw) => toOrder(def, raw)),
    [list.rows, def],
  );
  const partners = useReferencePage<PartnerOption>(
    `partners?kind=${def.partnerKind}&status=active`,
    partnerView.can,
  );
  const [expanded, setExpanded] = useState(false);
  const applied = [
    list.filters.status,
    list.filters[partnerKey],
    list.filters.from,
    list.filters.to,
  ].filter(Boolean).length;
  // 默认收起；有筛选生效时点「筛选」也不收起，当前值一直看得见（T1.2）。
  const showFilters = expanded || applied > 0;
  const [cancelling, setCancelling] = useState<Order>();
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string>();

  /** 行上的取消订单。先过下面的确认框；被拒时（例如已经生成过入库单）把服务端那句话写在框里。 */
  const cancelOrder = async (order: Order): Promise<void> => {
    setBusy(true);
    setActionError(undefined);
    try {
      await client.cancel(order.id);
      toaster.show({
        type: 'success',
        title: t(`${def.l}.cancelledToast`, { name: order.orderNo }),
      });
      setCancelling(undefined);
      list.reload();
    } catch (next) {
      setActionError(errorText(next, t));
      // 这一行可能已经不是加载时的状态：重新取一次。
      list.reload();
    } finally {
      setBusy(false);
    }
  };
  // 行上的操作调用最新的一份 cancelOrder；列定义保持是同一个引用，重新取数时不会重装操作格。
  const cancelRef = useRef(cancelOrder);
  useEffect(() => {
    cancelRef.current = cancelOrder;
  });

  const columns = useMemo<ColumnDef<Order>[]>(() => {
    // 链接带着列表的查询串：从详情、编辑回到列表时搜索、筛选、页码都在。
    const search = location.search;
    const base = (order: Order) =>
      `${def.path}/${encodeURIComponent(order.id)}`;
    const to = (order: Order, ...segments: string[]) => ({
      pathname: [base(order), ...segments].join('/'),
      search,
    });
    const actions: ColumnDef<Order> = {
      id: 'actions',
      header: () => <span className='sr-only'>{t('erp.fields.actions')}</span>,
      cell: ({ row }: CellContext<Order, unknown>) => {
        const order = row.original;
        return (
          <RowActions
            label={t('erp.fields.actionsFor', { name: order.orderNo })}
            actions={[
              order.status === 'draft' && update.can
                ? {
                    key: 'edit',
                    label: t('erp.actions.edit'),
                    render: <Link to={to(order, 'edit')} />,
                  }
                : null,
              (order.status === 'ordered' || order.status === 'partial') &&
              make.can
                ? {
                    key: 'make',
                    label: t(`${def.l}.actions.make`),
                    render: <Link to={to(order, def.makeSegment)} />,
                  }
                : null,
              (order.status === 'draft' || order.status === 'ordered') &&
              cancel.can
                ? {
                    key: 'cancel',
                    label: t('orderDocs.actions.cancelOrder'),
                    destructive: true,
                    onClick: () => setCancelling(order),
                  }
                : null,
            ]}
          />
        );
      },
    };
    return [
      {
        id: 'orderNo',
        header: t('orderDocs.fields.orderNo'),
        // 首列点开这一张单的子页，列表还在下面。
        cell: ({ row }) => (
          <RecordLink to={to(row.original)}>{row.original.orderNo}</RecordLink>
        ),
      },
      {
        id: 'orderDate',
        header: t('orderDocs.fields.orderDate'),
        cell: ({ row }) => (
          <span className='tabular-nums'>{row.original.orderDate}</span>
        ),
      },
      {
        id: 'latestDeliveryDate',
        header: t('orderDocs.fields.latestDeliveryDate'),
        cell: ({ row }) => row.original.latestDeliveryDate ?? <Dash />,
      },
      {
        id: 'project',
        header: t('orderDocs.fields.project'),
        cell: ({ row }) => row.original.projectLabel ?? row.original.projectCode ?? <Dash />,
      },
      {
        id: 'status',
        header: t('erp.fields.status'),
        cell: ({ row }) => <OrderStatusBadge def={def} order={row.original} />,
      },
      {
        id: 'remark',
        header: t('erp.fields.note'),
        cell: ({ row }) => row.original.remark || <Dash />,
      },
      ...(writable ? [actions] : []),
    ];
  }, [
    t,
    def,
    location.search,
    update.can,
    cancel.can,
    make.can,
    writable,
    setCancelling,
  ]);

  const skeleton = list.skeleton;
  return (
    <ListPage
      title={t(`${def.l}.title`)}
      description={t(`${def.l}.description`)}
      actions={
        create.can ? (
          <NewButton
            to={`${def.path}/new${location.search}`}
            label={t(`${def.l}.newTitle`)}
          />
        ) : undefined
      }
    >
      <DataTable<Order>
        columns={
          skeleton
            ? skeletonColumns(
                columns,
                (row) => t('erp.list.loadingRow', { row }),
                writable,
              )
            : columns
        }
        data={skeleton ? skeletonRows<Order>(SKELETON_ROW_COUNT) : rows}
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
        emptyMessage={t(`${def.l}.empty`)}
        search={
          <ListSearch
            value={list.q}
            onSearch={list.setSearch}
            label={t(`${def.l}.searchLabel`)}
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
                label={t('orderDocs.filters.status')}
                value={list.filters.status ?? ''}
                options={def.statuses.map((status) => ({
                  value: status.api,
                  label: t(`${def.l}.status.${status.value}`),
                }))}
                onChange={(value) => list.setFilter('status', value)}
              />
              {partnerView.can ? (
                <SelectFilter
                  label={t(`${def.l}.partnerLabel`)}
                  value={list.filters[partnerKey] ?? ''}
                  options={(partners.items ?? []).map((partner) => ({
                    value: partner.id,
                    label: partner.name,
                  }))}
                  onChange={(value) => list.setFilter(partnerKey, value)}
                />
              ) : null}
              <DateRangeFilters
                from={list.filters.from ?? ''}
                to={list.filters.to ?? ''}
                onFrom={(iso) => list.setFilter('from', iso)}
                onTo={(iso) => list.setFilter('to', iso)}
              />
            </FilterRow>
          ) : undefined
        }
      />
      <ConfirmDialog
        open={cancelling !== undefined}
        title={t(`${def.l}.cancelTitle`, {
          name: cancelling?.orderNo ?? '',
        })}
        description={t(`${def.l}.cancelDescription`)}
        confirmLabel={t('orderDocs.actions.cancelOrder')}
        error={
          actionError ? <span role='alert'>{actionError}</span> : undefined
        }
        busy={busy}
        onCancel={() => setCancelling(undefined)}
        onConfirm={() => {
          if (cancelling) void cancelRef.current(cancelling);
        }}
      />
      {/* 新建与详情的子页、生成出入库单的对话框从这里出来。 */}
      <Outlet />
    </ListPage>
  );
}

function DateRangeFilters({
  from,
  to,
  onFrom,
  onTo,
}: {
  readonly from: string;
  readonly to: string;
  readonly onFrom: (iso: string) => void;
  readonly onTo: (iso: string) => void;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <>
      <DateFilter
        label={t('orderDocs.filters.createdFrom')}
        value={from}
        onChange={onFrom}
      />
      <DateFilter
        label={t('orderDocs.filters.createdTo')}
        value={to}
        end
        onChange={onTo}
      />
    </>
  );
}
