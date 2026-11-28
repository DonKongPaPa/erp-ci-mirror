import { useApiClient, useToaster } from '@nocobase/app-client';
import { useCan } from '@nocobase/app-plugin-authorization/client';
import { useTranslation } from '@nocobase/i18n/client';
import type { CellContext, ColumnDef } from '@tanstack/react-table';
import { useMemo, useRef, useState, useEffect, type ReactElement } from 'react';
import { Link, Outlet, useLocation, useNavigate } from 'react-router';

import { DataTable } from '#components/data-table';
import { ConfirmDialog } from '#components/erp/confirm';
import {
  departmentChoices,
  useDepartmentOptions,
} from '#components/erp/options';
import {
  FilterRow,
  FilterToggle,
  ListPage,
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

import { DateFilter } from '../orders/fields.js';
import { PurchaseRequestsClient, type RequestSummary } from './client.js';
import { Dash, RequestStatusBadge } from './fields.js';
import {
  PURCHASE_REQUESTS_LIST_KEYS,
  PURCHASE_REQUESTS_RESOURCE,
} from './page-id.js';

/**
 * 请购单列表：筛选项只取端点支持的四样（状态、请购部门、日期区间），
 * 端点没有关键字参数，所以不画搜索框。按会话持有的动作决定行操作，不按角色名猜。
 */
export default function PurchaseRequestsPage(): ReactElement {
  const { t } = useTranslation();
  const api = useApiClient();
  const toaster = useToaster();
  const location = useLocation();
  const navigate = useNavigate();
  const client = useMemo(() => new PurchaseRequestsClient(api), [api]);
  const view = useCan({ resource: PURCHASE_REQUESTS_RESOURCE, action: 'view' });
  const create = useCan({ resource: PURCHASE_REQUESTS_RESOURCE, action: 'create' });
  const update = useCan({ resource: PURCHASE_REQUESTS_RESOURCE, action: 'update' });
  const submit = useCan({ resource: PURCHASE_REQUESTS_RESOURCE, action: 'submit' });
  const voiding = useCan({ resource: PURCHASE_REQUESTS_RESOURCE, action: 'void' });
  const convert = useCan({ resource: PURCHASE_REQUESTS_RESOURCE, action: 'convert' });
  const bizOptions = useCan({
    resource: { type: 'composite', id: 'bizOptions' },
    action: 'view',
  });
  const departments = useDepartmentOptions(bizOptions.can);
  // 端点没有 q：searchable=false，地址栏与请求里都不会出现关键字参数。
  const list = useEntityList<RequestSummary>({
    path: 'purchase-requests',
    filterKeys: ['status', 'departmentId', 'from', 'to'],
    searchable: false,
    enabled: view.can,
    pending: view.isPending,
  });
  const writable =
    update.can || submit.can || voiding.can || convert.can;
  const applied = [
    list.filters.status,
    list.filters.departmentId,
    list.filters.from,
    list.filters.to,
  ].filter(Boolean).length;
  const [expanded, setExpanded] = useState(false);
  const filtersOpen = expanded || applied > 0;
  const [busyId, setBusyId] = useState<string>();
  const [voidRow, setVoidRow] = useState<RequestSummary>();
  const [actionError, setActionError] = useState<string>();

  const act = async (
    kind: 'submit' | 'void' | 'convert',
    row: RequestSummary,
  ): Promise<void> => {
    setBusyId(row.id);
    setActionError(undefined);
    try {
      if (kind === 'convert') {
        const result = await client.createOrder(row.id);
        toaster.show({
          type: 'success',
          title: t('purchaseRequests.toasts.converted', {
            name: row.docNo,
          }),
        });
        await navigate(`/purchase-orders/${result.purchaseOrderId}`);
        return;
      }
      await client[kind](row.id);
      toaster.show({
        type: 'success',
        title: t(`purchaseRequests.toasts.${kind === 'void' ? 'voided' : 'submitted'}`, {
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

  const columns = useMemo<ColumnDef<RequestSummary>[]>(() => {
    const search = location.search;
    const base = (row: RequestSummary) =>
      `/purchase-requests/${encodeURIComponent(row.id)}`;
    const to = (row: RequestSummary, segment?: string) => ({
      pathname: segment ? `${base(row)}/${segment}` : base(row),
      search,
    });
    const editable = (row: RequestSummary) =>
      row.status === 'draft' || row.status === 'rejected';
    const actions: ColumnDef<RequestSummary> = {
      id: 'actions',
      header: () => <span className='sr-only'>{t('erp.fields.actions')}</span>,
      cell: ({ row }: CellContext<RequestSummary, unknown>) => {
        const one = row.original;
        return (
          <RowActions
            label={t('erp.fields.actionsFor', { name: one.docNo })}
            actions={[
              editable(one) && update.can
                ? {
                    key: 'edit',
                    label: t('purchaseRequests.actions.edit'),
                    render: <Link to={to(one, 'edit')} />,
                  }
                : null,
              editable(one) && submit.can
                ? {
                    key: 'submit',
                    label: t('purchaseRequests.actions.submit'),
                    disabled: busyId === one.id,
                    onClick: () => void actRef.current('submit', one),
                  }
                : null,
              editable(one) && voiding.can
                ? {
                    key: 'void',
                    label: t('purchaseRequests.actions.void'),
                    destructive: true,
                    disabled: busyId === one.id,
                    onClick: () => setVoidRow(one),
                  }
                : null,
              one.status === 'approved' && convert.can
                ? {
                    key: 'convert',
                    label: t('purchaseRequests.actions.convert'),
                    disabled: busyId === one.id,
                    onClick: () => void actRef.current('convert', one),
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
        header: t('purchaseRequests.fields.docNo'),
        cell: ({ row }) => (
          <RecordLink to={to(row.original)}>{row.original.docNo}</RecordLink>
        ),
      },
      {
        id: 'requestDate',
        header: t('purchaseRequests.fields.requestDate'),
        cell: ({ row }) => (
          <span className='tabular-nums'>{row.original.requestDate}</span>
        ),
      },
      {
        id: 'department',
        header: t('purchaseRequests.fields.department'),
        cell: ({ row }) => row.original.department.name || <Dash />,
      },
      {
        id: 'requester',
        header: t('purchaseRequests.fields.requester'),
        cell: ({ row }) => row.original.requester.name || <Dash />,
      },
      {
        id: 'projectLabel',
        header: t('purchaseRequests.fields.project'),
        cell: ({ row }) =>
          row.original.projectLabel ?? row.original.projectCode ?? <Dash />,
      },
      {
        id: 'status',
        header: t('erp.fields.status'),
        cell: ({ row }) => <RequestStatusBadge status={row.original.status} />,
      },
      ...(writable ? [actions] : []),
    ];
  }, [
    t,
    location.search,
    update.can,
    submit.can,
    voiding.can,
    convert.can,
    writable,
    busyId,
  ]);

  const skeleton = list.skeleton;
  return (
    <ListPage
      title={t('purchaseRequests.title')}
      description={t('purchaseRequests.description')}
      actions={
        create.can ? (
          <NewButton
            to={`/purchase-requests/new${location.search}`}
            label={t('purchaseRequests.actions.new')}
          />
        ) : undefined
      }
    >
      <DataTable<RequestSummary>
        columns={
          skeleton
            ? skeletonColumns(columns, (row) => t('erp.list.loadingRow', { row }), writable)
            : columns
        }
        data={skeleton ? skeletonRows<RequestSummary>(SKELETON_ROW_COUNT) : list.rows}
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
        emptyMessage={t('purchaseRequests.empty')}
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
                label={t('purchaseRequests.filters.status')}
                value={list.filters.status ?? ''}
                options={[
                  'draft',
                  'approving',
                  'approved',
                  'rejected',
                  'void',
                  'converted',
                ].map((status) => ({
                  value: status,
                  label: t(`purchaseRequests.status.${status}`),
                }))}
                onChange={(value) => list.setFilter('status', value)}
              />
              {bizOptions.can ? (
                <SelectFilter
                  label={t('purchaseRequests.filters.department')}
                  value={list.filters.departmentId ?? ''}
                  options={departmentChoices(departments.items)}
                  onChange={(value) => list.setFilter('departmentId', value)}
                />
              ) : null}
              <DateFilter
                label={t('purchaseRequests.filters.from')}
                value={list.filters.from ?? ''}
                onChange={(iso) => list.setFilter('from', iso)}
              />
              <DateFilter
                label={t('purchaseRequests.filters.to')}
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
        title={t('purchaseRequests.voidTitle', { name: voidRow?.docNo ?? '' })}
        description={t('purchaseRequests.voidDescription')}
        confirmLabel={t('purchaseRequests.actions.void')}
        error={
          actionError ? <span role='alert'>{actionError}</span> : undefined
        }
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
export { PURCHASE_REQUESTS_LIST_KEYS };
